// เรคคอร์ดสรุป 🔥/🪙 สำหรับแผนที่อาณาจักร (kind = 'kingdom_summary')
//
// เก็บที่ collection `profile` id KINGDOM_SUMMARY_ID (…0004) แถวเดียว ซิงก์ขึ้น Supabase เหมือนข้อมูลอื่น
// แผนที่อาณาจักรอ่านแถวนี้แถวเดียว ไม่ต้องรู้เรื่อง log/สูตรเกม
//
// หลักการ:
//  - ไม่คำนวณสูตรใหม่: ค่าทุกตัวมาจาก computeGame (game.js) และ dailyIntake (analytics.js)
//  - เขียนเฉพาะเมื่อค่าเปลี่ยน (เทียบทุกฟิลด์ยกเว้น computed_at) ไม่งั้นการเขียนจะเข้าคิว dirty → ซิงก์ → เขียนอีก วนไม่รู้จบ
//  - ไม่มีข้อมูลอ่อนไหว: ไม่มีน้ำหนักตัว ชื่ออาหาร โน้ต มีแค่ตัวเลขสรุปของเกมและแคล/โปรตีนของวันนี้
//  - ไม่ใช่โปรไฟล์: ห้ามอ่านตาราง profile แบบทั้งตาราง (ทุกที่อ่านด้วย id) · ไฟล์นี้ไม่แตะ IndexedDB/DOM ทดสอบใน Node ได้
//
// ฟิลด์ (ครบทุกตัวเสมอ):
//   id, kind, balance (🪙), streak { daily (🔥 ตามที่การ์ดเกมแสดง), weekly }, multiplier, freezes,
//   week { sessions, target }, today { date, kcal, kcal_target, protein, protein_min, kcal_missing }, computed_at

import { KINGDOM_SUMMARY_ID } from './constants.js';
import { computeGame } from './game.js';
import { dailyIntake } from './analytics.js';

export const SUMMARY_KIND = 'kingdom_summary';

// ฟิลด์เนื้อหาที่ใช้เทียบว่า "ค่าเปลี่ยน" (ไม่รวม id/computed_at/ฟิลด์ระบบ created_at/updated_at/deleted)
const CONTENT_KEYS = ['kind', 'balance', 'streak', 'multiplier', 'freezes', 'week', 'today'];

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const posOrNull = (v) => (Number(v) > 0 ? Number(v) : null);

/**
 * สร้างเรคคอร์ดสรุปจากผลของ computeGame
 * input: { game (ผล computeGame ของวันนี้), profile, foodLogs (ใช้อ่านแคล/โปรตีนวันนี้ผ่าน dailyIntake), now (ISO) }
 */
export function buildKingdomSummary({ game, profile, foodLogs, now }) {
  const date = game.asOf;
  const day = dailyIntake(foodLogs)[date];
  return {
    id: KINGDOM_SUMMARY_ID,
    kind: SUMMARY_KIND,
    balance: game.balance,
    streak: { daily: game.streak.display, weekly: game.streak.weeks },
    multiplier: game.streak.multiplier,
    freezes: game.freeze.held ? 1 : 0,
    week: { sessions: game.streak.weekCount, target: game.streak.weekTarget },
    today: {
      date,
      kcal: round1(day?.kcal),
      kcal_target: posOrNull(profile?.kcal),
      protein: round1(day?.protein),
      protein_min: posOrNull(profile?.protein_min),
      kcal_missing: game.today?.missingKcalMeals ?? 0,
    },
    computed_at: now,
  };
}

/** แปลงเป็นสตริงที่ไม่ขึ้นกับลำดับคีย์ (jsonb ของเซิร์ฟเวอร์เรียงคีย์ใหม่) */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/** เนื้อหาเหมือนกันทุกฟิลด์ (ยกเว้น computed_at และฟิลด์ระบบ) · ฝั่งไหนว่าง/null = ไม่เหมือน */
export function summaryEqual(a, b) {
  if (!a || !b) return false;
  return CONTENT_KEYS.every((k) => canon(a[k]) === canon(b[k]));
}

/**
 * คำนวณสรุปแล้วเขียนเฉพาะเมื่อค่าเปลี่ยน · คืน true ถ้าเขียน
 *   load()        → { data (ผล db.loadAll), profile, settings }
 *   getCurrent()  → เรคคอร์ดสรุปปัจจุบัน หรือ null (ไม่มี/ถูกลบ)
 *   save(fields)  → เขียน (สร้างหรืออัปเดต)
 *   asOf          → วันนี้ 'YYYY-MM-DD'    now → เวลา ISO
 * ผู้เรียกต้องเรียกเมื่อล็อกอินซิงก์อยู่เท่านั้น (ฟังก์ชันนี้ไม่รู้เรื่องบัญชี)
 */
export async function refreshKingdomSummary({ load, getCurrent, save, asOf, now = new Date().toISOString() }) {
  const { data, profile, settings } = await load();
  const game = computeGame({
    asOf,
    profile,
    settings,
    foodLogs: data.food_logs,
    bodyLogs: data.body_logs,
    sessions: data.sessions,
    sets: data.sets,
    cardio: data.cardio,
    exercises: data.exercises,
    redemptions: data.redemptions,
  });
  const next = buildKingdomSummary({ game, profile, foodLogs: data.food_logs, now });
  const current = await getCurrent();
  if (summaryEqual(current, next)) return false;
  // อีกเครื่องเขียนสรุปของ "วันนี้" ที่ใหม่กว่าไว้แล้ว (ข้ามเที่ยงคืน/คนละไทม์โซน) — ไม่เขียนทับย้อนวัน กันสองเครื่องเขียนสลับกันไม่รู้จบ
  const curDate = current?.today?.date;
  if (curDate && next.today?.date && curDate > next.today.date) return false;
  await save(next);
  return true;
}
