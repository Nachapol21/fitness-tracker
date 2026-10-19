// เกม coin + streak + ร้านแลกรางวัล: ฟังก์ชันล้วน (pure) ไม่แตะ DOM/IndexedDB ทดสอบได้ด้วย node --test
//
// หลักคิด: "coin ที่ได้" ไม่เคยถูกเก็บเป็นรายการ +coin แต่คำนวณจาก log ทุกครั้ง (computeGame)
//   → สองเครื่องที่ซิงก์กันเห็นยอดเท่ากันเสมอ ไม่ได้ coin ซ้ำ และแก้ข้อมูลย้อนหลังแล้วยอดคำนวณใหม่ตามจริง
// สิ่งที่เก็บจริงมีแค่ rewards (รางวัลในร้าน) · redemptions (การแลก/ซื้อไฟสำรอง) · game_settings (ค่าตั้ง)
//   ยอด coin = ledger ที่ได้ − redemptions  (ติดลบได้ถ้าแก้ log ย้อนหลัง แต่ห้ามแลกเพิ่ม)
//
// กติกาสำคัญ (ค่าตัวเลขทั้งหมดอยู่ใน DEFAULT_GAME_SETTINGS แก้ได้):
//  - กิจกรรมที่ created_at (เวลาไทย) ช้ากว่า date เกิน backdate_days หรือถูกสร้างก่อนวันของมัน (จดล่วงหน้า) ไม่ได้ coin แต่ยังนับใน streak/สถิติ
//  - coin นับเฉพาะวันที่ ≥ start_date (ไฟนับจากประวัติทั้งหมดเสมอ)
//  - coin แคลอรี่ของ "วันนี้" ยังไม่นับจนกว่าวันจะจบ (กินเพิ่มแล้วอาจออกนอกช่วง) ส่วนอื่นนับทันที
//  - ตัวคูณของวัน D ใช้ความยาวไฟ ณ สิ้นวัน D−1, ปัดเศษลงต่อรายการ, ไม่คูณโบนัสรายสัปดาห์
//  - วันนี้ไม่มีวัน "พลาด" (ยังไม่จบ) และไฟสำรองไม่ถูกใช้กับวันนี้

import { DEFAULT_GAME_SETTINGS } from './constants.js';
import { addDays, dateRange, diffDays, isDateStr, weekStart, weekday } from './dates.js';
import { buildHistories, isWorkingSet, num } from './analytics.js';
import { toMs } from './lww.js';

const THAI_OFFSET_MS = 7 * 3600 * 1000;

/** เวลา ISO (UTC) → วันที่ตามเวลาไทย (UTC+7) 'YYYY-MM-DD' · อ่านไม่ได้ = null */
export function thaiDay(iso) {
  const ms = toMs(iso);
  if (!ms) return null;
  return new Date(ms + THAI_OFFSET_MS).toISOString().slice(0, 10);
}

export const REASON_LABELS = {
  workout: 'ฝึกครบ 1 ครั้ง',
  cardio: 'คาร์ดิโอถึงเป้า',
  pr: 'ทำสถิติใหม่ (PR)',
  kcal: 'แคลอรี่อยู่ในช่วงเป้า',
  protein: 'โปรตีนถึงขั้นต่ำ',
  steps: 'ก้าวถึงเป้า',
  weigh: 'ชั่งน้ำหนัก',
  week_bonus: '🏆 ฝึกครบตามเป้าในสัปดาห์',
  redeem: 'แลกรางวัล',
  freeze: '🧊 ซื้อไฟสำรอง',
};

// ---------- การตั้งค่า ----------

const FLOAT_KEYS = new Set(['tier1_mult', 'tier2_mult', 'tier3_mult']);
const MIN_ONE = new Set(['week_target', 'tier1_days', 'tier2_days', 'tier3_days', 'freeze_price']);
const NULLABLE = new Set(['kcal_below', 'kcal_above']); // ว่าง = ใช้ค่าจากโปรไฟล์

function validDate(s) {
  if (!isDateStr(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** รวมค่าที่ผู้ใช้ตั้งกับค่าเริ่มต้น ค่าที่เพี้ยน (ไม่ใช่ตัวเลข/ติดลบ) ใช้ค่าเริ่มต้นแทน */
export function normalizeSettings(raw) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_GAME_SETTINGS)) {
    const v = raw ? raw[k] : undefined;
    if (k === 'training_days') {
      const days = Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : null;
      out[k] = days || [...def];
      continue;
    }
    if (k === 'start_date') {
      out[k] = validDate(v) ? v : null;
      continue;
    }
    let n = v === null || v === undefined || v === '' ? NaN : Number(v);
    if (NULLABLE.has(k)) {
      out[k] = Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
      continue;
    }
    if (!Number.isFinite(n) || n < 0) n = def;
    if (!FLOAT_KEYS.has(k)) n = Math.round(n);
    if (FLOAT_KEYS.has(k)) n = Math.max(1, n);
    if (MIN_ONE.has(k)) n = Math.max(1, n);
    out[k] = n;
  }
  return out;
}

/** ตัวคูณ coin ตามความยาวไฟ */
export function tierMultiplier(run, settings) {
  const s = normalizeSettings(settings);
  const tiers = [
    [s.tier1_days, s.tier1_mult],
    [s.tier2_days, s.tier2_mult],
    [s.tier3_days, s.tier3_mult],
  ].sort((a, b) => b[0] - a[0]);
  for (const [days, mult] of tiers) if (run >= days) return mult;
  return 1;
}

/** ขั้นตัวคูณถัดไปที่ยังไม่ถึง: { days, mult, left } หรือ null */
export function nextTier(run, settings) {
  const s = normalizeSettings(settings);
  const tiers = [
    [s.tier1_days, s.tier1_mult],
    [s.tier2_days, s.tier2_mult],
    [s.tier3_days, s.tier3_mult],
  ]
    .filter(([d]) => d > run)
    .sort((a, b) => a[0] - b[0]);
  return tiers.length ? { days: tiers[0][0], mult: tiers[0][1], left: tiers[0][0] - run } : null;
}

// ---------- คำนวณทั้งหมด ----------

const live = (rows) => (rows || []).filter((r) => r && !r.deleted);
const n0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round1 = (n) => Math.round(n * 10) / 10;

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/**
 * คำนวณสถานะเกมทั้งหมดจาก log
 * input: { asOf:'YYYY-MM-DD' (วันนี้), profile, settings, foodLogs, bodyLogs, sessions, sets, cardio, exercises, redemptions }
 * คืน:
 *  ledger   [{date, total, items:[{reason, base, multiplier, coins, ref, detail?}]}] เรียงวันเก่า → ใหม่ (เฉพาะวันที่มีรายการ)
 *  earned / spent / balance
 *  streak   { run (ไฟรายวันที่ยืนยันแล้ว ณ สิ้นวันก่อนหน้า), display (รวมวันนี้ถ้าผ่านแล้ว), runStart, multiplier, nextTier,
 *             weeks (ไฟรายสัปดาห์), weekCount, weekTarget, lastBreak, todayStatus }
 *  freeze   { held, price }   rest {used, cap}   allowed {used, cap}
 *  today    { ..., todo:[{reason, text, coins}] }
 *  days     [{date, status:'pass'|'allowed'|'freeze'|'miss', mult}]  (ไม่รวมวันนี้)
 */
export function computeGame(input) {
  const asOf = input.asOf;
  if (!isDateStr(asOf)) throw new Error('computeGame: asOf ต้องเป็น YYYY-MM-DD');
  const s = normalizeSettings(input.settings);
  const profile = input.profile || {};
  const validDate = (r) => isDateStr(r.date) && r.date <= asOf;

  // เรียงให้แน่นอน (created_at แล้ว id) เพื่อให้สองเครื่องที่ข้อมูลเท่ากันได้ผลเหมือนกันทุกอย่าง แม้ลำดับในที่เก็บต่างกัน
  const stable = (rows) => [...rows].sort((a, b) => ((a.created_at || '') < (b.created_at || '') ? -1 : (a.created_at || '') > (b.created_at || '') ? 1 : String(a.id) < String(b.id) ? -1 : 1));
  const foodLogs = stable(live(input.foodLogs).filter(validDate));
  const bodyLogs = stable(live(input.bodyLogs).filter(validDate));
  const sessions = stable(live(input.sessions).filter(validDate));
  const cardio = stable(live(input.cardio).filter(validDate));
  const redemptions = stable(live(input.redemptions));
  const allSets = stable(input.sets || []);

  // สด = สร้างตั้งแต่วันของมันเองจนถึง backdate_days วันหลังจากนั้น (เวลาไทย) · จดล่วงหน้า (สร้างก่อนวันนั้น) ไม่ได้ coin
  const isFresh = (createdAt, date) => {
    const c = thaiDay(createdAt);
    if (c === null) return false;
    const late = diffDays(date, c);
    return late >= 0 && late <= s.backdate_days;
  };
  const coinDay = (d) => !s.start_date || d >= s.start_date; // coin นับเฉพาะวันที่ถึง start_date

  // ---- การกิน ----
  const aggIntake = (logs) => {
    const m = new Map();
    for (const l of logs) {
      if (!m.has(l.date)) m.set(l.date, { kcal: 0, protein: 0, meals: new Set() });
      const t = m.get(l.date);
      t.kcal += n0(l.kcal);
      t.protein += n0(l.protein);
      t.meals.add(l.meal || '?');
    }
    for (const t of m.values()) t.kcal = round1(t.kcal);
    return m;
  };
  const intakeAll = aggIntake(foodLogs); // ใช้กับไฟ (นับข้อมูลที่แก้ย้อนหลังด้วย)
  const intakeFresh = aggIntake(foodLogs.filter((l) => isFresh(l.created_at, l.date))); // ใช้กับ coin
  const target = n0(profile.kcal) > 0 ? n0(profile.kcal) : null;
  const tol = Math.max(0, num(profile.kcal_tolerance) ?? 100); // ± เดียวกับ analytics.kcalOk (ค่าเริ่มต้น 100)
  const kcalLo = target === null ? null : target - (s.kcal_below ?? tol);
  const kcalHi = target === null ? null : target + (s.kcal_above ?? tol);
  const kcalInRange = (t) => target !== null && !!t && t.meals.size >= s.kcal_min_meals && t.kcal >= kcalLo && t.kcal <= kcalHi;
  const proteinMin = n0(profile.protein_min);
  const stepGoal = n0(profile.step_goal);

  // ---- การฝึก ----
  const workingSets = allSets.filter(isWorkingSet);
  const setsBySession = groupBy(workingSets, (x) => x.session_id);
  const cardioBySession = groupBy(cardio, (c) => c.session_id);
  const qualifies = (arr) => new Set(arr.map((x) => x.exercise_id)).size >= s.workout_min_exercises || arr.length >= s.workout_min_sets;

  const dayWork = new Map(); // date → { loose, qualAll, qualFresh, sessionId, exFresh, setsFresh }
  for (const ses of sessions) {
    const ws = setsBySession.get(ses.id) || [];
    const fresh = ws.filter((x) => isFresh(x.created_at, ses.date));
    if (!dayWork.has(ses.date)) dayWork.set(ses.date, { loose: false, qualAll: false, qualFresh: false, sessionId: null, exFresh: 0, setsFresh: 0 });
    const d = dayWork.get(ses.date);
    if (ws.length > 0 || (cardioBySession.get(ses.id) || []).length > 0) d.loose = true;
    if (qualifies(ws)) d.qualAll = true;
    if (qualifies(fresh) && !d.qualFresh) {
      d.qualFresh = true;
      d.sessionId = ses.id;
    }
    d.exFresh = Math.max(d.exFresh, new Set(fresh.map((x) => x.exercise_id)).size);
    d.setsFresh = Math.max(d.setsFresh, fresh.length);
  }
  const qualDates = (key) => {
    const byWeek = new Map();
    for (const [date, d] of dayWork) {
      if (!d[key]) continue;
      if (key === 'qualFresh' && !coinDay(date)) continue; // โบนัส/coin นับตั้งแต่ start_date
      const ws = weekStart(date);
      if (!byWeek.has(ws)) byWeek.set(ws, []);
      byWeek.get(ws).push(date);
    }
    for (const arr of byWeek.values()) arr.sort();
    return byWeek;
  };
  const qualAllByWeek = qualDates('qualAll');
  const qualFreshByWeek = qualDates('qualFresh');
  const weekBonusByDate = new Map(); // วันที่ฝึกครั้งที่ครบเป้า → weekStart
  for (const [ws, dates] of qualFreshByWeek) if (dates.length >= s.week_target) weekBonusByDate.set(dates[s.week_target - 1], ws);

  // ---- คาร์ดิโอ ----
  const cardioFresh = new Map(); // date → { minutes, id }
  for (const c of cardio) {
    if (!isFresh(c.created_at, c.date)) continue;
    const t = cardioFresh.get(c.date) || { minutes: 0, id: c.id };
    t.minutes += n0(c.minutes);
    cardioFresh.set(c.date, t);
  }

  // ---- PR (นิยามคะแนนเดียวกับ analytics.js: 1RM ประมาณ/จำนวนครั้ง, ต้องเคยเล่นท่านั้นมาก่อน, ดีกว่าเดิมจริง) ----
  // ฐานเทียบ (ประวัติจริง) ใช้ทุกเซ็ต · คะแนนที่ใช้ตัดสินให้ coin ใช้เฉพาะ "เซ็ตที่สด" (เซ็ตที่เติมทีหลังเกิน backdate_days ไม่ทำให้ได้ coin PR)
  const exName = new Map((input.exercises || []).map((e) => [e.id, e.name]));
  const sesDate = new Map(sessions.map((x) => [x.id, x.date]));
  const freshSets = allSets.filter((x) => sesDate.has(x.session_id) && isFresh(x.created_at, sesDate.get(x.session_id)));
  const freshScore = new Map(); // `${exerciseId}|${sessionId}` → คะแนนจากเซ็ตสดอย่างเดียว
  for (const [exId, rows] of buildHistories(input.exercises, sessions, freshSets)) for (const r of rows) freshScore.set(`${exId}|${r.sessionId}`, r.score);
  const prByDate = new Map(); // date → [{exerciseId, sessionId}]
  for (const [exId, rows] of buildHistories(input.exercises, sessions, allSets)) {
    let best = null;
    const seen = new Set();
    for (const r of rows) {
      const fs = freshScore.get(`${exId}|${r.sessionId}`);
      if (best !== null && fs !== undefined && fs > best + 1e-6 && !seen.has(r.date) && r.date <= asOf) {
        seen.add(r.date);
        if (!prByDate.has(r.date)) prByDate.set(r.date, []);
        prByDate.get(r.date).push({ exerciseId: exId, sessionId: r.sessionId });
      }
      best = best === null ? r.score : Math.max(best, r.score);
    }
  }

  // ---- ร่างกาย ----
  const bodyFresh = new Map(); // date → { weighId, steps }
  for (const b of bodyLogs) {
    if (!isFresh(b.created_at, b.date)) continue;
    const t = bodyFresh.get(b.date) || { weighId: null, steps: 0, stepsId: null };
    if (n0(b.weight_kg) > 0 && !t.weighId) t.weighId = b.id;
    if (n0(b.steps) > t.steps) {
      t.steps = n0(b.steps);
      t.stepsId = b.id;
    }
    bodyFresh.set(b.date, t);
  }

  // ---- การแลก ----
  const foodRewardDays = new Set(redemptions.filter((r) => r.kind !== 'freeze' && n0(r.kcal) > 0 && isDateStr(r.date)).map((r) => r.date));
  const freezeBuyDays = new Set(redemptions.filter((r) => r.kind === 'freeze' && isDateStr(r.date)).map((r) => r.date));
  const spent = redemptions.reduce((a, r) => a + n0(r.coins), 0);

  // ---- ช่วงวันที่ที่ต้องคำนวณ ----
  const allDates = [
    ...foodLogs.map((x) => x.date),
    ...bodyLogs.map((x) => x.date),
    ...sessions.map((x) => x.date),
    ...cardio.map((x) => x.date),
    ...redemptions.map((x) => x.date).filter((d) => isDateStr(d) && d <= asOf),
  ].sort();
  // กันข้อมูลวันที่เพี้ยนมาก (เช่น ปี 1000) ไม่ให้วนนานเกินไป
  const startDate = allDates.length ? (diffDays(allDates[0], asOf) > 4000 ? addDays(asOf, -4000) : allDates[0]) : asOf;
  const dates = dateRange(startDate, asOf);

  // ---- วนทีละวัน: สถานะไฟ + coin ----
  let run = 0;
  let runStart = null;
  let held = false;
  let lastBreak = null;
  const weekState = new Map(); // weekStart → { rest, allowed }
  const days = [];
  const ledger = [];
  let earned = 0;
  let today = null;
  let todayStatus = 'open';

  const evalDay = (d, wk, commit) => {
    const trained = !!dayWork.get(d)?.loose;
    const kcalOk = kcalInRange(intakeAll.get(d));
    const cal = kcalOk ? 'ok' : foodRewardDays.has(d) && wk.allowed < s.allowed_per_week ? 'allowed' : null;
    if (!cal) return { status: 'miss', reason: 'kcal', trained, kcalOk };
    // วัน "ได้รับอนุญาต" ไม่ถูกตัดด้วยโควตาวันพัก และไม่กินโควตาวันพัก (ใช้โควตาอนุญาตอย่างเดียว)
    if (cal === 'allowed') {
      if (commit) wk.allowed++;
      return { status: 'allowed', trained, kcalOk };
    }
    if (!trained) {
      if (wk.rest >= s.max_rest_days) return { status: 'miss', reason: 'rest', trained, kcalOk };
      if (commit) wk.rest++;
    }
    return { status: 'pass', trained, kcalOk, restDay: !trained };
  };

  for (const d of dates) {
    if (freezeBuyDays.has(d)) held = true; // ถือได้ทีละ 1 อัน: ซื้อซ้ำตอนถืออยู่ไม่ได้เพิ่ม
    const ws = weekStart(d);
    if (!weekState.has(ws)) weekState.set(ws, { rest: 0, allowed: 0 });
    const wk = weekState.get(ws);
    const mult = tierMultiplier(run, s);
    const isToday = d === asOf;

    // สถานะไฟของวัน
    let ev;
    if (isToday) {
      ev = evalDay(d, { ...wk }, false); // วันนี้ยังไม่จบ: ไม่ตัดสิน ไม่กินโควตา
      todayStatus = ev.status === 'miss' ? 'open' : ev.status;
    } else {
      ev = evalDay(d, wk, true);
      let status = ev.status;
      if (status === 'miss' && held) {
        status = 'freeze';
        held = false;
      }
      if (status === 'pass' || status === 'allowed') {
        run++;
        if (run === 1) runStart = d;
      } else if (status === 'miss') {
        if (run > 0) lastBreak = { date: d, length: run };
        run = 0;
        runStart = null;
      }
      days.push({ date: d, status, mult, run });
    }

    // coin ของวัน
    const items = [];
    const push = (reason, base, ref, extra = {}, m = mult) => {
      const coins = Math.floor(base * m + 1e-9);
      if (!coinDay(d)) return; // ก่อน start_date ไม่นับ coin
      if (base > 0 && coins > 0) items.push({ reason, base, multiplier: m, coins, ref, ...extra });
    };
    const w = dayWork.get(d);
    if (w?.qualFresh) push('workout', s.coin_workout, w.sessionId);
    const cf = cardioFresh.get(d);
    if (cf && cf.minutes >= s.cardio_min_minutes) push('cardio', s.coin_cardio, cf.id);
    const prs = prByDate.get(d)?.sort((a, b) => (a.exerciseId < b.exerciseId ? -1 : 1));
    if (prs?.length) {
      push('pr', Math.min(prs.length * s.coin_pr, s.pr_cap_per_day), prs.map((p) => p.exerciseId).join(','), {
        detail: prs.map((p) => exName.get(p.exerciseId) || '?').join(', '),
        count: prs.length,
      });
    }
    const tf = intakeFresh.get(d);
    if (!isToday && kcalInRange(tf)) push('kcal', s.coin_kcal, d); // วันนี้รอจบวันก่อน
    if (proteinMin > 0 && tf && tf.protein >= proteinMin) push('protein', s.coin_protein, d);
    const bf = bodyFresh.get(d);
    if (stepGoal > 0 && bf && bf.steps >= stepGoal) push('steps', s.coin_steps, bf.stepsId);
    if (bf?.weighId) push('weigh', s.coin_weigh, bf.weighId);
    if (weekBonusByDate.has(d)) push('week_bonus', s.coin_week_bonus, weekBonusByDate.get(d), {}, 1);

    if (items.length) {
      const total = items.reduce((a, i) => a + i.coins, 0);
      ledger.push({ date: d, total, items });
      earned += total;
    }

    if (isToday) {
      // สิ่งที่วันนี้ยังได้อีก
      const todo = []; // ก่อน start_date ไม่มีอะไรให้เก็บ coin
      const add = (reason, text, base, pending = false, m = mult) => {
        if (coinDay(d)) todo.push({ reason, text, coins: Math.floor(base * m + 1e-9), pending });
      };
      const wkDone = !!w?.qualFresh;
      if (!wkDone && s.coin_workout > 0) {
        const needEx = Math.max(0, s.workout_min_exercises - (w?.exFresh || 0));
        const needSets = Math.max(0, s.workout_min_sets - (w?.setsFresh || 0));
        add('workout', w?.setsFresh ? `ฝึกอีก ${needEx} ท่า หรืออีก ${needSets} เซ็ต` : `ฝึกให้ครบ 1 ครั้ง (${s.workout_min_exercises} ท่า หรือ ${s.workout_min_sets} เซ็ต)`, s.coin_workout);
      }
      if (!(cf && cf.minutes >= s.cardio_min_minutes) && s.coin_cardio > 0) {
        add('cardio', cf?.minutes ? `คาร์ดิโออีก ${Math.ceil(s.cardio_min_minutes - cf.minutes)} นาที` : `คาร์ดิโอ ${s.cardio_min_minutes} นาที`, s.coin_cardio);
      }
      if (proteinMin > 0 && s.coin_protein > 0 && !(tf && tf.protein >= proteinMin)) {
        add('protein', `โปรตีนอีก ${Math.ceil(proteinMin - (tf?.protein || 0))} ก.`, s.coin_protein);
      }
      if (target !== null && s.coin_kcal > 0) {
        if (kcalInRange(tf)) add('kcal', 'แคลอรี่อยู่ในช่วงเป้าแล้ว รับ coin ตอนจบวัน', s.coin_kcal, true);
        else add('kcal', `จดอย่างน้อย ${s.kcal_min_meals} มื้อ ให้แคลอรี่อยู่ในช่วง ${Math.round(kcalLo)}–${Math.round(kcalHi)} kcal รับ coin ตอนจบวัน`, s.coin_kcal, true);
      }
      if (stepGoal > 0 && s.coin_steps > 0 && !(bf && bf.steps >= stepGoal)) {
        add('steps', bf?.steps ? `ก้าวอีก ${Math.ceil(stepGoal - bf.steps)}` : `จดก้าวให้ถึง ${stepGoal.toLocaleString('en-US')}`, s.coin_steps);
      }
      if (!bf?.weighId && s.coin_weigh > 0) add('weigh', 'ชั่งน้ำหนักวันนี้', s.coin_weigh);
      const freshCount = (qualFreshByWeek.get(ws) || []).length;
      if (freshCount < s.week_target && s.coin_week_bonus > 0) {
        add('week_bonus', `ฝึกครบอีก ${s.week_target - freshCount} ครั้งในสัปดาห์นี้ ได้โบนัส`, s.coin_week_bonus, false, 1);
      }
      today = {
        date: d,
        trained: !!w?.loose,
        qualified: wkDone,
        kcal: tf?.kcal || 0,
        meals: tf ? tf.meals.size : 0,
        kcalInRange: kcalInRange(tf),
        protein: tf?.protein || 0,
        steps: bf?.steps || 0,
        weighed: !!bf?.weighId,
        cardioMinutes: cf?.minutes || 0,
        status: todayStatus,
        earned: items.reduce((a, i) => a + i.coins, 0),
        coinStarted: coinDay(d), // false = ยังไม่ถึง start_date
        trainingDay: s.training_days.includes(weekday(d)), // วันฝึกตามแผนในตั้งค่า (ใช้แสดงคำใบ้)
        todo,
      };
    }
  }

  // ---- ไฟรายสัปดาห์ ----
  const curWs = weekStart(asOf);
  const wcount = (ws) => (qualAllByWeek.get(ws) || []).length;
  let doneWeeks = 0;
  for (let w = addDays(curWs, -7); wcount(w) >= s.week_target; w = addDays(w, -7)) doneWeeks++;
  const weekCount = wcount(curWs);
  const weekly = doneWeeks + (weekCount >= s.week_target ? 1 : 0);

  const curWeekState = weekState.get(curWs) || { rest: 0, allowed: 0 };
  const display = run + (todayStatus === 'pass' || todayStatus === 'allowed' ? 1 : 0);
  const balance = earned - spent;

  return {
    asOf,
    settings: s,
    ledger,
    earned,
    spent,
    balance,
    streak: {
      run,
      runStart,
      display,
      displayStart: run > 0 ? runStart : display > 0 ? asOf : null, // วันเริ่มของไฟที่แสดงบนการ์ด (ใช้จำเหตุการณ์ฉลอง)
      todayStatus,
      multiplier: tierMultiplier(run, s),
      nextTier: nextTier(run, s),
      weeks: weekly,
      weekCount,
      weekTarget: s.week_target,
      lastBreak,
    },
    freeze: { held, price: s.freeze_price },
    rest: { used: curWeekState.rest, cap: s.max_rest_days },
    allowed: { used: curWeekState.allowed, cap: s.allowed_per_week },
    targetKcal: target === null ? null : { lo: kcalLo, hi: kcalHi },
    today,
    days,
  };
}

// ---------- มุมมอง "coin_transactions" (คำนวณขึ้น ไม่เก็บจริง) ----------

/** รายการ +/− รวมของที่ได้ (ledger) กับของที่ใช้ (redemptions) เรียงจากใหม่ไปเก่า */
export function coinTransactions(game, redemptions) {
  const rows = [];
  for (const day of game.ledger) {
    for (const it of day.items) {
      rows.push({ date: day.date, amount: it.coins, kind: 'earn', reason: it.reason, ref: it.ref, base: it.base, multiplier: it.multiplier, detail: it.detail || '', sort: '' });
    }
  }
  for (const r of live(redemptions)) {
    rows.push({
      date: r.date,
      amount: -n0(r.coins),
      kind: 'spend',
      reason: r.kind === 'freeze' ? 'freeze' : 'redeem',
      ref: r.id,
      base: n0(r.coins),
      multiplier: 1,
      detail: `${r.emoji || ''} ${r.name || ''}`.trim(),
      sort: r.created_at || '',
    });
  }
  return rows.sort((a, b) => (a.date === b.date ? (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0) : a.date < b.date ? 1 : -1));
}

/** จัดกลุ่มตามวัน (ใหม่ → เก่า): [{date, total, rows}] */
export function groupTransactions(rows) {
  const out = [];
  for (const r of rows) {
    let g = out[out.length - 1];
    if (!g || g.date !== r.date) out.push((g = { date: r.date, total: 0, rows: [] }));
    g.rows.push(r);
    g.total += r.amount;
  }
  return out;
}

// ---------- ร้านแลกรางวัล ----------

/**
 * ตรวจว่าแลกได้ไหม  คืน { ok, code, text, reasons[], cooldownLeft, price }
 *  kind 'reward': ต้องมี reward · kind 'freeze': ใช้ราคาไฟสำรอง
 * ยอดติดลบ (เพราะแก้ log ย้อนหลัง) = ห้ามแลก แม้ของราคา 0
 */
export function checkRedeem({ kind = 'reward', reward = null, balance, redemptions = [], today, freezeHeld = false, freezePrice = 30 }) {
  const reasons = [];
  let price;
  let cooldownLeft = 0;
  if (kind === 'freeze') {
    price = freezePrice;
    if (freezeHeld) reasons.push({ code: 'freeze_held', text: 'ถือไฟสำรองอยู่แล้ว (ถือได้ทีละ 1 อัน)' });
  } else {
    price = n0(reward?.price);
    if (!reward || reward.deleted || reward.active === false) reasons.push({ code: 'inactive', text: 'รางวัลนี้ปิดใช้อยู่' });
    // ราคาผิดปกติ (หาย/ไม่ใช่ตัวเลข/ติดลบ/ทศนิยม/0 เช่นข้อมูลซิงก์เพี้ยน) ห้ามแลก ไม่งั้นแลกฟรีได้
    else if (!(typeof reward.price === 'number' && Number.isInteger(reward.price) && reward.price >= 1)) reasons.push({ code: 'bad_price', text: 'ราคารางวัลไม่ถูกต้อง (ต้องเป็นจำนวนเต็มตั้งแต่ 1 coin) กด "แก้" เพื่อตั้งราคาใหม่' });
  }
  if (balance < 0) reasons.push({ code: 'negative', text: `ยอด coin ติดลบ ${balance} (เพราะข้อมูลย้อนหลังเปลี่ยน) ต้องกลับมาเป็นบวกก่อนจึงจะแลกได้` });
  else if (balance < price) reasons.push({ code: 'insufficient', text: `coin ไม่พอ (ขาดอีก ${price - balance})` });
  if (kind !== 'freeze' && reward) {
    const cd = Math.max(0, n0(reward.cooldown_days));
    const last = live(redemptions)
      .filter((r) => r.kind !== 'freeze' && r.reward_id === reward.id && isDateStr(r.date))
      .map((r) => r.date)
      .sort()
      .pop();
    if (cd > 0 && last) {
      cooldownLeft = Math.max(0, cd - diffDays(last, today));
      if (cooldownLeft > 0) reasons.push({ code: 'cooldown', text: `ติด cooldown อีก ${cooldownLeft} วัน` });
    }
  }
  return { ok: reasons.length === 0, code: reasons[0]?.code || null, text: reasons.map((r) => r.text).join(' · '), reasons, cooldownLeft, price };
}

/** แลกของกินใหญ่ (≥ big_meal_kcal) → คำแนะนำ (แค่แนะนำ ไม่บังคับ) หรือ null */
export function bigMealAdvice(kcal, settings) {
  const s = normalizeSettings(settings);
  if (!(n0(kcal) >= s.big_meal_kcal)) return null;
  return `มื้อนี้ประมาณ ${Math.round(kcal).toLocaleString('en-US')} kcal เป็นมื้อใหญ่ ถ้าสะดวก ลองกินน้อยลงสัก 100–150 kcal/วัน ในวันอื่นของสัปดาห์นี้เพื่อให้แผนเดินต่อ (แนะนำเฉยๆ ไม่บังคับ)`;
}

/** ยกเลิกการแลกได้เฉพาะวันที่แลก (กันกดผิด) */
export function canCancelRedemption(redemption, today) {
  return !!redemption && !redemption.deleted && redemption.date === today;
}
