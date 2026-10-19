// ทดสอบเกม coin + streak + ร้านแลกรางวัล (js/game.js, js/game-actions.js)
// ข้อมูลสมมติทั้งหมด · วันที่/เวลาเป็นค่าตายตัวตามเวลาไทย (UTC+7) · รัน: node --test
//
// ปฏิทินที่ใช้: 2026-10-12 = จันทร์ · 13 อ. · 14 พ. · 15 พฤ. · 16 ศ. · 17 ส. · 18 อา.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGame, thaiDay, normalizeSettings, tierMultiplier, nextTier, checkRedeem, coinTransactions, groupTransactions, bigMealAdvice, canCancelRedemption } from '../js/game.js';
import { redeemReward, buyFreeze, cancelRedemption, GameError } from '../js/game-actions.js';
import { DEFAULT_GAME_SETTINGS, DATA_FORMAT, DATA_VERSION, GAME_SETTINGS_ID, PROFILE_ID, TABLES, TABLE_LABELS } from '../js/constants.js';
import { seedRewards, seedId, SEED_VERSION } from '../js/seed.js';
import { addDays, dateRange, weekStart } from '../js/dates.js';
import { validateImport } from '../js/db.js';
import { toCSV } from '../js/csv.js';
import { createMockSupabase } from './mock-supabase.mjs';
import { createClock, createDevice, makeUser } from './memory-device.mjs';

// ---------- ตัวช่วยสร้างข้อมูลสมมติ ----------

const PROFILE = { kcal: 2000, kcal_tolerance: 100, protein_min: 120, step_goal: 8000 }; // ช่วงเกม: เป้า ± 100 = 1900–2100
const at = (date, utc = '05:00') => `${date}T${utc}:00.000Z`; // 05:00 UTC = 12:00 เวลาไทย ของวันเดียวกัน
let seq = 0;

class World {
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
    return { id: `x${++seq}`, created_at: created, updated_at: created, deleted: false, ...o };
  }
  food(date, meal, kcal, protein = 0, extra = {}) {
    const r = this.rec({ date, meal, kcal, protein, quick: false, ...extra });
    this.foodLogs.push(r);
    return r;
  }
  /** สองมื้อ รวม 2000 kcal โปรตีน 130 (อยู่ในช่วงเป้า และถึงโปรตีนขั้นต่ำ) */
  goodFood(date, extra = {}) {
    this.food(date, 'เช้า', 700, 50, extra);
    this.food(date, 'เย็น', 1300, 80, extra);
  }
  /** ครั้งที่ฝึก: exCount ท่า × setsPer เซ็ต (reps/น้ำหนักกำหนดได้) */
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
    const s = this.rec({ date, day_name: 'อื่นๆ' });
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
  game(asOf, { profile = PROFILE, settings } = {}) {
    return computeGame({ asOf, profile, settings, foodLogs: this.foodLogs, bodyLogs: this.bodyLogs, sessions: this.sessions, sets: this.sets, cardio: this.cardio, exercises: this.exercises, redemptions: this.redemptions });
  }
}

const dayItems = (g, date) => g.ledger.find((d) => d.date === date)?.items || [];
const itemOf = (g, date, reason) => dayItems(g, date).find((i) => i.reason === reason);
const coinsOf = (g, date, reason) => itemOf(g, date, reason)?.coins ?? 0;
const statusOf = (g, date) => g.days.find((d) => d.date === date)?.status;
const TRAIN_DOW = new Set([1, 2, 4, 5]);

/** n วันติดกัน (เริ่มวันจันทร์) ที่ "ทำตามแผน": กิน 2 มื้อในช่วงเป้า และฝึกวัน จ อ พฤ ศ (วันพัก 3 วัน/สัปดาห์) */
function streakWorld(start, n) {
  const w = new World();
  for (const d of dateRange(start, addDays(start, n - 1))) {
    w.goodFood(d);
    const dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = จันทร์
    if ([0, 1, 3, 4].includes(dow)) w.train(d);
  }
  return w;
}

// ---------- เวลาไทย / การตั้งค่า ----------

test('thaiDay: แปลงเวลา UTC เป็นวันตามเวลาไทย (UTC+7) รอยต่อเที่ยงคืน', () => {
  assert.equal(thaiDay('2026-10-18T16:59:59.000Z'), '2026-10-18');
  assert.equal(thaiDay('2026-10-18T17:00:00.000Z'), '2026-10-19');
  assert.equal(thaiDay('2026-12-31T20:00:00.000Z'), '2027-01-01');
  assert.equal(thaiDay('ไม่ใช่เวลา'), null);
  assert.equal(thaiDay(undefined), null);
});

test('ค่าตั้งต้นของเกมตรงสเปค และค่าที่เพี้ยนถูกแทนด้วยค่าเริ่มต้น', () => {
  const d = normalizeSettings(null);
  assert.deepEqual(d, DEFAULT_GAME_SETTINGS);
  assert.equal(d.coin_workout, 10);
  assert.equal(d.coin_cardio, 3);
  assert.equal(d.coin_pr, 5);
  assert.equal(d.pr_cap_per_day, 15);
  assert.equal(d.coin_kcal, 5);
  assert.equal(d.coin_protein, 5);
  assert.equal(d.coin_steps, 2);
  assert.equal(d.coin_weigh, 1);
  assert.equal(d.coin_week_bonus, 30);
  assert.equal(d.week_target, 4);
  assert.equal(d.kcal_below, null); // ว่าง = ใช้ ± จาก profile.kcal_tolerance
  assert.equal(d.kcal_above, null);
  assert.equal(d.start_date, null);
  assert.equal(d.kcal_min_meals, 2);
  assert.deepEqual(d.training_days, [1, 2, 4, 5]);
  assert.equal(d.max_rest_days, 3);
  assert.equal(d.freeze_price, 30);
  assert.equal(d.backdate_days, 2);
  const bad = normalizeSettings({ coin_workout: 'abc', coin_kcal: -3, tier1_mult: 0.2, week_target: 0, training_days: [9, 'x', 3, 3] });
  assert.equal(bad.coin_workout, 10);
  assert.equal(bad.coin_kcal, 5);
  assert.equal(bad.tier1_mult, 1);
  assert.equal(bad.week_target, 1);
  assert.deepEqual(bad.training_days, [3]);
  assert.equal(normalizeSettings({ coin_workout: '25' }).coin_workout, 25);
  assert.equal(normalizeSettings({ extra: 1 }).extra, undefined);
});

test('ตั้งค่าเปลี่ยนผลได้จริง: coin ฝึก 25, ช่วงแคลอรี่กว้างขึ้น, เป้าท่าเหลือ 2', () => {
  const w = new World();
  w.train('2026-10-13', 2, 2);
  w.food('2026-10-13', 'เช้า', 1500);
  w.food('2026-10-13', 'เย็น', 100);
  const def = w.game('2026-10-15');
  assert.equal(coinsOf(def, '2026-10-13', 'workout'), 0); // 2 ท่า 4 เซ็ต ไม่ถึง 4 ท่า/8 เซ็ต
  assert.equal(coinsOf(def, '2026-10-13', 'kcal'), 0); // 1600 ต่ำกว่า 1800
  const custom = w.game('2026-10-15', { settings: { coin_workout: 25, workout_min_exercises: 2, kcal_below: 500 } });
  assert.equal(coinsOf(custom, '2026-10-13', 'workout'), 25);
  assert.equal(coinsOf(custom, '2026-10-13', 'kcal'), 5);
});

// ---------- กติกาการได้ coin ----------

test('ฝึกครบ 1 ครั้ง +10: 4 ท่า หรือ 8 เซ็ตทำงาน, วอร์มอัพไม่นับ, ได้ไม่เกิน 1 ครั้งต่อวัน', () => {
  const d = '2026-10-13';
  const asOf = '2026-10-15';
  let w = new World();
  w.train(d, 4, 1); // 4 ท่า 4 เซ็ต
  assert.equal(coinsOf(w.game(asOf), d, 'workout'), 10);

  w = new World();
  w.train(d, 1, 8); // 1 ท่า 8 เซ็ต
  assert.equal(coinsOf(w.game(asOf), d, 'workout'), 10);

  w = new World();
  w.train(d, 3, 2); // 3 ท่า 6 เซ็ต → ไม่ถึง
  assert.equal(coinsOf(w.game(asOf), d, 'workout'), 0);

  w = new World();
  w.train(d, 4, 3, { warmup: true }); // ทุกเซ็ตเป็นวอร์มอัพ
  assert.equal(coinsOf(w.game(asOf), d, 'workout'), 0);

  w = new World();
  w.train(d, 4, 2, { weight: 40, reps: 8 });
  w.train(d, 4, 2); // ฝึกสองครั้งในวันเดียว
  const g = w.game(asOf);
  assert.equal(dayItems(g, d).filter((i) => i.reason === 'workout').length, 1);
  assert.equal(coinsOf(g, d, 'workout'), 10);
});

test('คาร์ดิโอ ≥15 นาที +3 ต่อวัน (รวมเวลาของวัน)', () => {
  const asOf = '2026-10-15';
  let w = new World();
  w.cardioFor('2026-10-13', 15);
  assert.equal(coinsOf(w.game(asOf), '2026-10-13', 'cardio'), 3);
  w = new World();
  w.cardioFor('2026-10-13', 14);
  assert.equal(coinsOf(w.game(asOf), '2026-10-13', 'cardio'), 0);
  w = new World();
  w.cardioFor('2026-10-13', 8);
  w.cardioFor('2026-10-13', 8);
  const g = w.game(asOf);
  assert.equal(coinsOf(g, '2026-10-13', 'cardio'), 3);
  assert.equal(dayItems(g, '2026-10-13').filter((i) => i.reason === 'cardio').length, 1);
});

test('แคลอรี่อยู่ในช่วงเป้า +5: ใช้เป้า ± kcal_tolerance ของโปรไฟล์ (1900–2100 รวมขอบ), ต้อง ≥2 มื้อที่ต่างกัน, quick add นับเป็นมื้อ', () => {
  const asOf = '2026-10-20';
  const run = (kcals, meals = ['เช้า', 'เย็น'], opts = {}) => {
    const w = new World();
    kcals.forEach((k, i) => w.food('2026-10-14', meals[i], k, 0, { quick: i === 1 }));
    return coinsOf(w.game(asOf, opts), '2026-10-14', 'kcal');
  };
  assert.equal(run([950, 950]), 5); // 1900 พอดี
  assert.equal(run([1000, 1100]), 5); // 2100 พอดี
  assert.equal(run([950, 949.9]), 0); // 1899.9
  assert.equal(run([1000, 1100.5]), 0); // 2100.5
  assert.equal(run([1000, 1000]), 5);
  assert.equal(run([2000], ['เช้า']), 0); // มื้อเดียว
  assert.equal(run([1000, 1000], ['เช้า', 'เช้า']), 0); // สองรายการแต่มื้อเดียวกัน = 1 มื้อ
  // เปลี่ยน ± ในโปรไฟล์ → ช่วงของเกมตาม
  const wide = (tol) => {
    const w = new World();
    w.food('2026-10-14', 'เช้า', 900, 0);
    w.food('2026-10-14', 'เย็น', 850, 0); // 1750
    return coinsOf(w.game(asOf, { profile: { ...PROFILE, kcal_tolerance: tol } }), '2026-10-14', 'kcal');
  };
  assert.equal(wide(100), 0);
  assert.equal(wide(250), 5);
  // ไม่มี kcal_tolerance ในโปรไฟล์ → ค่าเริ่มต้น ±100 เหมือน analytics.kcalOk
  const w0 = new World();
  w0.food('2026-10-14', 'เช้า', 950, 0);
  w0.food('2026-10-14', 'เย็น', 949, 0);
  assert.equal(coinsOf(w0.game(asOf, { profile: { kcal: 2000 } }), '2026-10-14', 'kcal'), 0);
  // ตั้งค่าเกม override ได้: ต่ำกว่า 200 สูงกว่า 100 → 1800–2100; ว่าง = ตามโปรไฟล์
  assert.equal(run([900, 900], undefined, { settings: { kcal_below: 200, kcal_above: 100 } }), 5);
  assert.equal(run([900, 900], undefined, { settings: { kcal_below: '', kcal_above: null } }), 0);
  assert.equal(normalizeSettings({ kcal_below: '', kcal_above: 'x' }).kcal_below, null);
  assert.equal(normalizeSettings({ kcal_above: '150' }).kcal_above, 150);
  // ไม่มีเป้าแคลอรี่ในโปรไฟล์ → ไม่ได้ coin แคลอรี่
  const w = new World();
  w.goodFood('2026-10-14');
  assert.equal(coinsOf(w.game(asOf, { profile: { ...PROFILE, kcal: null } }), '2026-10-14', 'kcal'), 0);
});

test('coin แคลอรี่ของ "วันนี้" รอจนวันจบ (กินเพิ่มแล้วอาจออกนอกช่วง) ส่วนโปรตีนนับทันที', () => {
  const w = new World();
  w.goodFood('2026-10-14');
  const same = w.game('2026-10-14');
  assert.equal(coinsOf(same, '2026-10-14', 'kcal'), 0);
  assert.equal(coinsOf(same, '2026-10-14', 'protein'), 5);
  assert.ok(same.today.todo.some((t) => t.reason === 'kcal' && t.pending));
  assert.equal(coinsOf(w.game('2026-10-15'), '2026-10-14', 'kcal'), 5);
});

test('โปรตีน +5 (≥ ขั้นต่ำในโปรไฟล์), ก้าว +2 (≥ เป้าก้าว), ชั่งน้ำหนัก +1', () => {
  const asOf = '2026-10-16';
  const w = new World();
  w.food('2026-10-14', 'เช้า', 100, 119.9);
  w.food('2026-10-15', 'เช้า', 100, 120);
  w.body('2026-10-14', { weight_kg: 80, steps: 7999 });
  w.body('2026-10-15', { weight_kg: null, steps: 8000 });
  const g = w.game(asOf);
  assert.equal(coinsOf(g, '2026-10-14', 'protein'), 0);
  assert.equal(coinsOf(g, '2026-10-15', 'protein'), 5);
  assert.equal(coinsOf(g, '2026-10-14', 'steps'), 0);
  assert.equal(coinsOf(g, '2026-10-15', 'steps'), 2);
  assert.equal(coinsOf(g, '2026-10-14', 'weigh'), 1);
  assert.equal(coinsOf(g, '2026-10-15', 'weigh'), 0); // ไม่ได้ชั่ง
  // โปรไฟล์ไม่มีโปรตีน/เป้าก้าว → ไม่ได้
  const none = w.game(asOf, { profile: { kcal: 2000 } });
  assert.equal(coinsOf(none, '2026-10-15', 'protein'), 0);
  assert.equal(coinsOf(none, '2026-10-15', 'steps'), 0);
});

// ---------- PR ----------

function prWorld(improveCount) {
  const w = new World();
  w.train('2026-10-05', 5, 1, { weight: 50, reps: 8 }); // รอบก่อนหน้า: ท่า 1–5
  const s = w.rec({ date: '2026-10-14', day_name: 'Upper A' });
  w.sessions.push(s);
  for (let e = 1; e <= 6; e++) {
    const better = e <= improveCount;
    w.sets.push(w.rec({ date: '2026-10-14', session_id: s.id, exercise_id: `ex${e}`, order: 0, weight_kg: better ? 60 : 50, reps: 8, is_warmup: false }));
  }
  return w;
}

test('PR +5 ต่อท่า: ต้องดีกว่าเดิมจริง, ท่าที่เล่นครั้งแรกไม่นับ, ไม่เกิน 15 ต่อวัน', () => {
  const asOf = '2026-10-16';
  assert.equal(coinsOf(prWorld(1).game(asOf), '2026-10-14', 'pr'), 5);
  assert.equal(coinsOf(prWorld(2).game(asOf), '2026-10-14', 'pr'), 10);
  assert.equal(coinsOf(prWorld(3).game(asOf), '2026-10-14', 'pr'), 15);
  const capped = prWorld(5).game(asOf); // 5 ท่าทำ PR = 25 → เพดาน 15
  assert.equal(itemOf(capped, '2026-10-14', 'pr').base, 15);
  assert.equal(itemOf(capped, '2026-10-14', 'pr').count, 5);
  assert.equal(coinsOf(capped, '2026-10-14', 'pr'), 15);
  // ท่าที่ 6 เล่นครั้งแรก (ไม่มีประวัติก่อนหน้า) → ไม่เป็น PR
  assert.equal(coinsOf(prWorld(0).game(asOf), '2026-10-14', 'pr'), 0);
  // เท่าเดิมไม่ใช่ PR
  const w = new World();
  w.train('2026-10-05', 1, 1);
  w.train('2026-10-14', 1, 1);
  assert.equal(coinsOf(w.game(asOf), '2026-10-14', 'pr'), 0);
});

test('เพดาน PR ใช้กับค่าฐานก่อนคูณ: ไฟ ×1.2 → 15 × 1.2 = 18', () => {
  const w = streakWorld('2026-09-07', 14); // 7–20 ก.ย.
  // 14 ก.ย. (ไฟ 7 วัน ณ สิ้นวันก่อนหน้า → ×1.2) ยกน้ำหนักท่า 1–4 ขึ้นจาก 50 เป็น 60 → PR 4 ท่า = 20 → เพดาน 15
  const ses = w.sessions.find((x) => x.date === '2026-09-14');
  w.sets.filter((x) => x.session_id === ses.id).forEach((x) => (x.weight_kg = 60));
  const g = w.game('2026-09-21');
  const pr = itemOf(g, '2026-09-14', 'pr');
  assert.equal(pr.count, 4);
  assert.equal(pr.base, 15);
  assert.equal(pr.multiplier, 1.2);
  assert.equal(pr.coins, 18);
});

// ---------- ตัวคูณ ----------

test('ตัวคูณตามความยาวไฟ ณ สิ้นวันก่อนหน้า: 7 → ×1.2, 14 → ×1.5, 30 → ×2 และปัดเศษลงต่อรายการ', () => {
  const w = streakWorld('2026-09-07', 35);
  // คาร์ดิโอ 15 นาที (base 3) ในวันที่ไฟต่างกัน: ปัดเศษลง
  w.cardioFor('2026-09-08', 15); // i=1  ×1   → 3
  w.cardioFor('2026-09-13', 15); // i=6  ×1   → 3  (วันที่ 7 ของไฟ ยังใช้ ×1)
  w.cardioFor('2026-09-14', 15); // i=7  ×1.2 → 3.6 → 3
  w.cardioFor('2026-09-20', 15); // i=13 ×1.2 → 3
  w.cardioFor('2026-09-21', 15); // i=14 ×1.5 → 4.5 → 4
  w.cardioFor('2026-10-06', 15); // i=29 ×1.5 → 4
  w.cardioFor('2026-10-07', 15); // i=30 ×2   → 6
  const g = w.game('2026-10-12');
  assert.equal(coinsOf(g, '2026-09-08', 'cardio'), 3);
  assert.equal(coinsOf(g, '2026-09-13', 'cardio'), 3);
  assert.equal(coinsOf(g, '2026-09-14', 'cardio'), 3);
  assert.equal(coinsOf(g, '2026-09-20', 'cardio'), 3);
  assert.equal(coinsOf(g, '2026-09-21', 'cardio'), 4);
  assert.equal(coinsOf(g, '2026-10-06', 'cardio'), 4);
  assert.equal(coinsOf(g, '2026-10-07', 'cardio'), 6);
  // รายการอื่นของวันเดียวกัน: ฝึก 10 / แคลอรี่ 5 / โปรตีน 5
  assert.deepEqual(
    ['workout', 'kcal', 'protein'].map((r) => itemOf(g, '2026-09-07', r).coins), // i=0 ×1
    [10, 5, 5]
  );
  assert.deepEqual(
    ['workout', 'kcal', 'protein'].map((r) => itemOf(g, '2026-09-14', r).coins), // i=7 ×1.2
    [12, 6, 6]
  );
  assert.deepEqual(
    ['workout', 'kcal', 'protein'].map((r) => itemOf(g, '2026-09-21', r).coins), // i=14 ×1.5 (5 → 7.5 → 7)
    [15, 7, 7]
  );
  assert.deepEqual(
    ['kcal', 'protein'].map((r) => itemOf(g, '2026-10-07', r).coins), // i=30 ×2
    [10, 10]
  );
  assert.equal(itemOf(g, '2026-09-21', 'kcal').multiplier, 1.5);
  assert.equal(itemOf(g, '2026-09-21', 'kcal').base, 5);
  // สถานะปัจจุบัน
  assert.equal(g.streak.run, 35);
  assert.equal(g.streak.multiplier, 2);
  assert.equal(g.streak.nextTier, null);
});

test('tierMultiplier / nextTier: ขอบเขต 6,7,13,14,29,30', () => {
  const m = (n) => tierMultiplier(n, null);
  assert.deepEqual([0, 6, 7, 13, 14, 29, 30, 100].map(m), [1, 1, 1.2, 1.2, 1.5, 1.5, 2, 2]);
  assert.deepEqual(nextTier(3, null), { days: 7, mult: 1.2, left: 4 });
  assert.deepEqual(nextTier(7, null), { days: 14, mult: 1.5, left: 7 });
  assert.equal(nextTier(30, null), null);
  assert.equal(tierMultiplier(5, { tier1_days: 5, tier1_mult: 3 }), 3); // ผู้ใช้ตั้งเอง
});

test('โบนัส 4 ครั้ง/สัปดาห์ +30 ลงที่วันฝึกครั้งที่ 4 ครั้งเดียว และไม่ถูกคูณ แม้ไฟ ×2', () => {
  const w = new World();
  for (const d of ['2026-10-12', '2026-10-13', '2026-10-15']) w.train(d);
  let g = w.game('2026-10-18');
  assert.equal(g.ledger.flatMap((l) => l.items).filter((i) => i.reason === 'week_bonus').length, 0); // 3 ครั้ง ไม่ได้

  w.train('2026-10-16'); // ครั้งที่ 4
  w.train('2026-10-17'); // ครั้งที่ 5 ไม่ได้โบนัสซ้ำ
  g = w.game('2026-10-18');
  const bonus = g.ledger.flatMap((l) => l.items.map((i) => ({ date: l.date, ...i }))).filter((i) => i.reason === 'week_bonus');
  assert.equal(bonus.length, 1);
  assert.equal(bonus[0].date, '2026-10-16');
  assert.equal(bonus[0].coins, 30);
  assert.equal(bonus[0].multiplier, 1);

  // ไฟ 30+ วัน: โบนัสยังเป็น 30 (ไม่คูณ 2) ขณะที่ coin ฝึกของวันเดียวกันถูกคูณ
  const s = streakWorld('2026-09-07', 35);
  const g2 = s.game('2026-10-12');
  const b2 = g2.ledger.find((l) => l.date === '2026-10-09'); // ศุกร์ = ฝึกครั้งที่ 4 ของสัปดาห์ (ไฟ 32 วัน → ×2)
  assert.equal(b2.items.find((i) => i.reason === 'week_bonus').coins, 30);
  assert.equal(b2.items.find((i) => i.reason === 'workout').coins, 20);
});

test('โบนัสรายสัปดาห์ใช้ฝึกที่ไม่เก่าเกิน 2 วันเท่านั้น (ฝึกย้อนหลังไม่ได้โบนัส)', () => {
  const w = new World();
  for (const d of ['2026-10-12', '2026-10-13', '2026-10-15']) w.train(d);
  const late = { created_at: at('2026-10-20') }; // จดย้อนหลัง 4 วัน
  w.train('2026-10-16', 4, 3, { extra: late, setExtra: late });
  const g = w.game('2026-10-18');
  assert.equal(g.ledger.flatMap((l) => l.items).filter((i) => i.reason === 'week_bonus').length, 0);
  assert.equal(g.streak.weekCount, 4); // แต่ไฟรายสัปดาห์นับครบ 4 ครั้ง
});

// ---------- ไฟรายวัน ----------

test('ไฟรายวัน: วันที่ฝึกหรือวันพักที่แคลอรี่ในช่วง ติดกัน · วันที่ไม่ได้จดอาหารทำให้ไฟดับ', () => {
  const w = new World();
  w.goodFood('2026-10-12'); w.train('2026-10-12');
  w.goodFood('2026-10-13'); w.train('2026-10-13');
  w.goodFood('2026-10-14'); // วันพัก
  // 15 ไม่ได้จดอาหาร → พลาด
  w.goodFood('2026-10-16'); w.train('2026-10-16');
  const g = w.game('2026-10-17');
  assert.deepEqual(g.days.map((d) => d.status), ['pass', 'pass', 'pass', 'miss', 'pass']);
  assert.equal(g.streak.run, 1);
  assert.equal(g.streak.lastBreak.date, '2026-10-15');
  assert.equal(g.streak.lastBreak.length, 3);
});

test('วันพักเกิน 3 วันต่อสัปดาห์: วันพักที่ 4 และ 5 พลาด, สัปดาห์ใหม่โควตารีเซ็ต', () => {
  const w = new World();
  for (const d of dateRange('2026-10-12', '2026-10-20')) w.goodFood(d);
  w.train('2026-10-12');
  w.train('2026-10-13');
  const g = w.game('2026-10-21');
  // จ ฝึก · อ ฝึก · พ พัก1 · พฤ พัก2 · ศ พัก3 · ส พัก4(พลาด) · อา พัก5(พลาด) · จ(ใหม่) พัก1 · อ พัก2
  assert.deepEqual(
    g.days.map((d) => d.status),
    ['pass', 'pass', 'pass', 'pass', 'pass', 'miss', 'miss', 'pass', 'pass']
  );
  assert.equal(g.streak.run, 2);
  assert.equal(g.streak.lastBreak.length, 5);
  // ตั้งค่าให้พักได้ 4 วัน → ส. ผ่าน
  const g4 = w.game('2026-10-21', { settings: { max_rest_days: 4 } });
  assert.equal(statusOf(g4, '2026-10-17'), 'pass');
  assert.equal(statusOf(g4, '2026-10-18'), 'miss');
});

test('วันที่ไม่ได้จดอาหารไม่กินโควตาวันพัก (ไม่ใช่วันที่ "ผ่านแล้ว")', () => {
  const w = new World();
  w.goodFood('2026-10-12'); // พัก1
  // 13, 14 ไม่จด
  w.goodFood('2026-10-15'); // พัก2
  w.goodFood('2026-10-16'); // พัก3
  w.goodFood('2026-10-17'); // พัก4 → พลาด
  const g = w.game('2026-10-18');
  assert.deepEqual(g.days.map((d) => d.status), ['pass', 'miss', 'miss', 'pass', 'pass', 'miss']);
});

test('วันนี้ไม่ถูกตัดสินว่าพลาด: ยังไม่จดอาหารก็ไฟไม่ดับ และไม่นับเป็นวันของไฟ จนกว่าจะผ่าน', () => {
  const w = streakWorld('2026-10-06', 6); // 6–11 ต.ค.
  const open = w.game('2026-10-12');
  assert.equal(open.streak.run, 6);
  assert.equal(open.streak.todayStatus, 'open');
  assert.equal(open.streak.display, 6);
  w.goodFood('2026-10-12');
  w.train('2026-10-12');
  const done = w.game('2026-10-12');
  assert.equal(done.streak.run, 6); // ยืนยันแล้ว ณ สิ้นวันก่อนหน้า
  assert.equal(done.streak.todayStatus, 'pass');
  assert.equal(done.streak.display, 7);
  assert.equal(done.streak.multiplier, 1); // ตัวคูณใช้ ณ สิ้นวันก่อนหน้า (6 วัน)
  assert.equal(coinsOf(done, '2026-10-12', 'workout'), 10);
});

// ---------- วันที่ได้รับอนุญาต ----------

test('วันที่ได้รับอนุญาต: แลกของกินแล้วแคลอรี่เกิน ไฟไม่ดับ (1 วัน/สัปดาห์) และวันนั้นไม่ได้ coin แคลอรี่', () => {
  const w = new World();
  w.goodFood('2026-10-12'); w.train('2026-10-12');
  // 13 ต.ค.: แลกชาบู 1200 kcal → รวม 3200 เกินช่วง
  w.goodFood('2026-10-13'); w.train('2026-10-13');
  w.food('2026-10-13', 'เย็น', 1200, 0, { quick: true });
  w.redeem('2026-10-13');
  // 15 ต.ค.: แลกอีก (สัปดาห์เดียวกัน) → โควตาหมด พลาด
  w.goodFood('2026-10-15'); w.train('2026-10-15');
  w.food('2026-10-15', 'เย็น', 1200, 0, { quick: true });
  w.redeem('2026-10-15');
  // สัปดาห์ใหม่ 19 ต.ค.: ได้อีก 1 วัน
  w.goodFood('2026-10-19'); w.train('2026-10-19');
  w.food('2026-10-19', 'เย็น', 1200, 0, { quick: true });
  w.redeem('2026-10-19');
  const g = w.game('2026-10-20');
  assert.equal(statusOf(g, '2026-10-12'), 'pass');
  assert.equal(statusOf(g, '2026-10-13'), 'allowed');
  assert.equal(coinsOf(g, '2026-10-13', 'kcal'), 0);
  assert.equal(statusOf(g, '2026-10-14'), 'miss'); // ไม่ได้จดอาหาร
  assert.equal(statusOf(g, '2026-10-15'), 'miss'); // วันได้รับอนุญาตครั้งที่ 2 ของสัปดาห์
  assert.equal(statusOf(g, '2026-10-19'), 'allowed');
  assert.equal(g.allowed.used, 1); // สัปดาห์ปัจจุบัน (19–25) ใช้ไป 1
});

test('วันที่ได้รับอนุญาต: ถ้าแคลอรี่อยู่ในช่วงอยู่แล้วไม่กินโควตา, รางวัลที่ไม่ใช่ของกิน (kcal 0) และรายการที่ยกเลิกแล้วไม่นับ', () => {
  const w = new World();
  w.goodFood('2026-10-12'); w.train('2026-10-12');
  w.redeem('2026-10-12'); // แลกแต่ไม่ได้ลงบันทึกการกิน → ยังอยู่ในช่วง
  w.goodFood('2026-10-13'); w.train('2026-10-13');
  w.food('2026-10-13', 'เย็น', 1200, 0, { quick: true });
  w.redeem('2026-10-13', { kcal: 0, reward_id: 'movie', name: 'ดูหนัง', emoji: '🎬' }); // kcal 0 ไม่ใช่วันได้รับอนุญาต
  w.goodFood('2026-10-14'); w.train('2026-10-14');
  w.food('2026-10-14', 'เย็น', 1200, 0, { quick: true });
  w.redeem('2026-10-14', { deleted: true }); // ยกเลิกแล้ว
  w.goodFood('2026-10-15'); w.train('2026-10-15');
  w.food('2026-10-15', 'เย็น', 1200, 0, { quick: true });
  w.redeem('2026-10-15'); // ได้รับอนุญาต ใช้โควตาสัปดาห์นี้ (วันที่ 12 ไม่ได้ใช้)
  const g = w.game('2026-10-16');
  assert.equal(statusOf(g, '2026-10-12'), 'pass');
  assert.equal(statusOf(g, '2026-10-13'), 'miss');
  assert.equal(statusOf(g, '2026-10-14'), 'miss');
  assert.equal(statusOf(g, '2026-10-15'), 'allowed');
});

// ---------- ไฟสำรอง ----------

test('ไฟสำรอง 🧊: ซื้อแล้วถูกใช้กับวันแรกที่พลาด ไฟไม่ดับ; วันพลาดถัดไปดับตามปกติ', () => {
  const w = new World();
  w.goodFood('2026-10-12'); w.train('2026-10-12');
  w.goodFood('2026-10-13'); w.train('2026-10-13');
  w.freeze('2026-10-13');
  // 14 พลาด (ไม่ได้จด) → ใช้ไฟสำรอง
  w.goodFood('2026-10-15'); w.train('2026-10-15');
  // 16 พลาดอีก → ไม่มีไฟสำรองแล้ว ไฟดับ
  const g = w.game('2026-10-17');
  assert.deepEqual(g.days.map((d) => d.status), ['pass', 'pass', 'freeze', 'pass', 'miss']);
  assert.equal(g.freeze.held, false);
  assert.equal(g.streak.run, 0);
  assert.equal(g.streak.lastBreak.length, 3); // 12, 13, 15 (วันที่ใช้ไฟสำรองไม่นับเพิ่ม แต่ไม่ตัด)
});

test('ไฟสำรอง: พลาดก่อนซื้อไม่ถูกช่วย (ไม่ย้อนแก้อดีต), ซื้อในวันที่พลาดนั้นเองได้ช่วยวันนั้น', () => {
  const w = new World();
  w.goodFood('2026-10-12'); w.train('2026-10-12');
  // 13 พลาด (ยังไม่มีไฟสำรอง)
  w.freeze('2026-10-14'); // ซื้อ 14
  w.goodFood('2026-10-14'); w.train('2026-10-14');
  const g = w.game('2026-10-15');
  assert.equal(statusOf(g, '2026-10-13'), 'miss');
  assert.equal(statusOf(g, '2026-10-14'), 'pass');
  assert.equal(g.freeze.held, true); // ยังถืออยู่ (ยังไม่มีวันพลาดหลังซื้อ)

  const w2 = new World();
  w2.goodFood('2026-10-12'); w2.train('2026-10-12');
  w2.freeze('2026-10-13'); // ซื้อวันที่ 13 ซึ่งไม่ได้จดอาหาร ไฟจะดับเมื่อวันจบ → ไฟสำรองช่วยวัน 13
  w2.goodFood('2026-10-14'); w2.train('2026-10-14');
  const g2 = w2.game('2026-10-15');
  assert.equal(statusOf(g2, '2026-10-13'), 'freeze');
  assert.equal(g2.streak.run, 2);
  assert.equal(g2.freeze.held, false);
});

test('ไฟสำรอง: ถือได้ทีละ 1 อัน (ซื้อซ้ำไม่ได้, ซื้อซ้ำก็ช่วยได้แค่ 1 วัน), ไม่ใช้กับวันนี้', () => {
  const w = new World();
  w.goodFood('2026-10-12'); w.train('2026-10-12');
  w.freeze('2026-10-12');
  // ซื้ออันที่สองทั้งที่ถืออยู่: ระบบห้ามซื้อ
  const g0 = w.game('2026-10-13');
  assert.equal(g0.freeze.held, true);
  const blocked = checkRedeem({ kind: 'freeze', balance: 999, today: '2026-10-13', freezeHeld: g0.freeze.held, freezePrice: 30 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'freeze_held');
  // ข้อมูลที่ซิงก์มาจากอีกเครื่องมีการซื้อซ้ำ → ยังถือได้แค่ 1 อัน
  w.freeze('2026-10-12', { id: 'dup' });
  // วันนี้ (13) ยังไม่จบ ยังไม่ได้จดอะไร → ไม่ใช้ไฟสำรอง
  const today = w.game('2026-10-13');
  assert.equal(today.freeze.held, true);
  assert.equal(today.streak.todayStatus, 'open');
  assert.equal(today.days.length, 1);
  // พรุ่งนี้ (14) วัน 13 พลาด → ใช้ 1 อัน; 14 ยังเป็นวันนี้
  const next = w.game('2026-10-14');
  assert.equal(statusOf(next, '2026-10-13'), 'freeze');
  assert.equal(next.freeze.held, false);
  // วันพลาดถัดไปต้องดับ (ไม่มีอันที่สอง)
  const later = w.game('2026-10-15');
  assert.equal(statusOf(later, '2026-10-14'), 'miss');
});

// ---------- กฎแก้ข้อมูลย้อนหลังเกิน 2 วัน ----------

test('แก้ข้อมูลย้อนหลังเกิน 2 วัน (เวลาไทย) ไม่ได้ coin แต่ยังนับใน streak; 2 วันพอดียังได้', () => {
  const d = '2026-10-14';
  const mk = (createdAt) => {
    const w = new World();
    const c = { created_at: createdAt };
    w.food(d, 'เช้า', 700, 50, c);
    w.food(d, 'เย็น', 1300, 80, c);
    w.train(d, 4, 3, { extra: c, setExtra: c });
    w.body(d, { weight_kg: 80, steps: 9000 }, c);
    w.cardioFor(d, 20, c);
    return w.game('2026-10-25');
  };
  // 2 วันตามเวลาไทย (16 ต.ค. 23:59 ไทย) → ยังได้
  const ok = mk('2026-10-16T16:59:00.000Z');
  for (const r of ['workout', 'kcal', 'protein', 'steps', 'weigh', 'cardio']) assert.ok(coinsOf(ok, d, r) > 0, r);
  // 17 ต.ค. 00:00 ไทย = 3 วันหลังวันที่ → ไม่ได้ coin ใดๆ
  const late = mk('2026-10-16T17:00:00.000Z');
  assert.equal(dayItems(late, d).length, 0);
  assert.equal(late.earned, 0);
  // แต่ streak นับตามปกติ (14 ต.ค. ผ่าน เป็นวันฝึก)
  assert.equal(statusOf(late, d), 'pass');
  assert.equal(late.days.find((x) => x.date === d).run, 1);
});

test('ข้อมูลเก่าที่นำเข้า (created_at ใหม่กว่า date มาก) ไม่ได้ coin แต่ streak ทำงาน; created_at หาย/เพี้ยนไม่ได้ coin', () => {
  const w = new World();
  const imported = { created_at: '2026-10-18T10:00:00.000Z' };
  for (const d of ['2026-10-12', '2026-10-13', '2026-10-14']) {
    w.food(d, 'เช้า', 700, 50, imported);
    w.food(d, 'เย็น', 1300, 80, imported);
    w.train(d, 4, 3, { extra: imported, setExtra: imported });
  }
  const g = w.game('2026-10-15');
  assert.equal(g.earned, 0);
  assert.equal(g.streak.run, 3);
  const w2 = new World();
  w2.body('2026-10-14', { weight_kg: 80 }, { created_at: 'พัง' });
  assert.equal(w2.game('2026-10-15').earned, 0);
});

test('เซ็ตที่เพิ่มทีหลังเกิน 2 วันไม่นับ coin ฝึก (แต่ครั้งที่ฝึกนับเป็นวันฝึกของไฟ)', () => {
  const w = new World();
  const s = w.train('2026-10-13', 2, 2); // วันนั้นจด 2 ท่า 4 เซ็ต
  for (let e = 3; e <= 4; e++) w.sets.push(w.rec({ date: '2026-10-13', session_id: s.id, exercise_id: `ex${e}`, order: 0, weight_kg: 50, reps: 8, is_warmup: false, created_at: at('2026-10-20') }));
  const g = w.game('2026-10-25');
  assert.equal(coinsOf(g, '2026-10-13', 'workout'), 0);
  w.goodFood('2026-10-13');
  assert.equal(statusOf(w.game('2026-10-25'), '2026-10-13'), 'pass');
});

// ---------- คำนวณจาก log: ไม่ได้ coin ซ้ำ ----------

test('คำนวณซ้ำได้ค่าเดิมเสมอ และแก้ข้อมูลแล้วคำนวณใหม่ไม่ได้ coin ซ้ำ (ลดลงถ้าลบ, ไม่ซ้ำถ้าจดใหม่ทับ)', () => {
  const w = new World();
  w.goodFood('2026-10-13');
  const b = w.body('2026-10-13', { weight_kg: 80, steps: 9000 });
  const t = w.train('2026-10-13');
  const a1 = w.game('2026-10-15');
  const a2 = w.game('2026-10-15');
  assert.deepEqual(a1, a2);
  const base = a1.earned;
  assert.equal(base, 10 + 5 + 5 + 2 + 1);

  // แก้น้ำหนัก/ก้าวหลายรอบ (เป็นการแก้เรคคอร์ดเดิม) → ไม่ได้เพิ่ม
  for (const wt of [79, 78.5, 80]) {
    b.weight_kg = wt;
    b.updated_at = at('2026-10-14');
    assert.equal(w.game('2026-10-15').earned, base);
  }
  // แก้ก้าวต่ำกว่าเป้า → coin ก้าวหายไป
  b.steps = 3000;
  assert.equal(w.game('2026-10-15').earned, base - 2);
  b.steps = 9000;
  // ลบเซ็ตจนเหลือ 3 ท่า 9 เซ็ต → ยังถึง 8 เซ็ต ยังได้ 10
  w.sets.filter((x) => x.session_id === t.id && x.exercise_id === 'ex4').forEach((x) => (x.deleted = true));
  assert.equal(coinsOf(w.game('2026-10-15'), '2026-10-13', 'workout'), 10);
  // ลบครั้งที่ฝึกทั้งครั้ง → coin ฝึกหาย
  t.deleted = true;
  assert.equal(coinsOf(w.game('2026-10-15'), '2026-10-13', 'workout'), 0);
  // กู้คืน → กลับมาเท่าเดิม ไม่ซ้ำ
  t.deleted = false;
  w.sets.forEach((x) => (x.deleted = false));
  assert.equal(w.game('2026-10-15').earned, base);
});

test('แก้ log ย้อนหลังแล้วยอดติดลบ: แสดงตามจริง และห้ามแลกเพิ่ม', () => {
  const w = new World();
  w.goodFood('2026-10-13'); // protein 5 + (kcal 5 ถ้าจบวัน)
  w.redeem('2026-10-14', { coins: 8, price: 8, reward_id: 'cheap' });
  const before = w.game('2026-10-15');
  assert.equal(before.earned, 10);
  assert.equal(before.balance, 2);
  w.foodLogs.forEach((f) => (f.deleted = true)); // ลบ log ทั้งหมดย้อนหลัง
  const after = w.game('2026-10-15');
  assert.equal(after.earned, 0);
  assert.equal(after.balance, -8);
  const chk = checkRedeem({ reward: { id: 'free', price: 1, cooldown_days: 0, active: true }, balance: after.balance, redemptions: w.redemptions, today: '2026-10-15' });
  assert.equal(chk.ok, false);
  assert.equal(chk.code, 'negative');
  assert.match(chk.text, /ติดลบ/);
});

// ---------- ร้านแลกรางวัล ----------

const REWARD = { id: 'rw1', name: 'ชานม', emoji: '🧋', price: 60, kcal: 450, cooldown_days: 3, active: true, deleted: false };

test('checkRedeem: coin ไม่พอ / ติด cooldown (นับวัน) / ปิดใช้ / พร้อมแลก', () => {
  const ok = checkRedeem({ reward: REWARD, balance: 60, redemptions: [], today: '2026-10-15' });
  assert.equal(ok.ok, true);
  assert.equal(ok.price, 60);

  const poor = checkRedeem({ reward: REWARD, balance: 59, redemptions: [], today: '2026-10-15' });
  assert.equal(poor.ok, false);
  assert.equal(poor.code, 'insufficient');
  assert.match(poor.text, /ไม่พอ \(ขาดอีก 1\)/);

  const red = (date, extra = {}) => ({ id: `r${date}`, kind: 'reward', reward_id: 'rw1', date, deleted: false, coins: 60, ...extra });
  const cd = (today, redemptions) => checkRedeem({ reward: REWARD, balance: 500, redemptions, today });
  // แลกวันที่ 12 cooldown 3 วัน: 12→เหลือ 3, 13→2, 14→1, 15→แลกได้
  assert.equal(cd('2026-10-12', [red('2026-10-12')]).cooldownLeft, 3);
  assert.equal(cd('2026-10-13', [red('2026-10-12')]).cooldownLeft, 2);
  assert.match(cd('2026-10-13', [red('2026-10-12')]).text, /ติด cooldown อีก 2 วัน/);
  assert.equal(cd('2026-10-14', [red('2026-10-12')]).cooldownLeft, 1);
  assert.equal(cd('2026-10-15', [red('2026-10-12')]).ok, true);
  // รางวัลอื่น / ไฟสำรอง / รายการที่ยกเลิกแล้ว ไม่ทำให้ติด cooldown
  assert.equal(cd('2026-10-13', [red('2026-10-12', { reward_id: 'other' })]).ok, true);
  assert.equal(cd('2026-10-13', [red('2026-10-12', { kind: 'freeze', reward_id: null })]).ok, true);
  assert.equal(cd('2026-10-13', [red('2026-10-12', { deleted: true })]).ok, true);
  // cooldown 0 = แลกซ้ำวันเดียวกันได้
  assert.equal(checkRedeem({ reward: { ...REWARD, cooldown_days: 0 }, balance: 500, redemptions: [red('2026-10-13')], today: '2026-10-13' }).ok, true);
  // ทั้ง coin ไม่พอและ cooldown → แจ้งทั้งสองเหตุผล
  const both = checkRedeem({ reward: REWARD, balance: 10, redemptions: [red('2026-10-13')], today: '2026-10-14' });
  assert.deepEqual(both.reasons.map((r) => r.code), ['insufficient', 'cooldown']);
  // ปิดใช้
  assert.equal(checkRedeem({ reward: { ...REWARD, active: false }, balance: 500, redemptions: [], today: '2026-10-14' }).code, 'inactive');
});

function deviceStore(d) {
  return { create: (t, f) => d.create(t, f), update: (t, id, p) => d.update(t, id, p), remove: (t, id) => d.remove(t, id), uuid: () => crypto.randomUUID() };
}
function newDevice() {
  const clock = createClock('2026-10-15T05:00:00.000Z'); // 12:00 ไทย 15 ต.ค.
  const mock = createMockSupabase({ url: 'https://mock.supabase.test', key: 'sb_publishable_mock', clock: clock.now });
  return { clock, mock, config: { url: 'https://mock.supabase.test', publishableKey: 'sb_publishable_mock' } };
}
const live = (m) => [...m.values()].filter((r) => !r.deleted);

test('แลกรางวัล: หัก coin, snapshot ราคา, เพิ่มลงบันทึกการกิน (แก้ kcal ได้) และผูก food_log_id', async () => {
  const world = newDevice();
  const dev = createDevice({ ...world, name: 'A' });
  const store = deviceStore(dev);
  const w = new World();
  for (const d of dateRange('2026-10-06', '2026-10-14')) w.goodFood(d); // ได้ coin พอสมควร
  const earnedGame = () => computeGame({ asOf: '2026-10-15', profile: PROFILE, foodLogs: [...w.foodLogs, ...live(dev.tables.food_logs)], bodyLogs: [], sessions: [], sets: [], cardio: [], exercises: [], redemptions: live(dev.tables.redemptions) });
  const g0 = earnedGame();
  assert.ok(g0.balance >= 60);
  const { redemption, foodLog } = await redeemReward(store, { reward: REWARD, game: g0, redemptions: [], today: '2026-10-15', addFood: true, foodKcal: 400, meal: 'ของว่าง' });
  assert.equal(redemption.coins, 60);
  assert.equal(redemption.price, 60);
  assert.equal(redemption.kind, 'reward');
  assert.equal(redemption.reward_id, 'rw1');
  assert.equal(redemption.name, 'ชานม');
  assert.equal(redemption.kcal, 450);
  assert.equal(redemption.food_log_id, foodLog.id);
  assert.equal(foodLog.kcal, 400); // ใช้ค่าที่ผู้ใช้แก้
  assert.equal(foodLog.date, '2026-10-15');
  assert.equal(foodLog.quick, true);
  assert.match(foodLog.name, /ชานม/);
  const g1 = earnedGame();
  assert.equal(g1.balance, g0.balance - 60);
  assert.equal(g1.spent, 60);
  // ไม่เพิ่มลงบันทึกการกิน
  const r2 = await redeemReward(store, { reward: { ...REWARD, id: 'rw2', price: 20 }, game: g1, redemptions: live(dev.tables.redemptions), today: '2026-10-15', addFood: false });
  assert.equal(r2.foodLog, null);
  assert.equal(r2.redemption.food_log_id, null);
  // รางวัลที่ไม่ใช่ของกิน (kcal 0) ไม่ถามบันทึกการกิน
  const movie = { id: 'mv', name: 'ดูหนัง', emoji: '🎬', price: 10, kcal: 0, cooldown_days: 7, active: true };
  const r3 = await redeemReward(store, { reward: movie, game: earnedGame(), redemptions: live(dev.tables.redemptions), today: '2026-10-15', addFood: true });
  assert.equal(r3.foodLog, null);
  // snapshot: แก้ราคารางวัลทีหลังไม่กระทบประวัติ
  assert.equal(redemption.price, 60);
});

test('แลกไม่ผ่าน: coin ไม่พอ / cooldown / ยอดติดลบ → GameError และไม่เขียนอะไร', async () => {
  const dev = createDevice({ ...newDevice(), name: 'A' });
  const store = deviceStore(dev);
  const poor = { balance: 10, freeze: { held: false, price: 30 } };
  await assert.rejects(redeemReward(store, { reward: REWARD, game: poor, redemptions: [], today: '2026-10-15' }), (e) => e instanceof GameError && /ไม่พอ/.test(e.message));
  const rich = { balance: 500, freeze: { held: false, price: 30 } };
  const prior = [{ id: 'p', kind: 'reward', reward_id: 'rw1', date: '2026-10-14', deleted: false }];
  await assert.rejects(redeemReward(store, { reward: REWARD, game: rich, redemptions: prior, today: '2026-10-15' }), /cooldown อีก 2 วัน/);
  const neg = { balance: -5, freeze: { held: false, price: 30 } };
  await assert.rejects(redeemReward(store, { reward: { ...REWARD, price: 0 }, game: neg, redemptions: [], today: '2026-10-15' }), /ติดลบ/);
  assert.equal(dev.tables.redemptions.size, 0);
  assert.equal(dev.tables.food_logs.size, 0);
});

test('ยกเลิกการแลก: เฉพาะวันเดียวกัน, soft delete ทั้ง redemption และบันทึกการกินที่ผูก, coin คืน, ไม่ติด cooldown', async () => {
  const dev = createDevice({ ...newDevice(), name: 'A' });
  const store = deviceStore(dev);
  const game = { balance: 500, freeze: { held: false, price: 30 } };
  const { redemption, foodLog } = await redeemReward(store, { reward: REWARD, game, redemptions: [], today: '2026-10-15', addFood: true });
  assert.equal(canCancelRedemption(redemption, '2026-10-15'), true);
  assert.equal(canCancelRedemption(redemption, '2026-10-16'), false);
  await assert.rejects(cancelRedemption(store, redemption, { today: '2026-10-16' }), GameError);
  assert.equal(dev.tables.redemptions.get(redemption.id).deleted, false);

  await cancelRedemption(store, redemption, { today: '2026-10-15' });
  assert.equal(dev.tables.redemptions.get(redemption.id).deleted, true); // เรคคอร์ดยังอยู่ (soft delete) เพื่อซิงก์
  assert.equal(dev.tables.food_logs.get(foodLog.id).deleted, true);
  assert.ok(dev.dirty.has(`redemptions:${redemption.id}`) && dev.dirty.has(`food_logs:${foodLog.id}`));
  // ยอดคืน + ไม่ติด cooldown
  const g = computeGame({ asOf: '2026-10-15', profile: PROFILE, redemptions: live(dev.tables.redemptions), foodLogs: live(dev.tables.food_logs) });
  assert.equal(g.spent, 0);
  assert.equal(checkRedeem({ reward: REWARD, balance: 500, redemptions: live(dev.tables.redemptions), today: '2026-10-15' }).ok, true);
  // ยกเลิกซ้ำ / ที่บันทึกการกินถูกลบไปก่อนแล้ว ไม่พัง
  await cancelRedemption(store, { ...redemption, deleted: false }, { today: '2026-10-15' }).catch((e) => assert.fail(String(e)));
});

test('ซื้อไฟสำรอง: ราคาตามตั้งค่า, ถือได้ 1 อัน, ยกเลิกวันเดียวกันได้', async () => {
  const dev = createDevice({ ...newDevice(), name: 'A' });
  const store = deviceStore(dev);
  const w = new World();
  w.goodFood('2026-10-13');
  w.goodFood('2026-10-14');
  const mk = () => computeGame({ asOf: '2026-10-15', profile: PROFILE, foodLogs: w.foodLogs, redemptions: live(dev.tables.redemptions) });
  const g0 = mk();
  assert.equal(g0.balance, 20);
  await assert.rejects(buyFreeze(store, { game: g0, redemptions: [], today: '2026-10-15' }), /ไม่พอ/);
  const rich = { ...g0, balance: 100 };
  const rec = await buyFreeze(store, { game: rich, redemptions: [], today: '2026-10-15' });
  assert.equal(rec.kind, 'freeze');
  assert.equal(rec.coins, 30);
  const g1 = computeGame({ asOf: '2026-10-15', profile: PROFILE, foodLogs: w.foodLogs, redemptions: live(dev.tables.redemptions) });
  assert.equal(g1.freeze.held, true);
  await assert.rejects(buyFreeze(store, { game: { ...g1, balance: 999 }, redemptions: live(dev.tables.redemptions), today: '2026-10-15' }), /ถือไฟสำรองอยู่แล้ว/);
  await cancelRedemption(store, rec, { today: '2026-10-15' });
  const g2 = computeGame({ asOf: '2026-10-15', profile: PROFILE, foodLogs: w.foodLogs, redemptions: live(dev.tables.redemptions) });
  assert.equal(g2.freeze.held, false);
  // ราคาไฟสำรองแก้ได้
  assert.equal(normalizeSettings({ freeze_price: 45 }).freeze_price, 45);
  assert.equal(checkRedeem({ kind: 'freeze', balance: 44, today: '2026-10-15', freezePrice: 45 }).code, 'insufficient');
});

test('รางวัลตั้งต้น: ตามตารางในสเปค, id คงที่และไม่ซ้ำ, รางวัลที่ไม่ใช่ของกินเป็น "ดูหนัง 1 เรื่อง" 100/0/7', () => {
  const rows = seedRewards();
  assert.equal(rows.length, 5);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual([by['ชานมไข่มุก (หวานน้อย)'].price, by['ชานมไข่มุก (หวานน้อย)'].kcal, by['ชานมไข่มุก (หวานน้อย)'].cooldown_days], [60, 450, 3]);
  assert.deepEqual([by['ขนม/ของหวาน 1 อย่าง'].price, by['ขนม/ของหวาน 1 อย่าง'].kcal, by['ขนม/ของหวาน 1 อย่าง'].cooldown_days], [40, 300, 2]);
  assert.deepEqual([by['ชาบู/สุกี้บุฟเฟ่ต์'].price, by['ชาบู/สุกี้บุฟเฟ่ต์'].kcal, by['ชาบู/สุกี้บุฟเฟ่ต์'].cooldown_days], [150, 1200, 7]);
  assert.deepEqual([by['กินอะไรก็ได้ 1 มื้อ (cheat meal)'].price, by['กินอะไรก็ได้ 1 มื้อ (cheat meal)'].kcal, by['กินอะไรก็ได้ 1 มื้อ (cheat meal)'].cooldown_days], [200, 1500, 7]);
  assert.deepEqual([by['ดูหนัง 1 เรื่อง'].price, by['ดูหนัง 1 เรื่อง'].kcal, by['ดูหนัง 1 เรื่อง'].cooldown_days, by['ดูหนัง 1 เรื่อง'].emoji], [100, 0, 7, '🎬']);
  assert.equal(new Set(rows.map((r) => r.id)).size, 5);
  assert.deepEqual(rows.map((r) => r.id), seedRewards().map((r) => r.id)); // deterministic
  assert.equal(rows[0].id, seedId('reward', rows[0].name));
  for (const r of rows) assert.ok(r.active === true && r.deleted === false && r.created_at && r.updated_at);
  assert.ok(SEED_VERSION >= 2); // เครื่องเดิมที่ seed ไปแล้วต้อง seed รางวัลเพิ่มด้วย
});

test('คำแนะนำมื้อใหญ่: ≥800 kcal ขึ้นคำแนะนำ 100–150 kcal/วัน, ต่ำกว่านั้นไม่ขึ้น', () => {
  assert.match(bigMealAdvice(1200, null), /100–150 kcal\/วัน/);
  assert.ok(bigMealAdvice(800, null));
  assert.equal(bigMealAdvice(799, null), null);
  assert.equal(bigMealAdvice(0, null), null);
  assert.ok(bigMealAdvice(500, { big_meal_kcal: 400 }));
  assert.doesNotMatch(bigMealAdvice(1200, null), /ผิด|ห้าม|แย่/); // ไม่ทำให้รู้สึกผิด
});

// ---------- ไฟรายสัปดาห์ ----------

test('ไฟรายสัปดาห์: นับสัปดาห์ที่จบแล้วติดกัน รวมสัปดาห์ปัจจุบันถ้าครบแล้ว', () => {
  const w = new World();
  const week = (ws, n) => {
    for (let i = 0; i < n; i++) w.train(addDays(ws, i));
  };
  week('2026-09-21', 4); // ครบ
  week('2026-09-28', 3); // ไม่ครบ → ตัดสาย
  week('2026-10-05', 4); // ครบ
  week('2026-10-12', 2); // สัปดาห์ปัจจุบัน ยังไม่ครบ
  let g = w.game('2026-10-14');
  assert.equal(g.streak.weeks, 1); // สัปดาห์ 5 ต.ค. ครบ; 28 ก.ย. ไม่ครบ
  assert.equal(g.streak.weekCount, 2);
  w.train('2026-10-14'); w.train('2026-10-15');
  g = w.game('2026-10-15');
  assert.equal(g.streak.weekCount, 4);
  assert.equal(g.streak.weeks, 2); // 5 ต.ค. + สัปดาห์ปัจจุบันที่ครบแล้ว
  // เติมสัปดาห์ 28 ก.ย. ให้ครบ → 3 สัปดาห์ติด
  w.train('2026-10-01');
  assert.equal(w.game('2026-10-15').streak.weeks, 4);
});

// ---------- สิ่งที่วันนี้ยังได้อีก ----------

test('รายการ "วันนี้ยังได้อีก": โปรตีนอีก 30 ก. ได้ +5, ก้าวอีก, ชั่งน้ำหนัก, ฝึก, โบนัส', () => {
  const w = new World();
  w.food('2026-10-15', 'เช้า', 600, 90);
  w.body('2026-10-15', { steps: 5000 });
  const g = w.game('2026-10-15');
  const todo = Object.fromEntries(g.today.todo.map((t) => [t.reason, t]));
  assert.equal(todo.protein.text, 'โปรตีนอีก 30 ก.');
  assert.equal(todo.protein.coins, 5);
  assert.equal(todo.steps.text, 'ก้าวอีก 3000');
  assert.equal(todo.steps.coins, 2);
  assert.equal(todo.weigh.coins, 1);
  assert.equal(todo.workout.coins, 10);
  assert.equal(todo.cardio.coins, 3);
  assert.equal(todo.week_bonus.coins, 30);
  assert.equal(todo.kcal.pending, true);
  // ตัวคูณปัจจุบันมีผลกับยอดที่บอกล่วงหน้า
  const s = streakWorld('2026-09-07', 7).game('2026-09-14');
  assert.equal(s.streak.multiplier, 1.2);
  assert.equal(s.today.todo.find((t) => t.reason === 'workout').coins, 12);
  assert.equal(s.today.todo.find((t) => t.reason === 'week_bonus').coins, 30);
});

// ---------- มุมมอง coin_transactions ----------

test('coin_transactions เป็นมุมมองที่คำนวณขึ้น: รวมที่ได้ + ที่ใช้ เรียงใหม่ → เก่า และยอดรวมตรงกับ balance', () => {
  const w = streakWorld('2026-10-05', 7);
  w.redeem('2026-10-10', { coins: 40, price: 40, name: 'ขนม', emoji: '🍰', kcal: 300 });
  w.freeze('2026-10-11');
  const g = w.game('2026-10-12');
  const tx = coinTransactions(g, w.redemptions);
  assert.equal(tx.reduce((a, t) => a + t.amount, 0), g.balance);
  assert.equal(tx.filter((t) => t.kind === 'spend').length, 2);
  const dates = tx.map((t) => t.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  const spend = tx.find((t) => t.reason === 'redeem');
  assert.equal(spend.amount, -40);
  assert.match(spend.detail, /ขนม/);
  const groups = groupTransactions(tx);
  assert.equal(groups[0].date, '2026-10-11');
  assert.equal(groups.reduce((a, x) => a + x.total, 0), g.balance);
  assert.equal(new Set(groups.map((x) => x.date)).size, groups.length);
});

// ---------- ซิงก์ / ส่งออก ----------

test('ตารางเกมอยู่ในรายการซิงก์/ส่งออก พร้อมป้ายชื่อ และ id ของการตั้งค่าเกมคงที่คนละค่ากับโปรไฟล์', () => {
  for (const t of ['game_settings', 'rewards', 'redemptions']) {
    assert.ok(TABLES.includes(t), t);
    assert.ok(TABLE_LABELS[t], `${t} ต้องมีป้ายชื่อ (ใช้ในปุ่ม CSV)`);
  }
  assert.notEqual(GAME_SETTINGS_ID, PROFILE_ID);
  assert.match(GAME_SETTINGS_ID, /^[0-9a-f-]{36}$/);
  assert.ok(DATA_VERSION >= 2);
});

test('สองเครื่องซิงก์แล้วยอด coin/ไฟ/ไฟสำรองเท่ากัน (ผ่าน Supabase จำลอง) และไม่ได้ coin ซ้ำ', async () => {
  const world = newDevice();
  const user = await makeUser(world.mock);
  const a = createDevice({ ...world, name: 'A' });
  const b = createDevice({ ...world, name: 'B' });
  await a.login(user.email, user.password);
  await b.login(user.email, user.password);

  // เครื่อง A: โปรไฟล์ + ตั้งค่าเกม + log ของ 13–14 ต.ค.
  a.create('profile', { id: PROFILE_ID, ...PROFILE });
  a.create('game_settings', { id: GAME_SETTINGS_ID, ...DEFAULT_GAME_SETTINGS, coin_workout: 12 });
  for (const d of ['2026-10-13', '2026-10-14']) {
    world.clock.tick(1000);
    a.create('food_logs', { date: d, meal: 'เช้า', kcal: 700, protein: 50, quick: false });
    a.create('food_logs', { date: d, meal: 'เย็น', kcal: 1300, protein: 80, quick: false });
  }
  const ses = a.create('sessions', { date: '2026-10-14', day_name: 'Upper A', exercise_ids: [] });
  for (let e = 1; e <= 4; e++) a.create('sets', { session_id: ses.id, exercise_id: `ex${e}`, order: 0, weight_kg: 50, reps: 8, is_warmup: false });
  // เครื่อง B (ออฟไลน์ ยังไม่เห็นของ A): ซื้อไฟสำรอง + แลกรางวัล
  world.clock.tick(1000);
  const fz = b.create('redemptions', { date: '2026-10-14', kind: 'freeze', reward_id: null, name: 'ไฟสำรอง', emoji: '🧊', price: 30, coins: 30, kcal: 0, food_log_id: null });
  const rw = b.create('rewards', { name: 'ชานม', emoji: '🧋', price: 60, kcal: 450, cooldown_days: 3, active: true });

  for (let i = 0; i < 2; i++) {
    await a.sync.sync();
    await b.sync.sync();
    world.clock.tick(5000);
  }
  await a.sync.sync();
  const gameOf = (d) => {
    const rows = (t) => [...d.tables[t].values()];
    const profile = rows('profile')[0];
    const settings = rows('game_settings').find((r) => !r.deleted);
    return computeGame({ asOf: '2026-10-15', profile, settings, foodLogs: rows('food_logs'), bodyLogs: rows('body_logs'), sessions: rows('sessions'), sets: rows('sets'), cardio: rows('cardio'), exercises: [1, 2, 3, 4].map((i) => ({ id: `ex${i}`, name: `ท่า${i}` })), redemptions: rows('redemptions') });
  };
  const ga = gameOf(a);
  const gb = gameOf(b);
  assert.deepEqual(ga, gb); // ยอด ledger สถานะไฟ ไฟสำรอง เหมือนกันทุกอย่าง
  assert.equal(ga.freeze.held, true);
  assert.equal(coinsOf(ga, '2026-10-14', 'workout'), 12); // การตั้งค่าซิงก์มาด้วย
  assert.equal(ga.spent, 30);
  assert.equal(ga.balance, ga.earned - 30);
  // รางวัล/การแลก ข้ามเครื่องครบ
  assert.deepEqual(a.get('redemptions', fz.id), fz);
  assert.deepEqual(b.get('rewards', rw.id), rw);
  assert.deepEqual(a.get('rewards', rw.id), rw);
  assert.equal(a.dirty.size, 0);
  assert.equal(b.dirty.size, 0);

  // ซิงก์ซ้ำกี่รอบก็ไม่ได้ coin เพิ่ม
  for (let i = 0; i < 3; i++) {
    world.clock.tick(5000);
    await a.sync.sync();
    await b.sync.sync();
  }
  assert.equal(gameOf(a).earned, ga.earned);
  assert.equal(gameOf(b).balance, ga.balance);

  // เครื่อง B ยกเลิกการซื้อไฟสำรอง (soft delete) → ซิงก์ไป A ไฟสำรองหาย ยอดคืน
  world.clock.tick(5000);
  b.remove('redemptions', fz.id);
  await b.sync.sync();
  await a.sync.sync();
  assert.equal(gameOf(a).freeze.held, false);
  assert.equal(gameOf(a).spent, 0);
  assert.deepEqual(gameOf(a), gameOf(b));
});

test('ส่งออก/นำเข้า (JSON): ข้อมูลเกมครบ round-trip ผ่านตัวตรวจไฟล์ รวมรายการที่ soft delete', () => {
  const w = new World();
  const settings = { id: GAME_SETTINGS_ID, ...DEFAULT_GAME_SETTINGS, coin_workout: 15, training_days: [1, 3, 5], created_at: at('2026-10-10'), updated_at: at('2026-10-11'), deleted: false };
  const rewards = [...seedRewards(), { id: 'custom1', name: 'นวด', emoji: '💆', price: 300, kcal: 0, cooldown_days: 14, active: false, created_at: at('2026-10-10'), updated_at: at('2026-10-12'), deleted: true }];
  const redemptions = [
    w.redeem('2026-10-14', { reward_id: rewards[0].id, name: 'ชานม', price: 60, coins: 60, kcal: 450, food_log_id: 'f1' }),
    w.freeze('2026-10-15'),
    w.redeem('2026-10-15', { id: 'gone', deleted: true }),
  ];
  const tables = Object.fromEntries(TABLES.map((t) => [t, []]));
  Object.assign(tables, { game_settings: [settings], rewards, redemptions });
  const file = JSON.parse(JSON.stringify({ format: DATA_FORMAT, version: DATA_VERSION, exported_at: '2026-10-19T00:00:00.000Z', tables }));
  const out = validateImport(file);
  assert.deepEqual(out.game_settings, [settings]);
  assert.deepEqual(out.rewards, rewards);
  assert.deepEqual(out.redemptions, redemptions);
  assert.equal(out.redemptions.find((r) => r.id === 'gone').deleted, true);
  // วันที่เสียในประวัติการแลกต้องถูกปฏิเสธ (กันหน้าพัง)
  const bad = JSON.parse(JSON.stringify(file));
  bad.tables.redemptions[0].date = '2026-13-45';
  assert.throws(() => validateImport(bad), /redemptions.*date/);
  // ไฟล์ที่ไม่มีตารางเกม (สำรองจากรุ่นก่อน) นำเข้าได้
  const old = { format: DATA_FORMAT, version: 1, tables: { foods: [{ id: 'x', name: 'a' }] } };
  assert.deepEqual(Object.keys(validateImport(old)), ['foods']);
  // CSV ของตารางเกมได้ครบทุกคอลัมน์
  const csv = toCSV(redemptions);
  for (const col of ['date', 'kind', 'reward_id', 'name', 'emoji', 'price', 'coins', 'kcal', 'food_log_id']) assert.ok(csv.split('\r\n')[0].split(',').includes(col), col);
  assert.match(toCSV([settings]), /training_days/);
});

test('ผลคำนวณจากข้อมูลที่ round-trip แล้วเหมือนเดิม (ยอดไม่เปลี่ยนหลังส่งออกแล้วนำเข้า)', () => {
  const w = streakWorld('2026-10-05', 7);
  w.redeem('2026-10-10', { coins: 40, price: 40 });
  const g1 = w.game('2026-10-12');
  const roundTrip = (rows) => JSON.parse(JSON.stringify(rows));
  const g2 = computeGame({ asOf: '2026-10-12', profile: PROFILE, foodLogs: roundTrip(w.foodLogs), bodyLogs: [], sessions: roundTrip(w.sessions), sets: roundTrip(w.sets), cardio: [], exercises: roundTrip(w.exercises), redemptions: roundTrip(w.redemptions) });
  assert.deepEqual(g2, g1);
});

test('ไม่มีข้อมูลเลย / ข้อมูลผิดปกติ: ไม่พัง ยอดเป็น 0', () => {
  const empty = computeGame({ asOf: '2026-10-19', profile: {} });
  assert.equal(empty.balance, 0);
  assert.equal(empty.streak.display, 0);
  assert.ok(empty.today.todo.length > 0);
  assert.throws(() => computeGame({ asOf: 'พรุ่งนี้' }), /asOf/);
  const w = new World();
  w.foodLogs.push({ id: 'bad', date: 'x', meal: 'เช้า', kcal: 'abc', created_at: 'zzz', deleted: false });
  w.foodLogs.push({ id: 'future', date: '2026-12-31', meal: 'เช้า', kcal: 100, created_at: at('2026-12-31'), deleted: false });
  assert.equal(w.game('2026-10-19').earned, 0);
  // week helpers ยังทำงาน
  assert.equal(weekStart('2026-10-19'), '2026-10-19');
});
