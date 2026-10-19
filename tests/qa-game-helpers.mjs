// ตัวช่วยสร้างข้อมูลสมมติสำหรับเทสต์ QA เกม (ใช้ซ้ำใน qa-game*.test.mjs และสคริปต์ที่รันคนละ TZ)
// ข้อมูลทั้งหมดเป็นค่าสมมติ · ไม่ใช่ไฟล์เทสต์ (ไม่ลงท้าย .test.mjs) จึงไม่ถูก node --test รันเอง
import { computeGame } from '../js/game.js';

export const PROFILE = { kcal: 2000, protein_min: 120, step_goal: 8000 }; // ช่วงเกมค่าเริ่มต้น: 1800–2100
/** 05:00 UTC = 12:00 เวลาไทยของวันเดียวกัน */
export const at = (date, utc = '05:00') => `${date}T${utc}:00.000Z`;
let seq = 0;

export class World {
  constructor() {
    this.foodLogs = [];
    this.bodyLogs = [];
    this.sessions = [];
    this.sets = [];
    this.cardio = [];
    this.redemptions = [];
    this.exercises = Array.from({ length: 6 }, (_, i) => ({ id: `ex${i + 1}`, name: `ท่า${i + 1}`, deleted: false }));
  }
  rec(o) {
    const created = o.created_at || at(o.date);
    return { id: `q${++seq}`, created_at: created, updated_at: created, deleted: false, ...o };
  }
  food(date, meal, kcal, protein = 0, extra = {}) {
    const r = this.rec({ date, meal, kcal, protein, quick: false, ...extra });
    this.foodLogs.push(r);
    return r;
  }
  /** สองมื้อรวม 2000 kcal โปรตีน 130 → อยู่ในช่วงเป้า และถึงโปรตีนขั้นต่ำ */
  goodFood(date, extra = {}) {
    this.food(date, 'เช้า', 700, 50, extra);
    this.food(date, 'เย็น', 1300, 80, extra);
  }
  /** กินน้อยเกินช่วง (1500 kcal) แต่โปรตีนถึง */
  lowFood(date) {
    this.food(date, 'เช้า', 600, 50);
    this.food(date, 'เย็น', 900, 80);
  }
  train(date, exCount = 4, setsPer = 3, { weight = 50, reps = 8, extra = {}, setExtra = {}, warmup = false } = {}) {
    const s = this.rec({ date, day_name: 'Upper A', ...extra });
    this.sessions.push(s);
    for (let e = 1; e <= exCount; e++) {
      for (let k = 0; k < setsPer; k++) {
        this.sets.push(this.rec({ date, session_id: s.id, exercise_id: `ex${e}`, order: k, weight_kg: weight, reps, is_warmup: warmup, ...setExtra }));
      }
    }
    return s;
  }
  cardioFor(date, minutes, extra = {}) {
    const s = this.rec({ date, day_name: 'อื่นๆ', ...extra });
    this.sessions.push(s);
    const c = this.rec({ date, session_id: s.id, type: 'เดินชัน', minutes, ...extra });
    this.cardio.push(c);
    return c;
  }
  body(date, fields, extra = {}) {
    const r = this.rec({ date, weight_kg: null, steps: null, ...fields, ...extra });
    this.bodyLogs.push(r);
    return r;
  }
  redeem(date, fields = {}) {
    const r = this.rec({ date, kind: 'reward', reward_id: 'rw1', name: 'ชาบู', emoji: '🍲', price: 150, coins: 150, kcal: 1200, food_log_id: null, ...fields });
    this.redemptions.push(r);
    return r;
  }
  freeze(date, extra = {}) {
    return this.redeem(date, { kind: 'freeze', reward_id: null, name: 'ไฟสำรอง', emoji: '🧊', price: 30, coins: 30, kcal: 0, ...extra });
  }
  input(asOf, { profile = PROFILE, settings } = {}) {
    return { asOf, profile, settings, foodLogs: this.foodLogs, bodyLogs: this.bodyLogs, sessions: this.sessions, sets: this.sets, cardio: this.cardio, exercises: this.exercises, redemptions: this.redemptions };
  }
  game(asOf, opts) {
    return computeGame(this.input(asOf, opts));
  }
}

export const dayItems = (g, date) => g.ledger.find((d) => d.date === date)?.items || [];
export const dayTotal = (g, date) => g.ledger.find((d) => d.date === date)?.total ?? 0;
export const coinsOf = (g, date, reason) => dayItems(g, date).find((i) => i.reason === reason)?.coins ?? 0;
export const statusOf = (g, date) => g.days.find((d) => d.date === date)?.status;

/**
 * สถานการณ์ 4 สัปดาห์ที่คิดผลด้วยมือ (21 ก.ย. – 18 ต.ค. 2026 · สัปดาห์เริ่มวันจันทร์) · asOf = 19 ต.ค. (จันทร์ ยังไม่ได้จดอะไร)
 * G = กินในช่วง (+5 kcal +5 โปรตีน) · T = ฝึก 4 ท่า 12 เซ็ต (+10) ทุกครั้งน้ำหนัก/จำนวนครั้งเท่ากัน จึงไม่มี PR
 */
export function handScenario() {
  const w = new World();
  const G = (d) => w.goodFood(d);
  const T = (d) => w.train(d);
  // สัปดาห์ 1 (21–27 ก.ย.): G ทุกวัน · ฝึก จ อ พฤ ศ · พัก พ ส อา
  for (const d of ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']) G(d);
  for (const d of ['2026-09-21', '2026-09-22', '2026-09-24', '2026-09-25']) T(d);
  // สัปดาห์ 2 (28 ก.ย. – 4 ต.ค.): เหมือนสัปดาห์ 1 + ชั่งน้ำหนักวันจันทร์ + ก้าว 9000 วันอังคาร
  for (const d of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) G(d);
  for (const d of ['2026-09-28', '2026-09-29', '2026-10-01', '2026-10-02']) T(d);
  w.body('2026-09-28', { weight_kg: 80 });
  w.body('2026-09-29', { steps: 9000 });
  // สัปดาห์ 3 (5–11 ต.ค.): พุธ 7 กินน้อย 1500 (พลาด ไฟดับ) · ฝึก จ อ พฤ ศ
  for (const d of ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']) G(d);
  w.lowFood('2026-10-07');
  for (const d of ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09']) T(d);
  // สัปดาห์ 4 (12–18 ต.ค.): จันทร์ไม่จดอะไรเลย (พลาด) · อ พ พฤ ศ ส อา กินในช่วง · ฝึก อ พฤ ส อา · ศ 16 แลกชาบูกินเกิน 3000 kcal
  for (const d of ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-17', '2026-10-18']) G(d);
  for (const d of ['2026-10-13', '2026-10-15', '2026-10-17', '2026-10-18']) T(d);
  w.body('2026-10-13', { weight_kg: 79.5 });
  w.food('2026-10-16', 'เช้า', 800, 60);
  w.food('2026-10-16', 'เย็น', 2200, 70); // 3000 รวม โปรตีน 130
  w.redeem('2026-10-16');
  return w;
}

/** ผลที่คิดด้วยมือ: [วันที่, coin รวมของวัน] ของวันที่มี coin */
export const HAND_DAYS = [
  // สัปดาห์ 1 ตัวคูณ ×1 ทั้งสัปดาห์ (ไฟ 0→6 ณ สิ้นวันก่อนหน้าไม่ถึง 7)
  ['2026-09-21', 20], ['2026-09-22', 20], ['2026-09-23', 10], ['2026-09-24', 20], ['2026-09-25', 50 /* 20 + โบนัส 30 */], ['2026-09-26', 10], ['2026-09-27', 10],
  // สัปดาห์ 2 ไฟ 7 ณ สิ้นวันอาทิตย์ → ×1.2 ปัดลงต่อรายการ (12 / 6 / 6 / ชั่ง 1 / ก้าว 2)
  ['2026-09-28', 25], ['2026-09-29', 26], ['2026-09-30', 12], ['2026-10-01', 24], ['2026-10-02', 54 /* 24 + 30 */], ['2026-10-03', 12], ['2026-10-04', 12],
  // สัปดาห์ 3 ไฟ 14 → ×1.5 (15 / 7 / 7) · พุธ 7 พลาด: ได้แค่โปรตีน 7 แล้วไฟดับ ตัวคูณกลับ ×1
  ['2026-10-05', 29], ['2026-10-06', 29], ['2026-10-07', 7], ['2026-10-08', 20], ['2026-10-09', 50 /* 20 + 30 */], ['2026-10-10', 10], ['2026-10-11', 10],
  // สัปดาห์ 4 จันทร์ 12 ไม่มีอะไร · ศ 16 วันได้รับอนุญาต: ได้เฉพาะโปรตีน 5
  ['2026-10-13', 21 /* 10+5+5+ชั่ง 1 */], ['2026-10-14', 10], ['2026-10-15', 20], ['2026-10-16', 5], ['2026-10-17', 20], ['2026-10-18', 50 /* 20 + 30 */],
];
