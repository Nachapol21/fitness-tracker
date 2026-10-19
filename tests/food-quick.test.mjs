// ทดสอบ "จดการกินแบบกะเอา": ปุ่มกะ × ขนาด · kcal ไม่บังคับ (null) · ผลต่อเกม/วิเคราะห์/TDEE · ค้นหา · seed เมนูเพิ่ม · นำเข้า/CSV · ซิงก์ค่าปุ่ม
// ข้อมูลสมมติทั้งหมด · รัน: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOOD_PRESETS, QTY_OPTIONS, SIZE_OPTIONS, fillFromPreset, isKcalMissing, missingKcalLogs, nameOnlyLogFields, normText, presetAmounts, presetLogFields, recentDistinct, repeatLogFields, resolvePresets,
  scaleFood, searchFoods, sizeLabel, usageCounts, validatePresetValues,
} from '../js/food-quick.js';
import { dailyIntake, estimateTDEE, intakeSummary, cleanWeights, weeklySummary } from '../js/analytics.js';
import { computeGame } from '../js/game.js';
import { SEED_VERSION, planFoodSeed, seedFoods, seedFoodsExtra } from '../js/seed.js';
import { validateImport } from '../js/db.js';
import { csvRowsFor, toCSV } from '../js/csv.js';
import { DATA_FORMAT, DATA_VERSION, FOOD_PRESETS_ID, TABLES } from '../js/constants.js';
import { World, PROFILE, coinsOf, dayItems, statusOf } from './qa-game-helpers.mjs';
import { createMockSupabase } from './mock-supabase.mjs';
import { createClock, createDevice, makeUser } from './memory-device.mjs';

const P = Object.fromEntries(FOOD_PRESETS.map((p) => [p.key, p]));
const D = '2026-10-13'; // อังคาร

// ---------- 1) ปุ่มกะ × ขนาด ----------

test('ค่าเริ่มต้นของปุ่มกะตรงตามสเปค 6 ปุ่ม', () => {
  const table = { snack: [150, 5, 20, 6], light: [350, 18, 45, 10], normal: [550, 25, 70, 20], heavy: [800, 30, 90, 35], buffet: [1500, 70, 140, 70], drink: [250, 3, 45, 7] };
  assert.equal(FOOD_PRESETS.length, 6);
  for (const [key, [kcal, protein, carb, fat]] of Object.entries(table)) assert.deepEqual([P[key].kcal, P[key].protein, P[key].carb, P[key].fat], [kcal, protein, carb, fat], key);
  assert.deepEqual(SIZE_OPTIONS, [0.5, 1, 1.5]);
  assert.deepEqual(QTY_OPTIONS, [0.5, 1, 1.5, 2]);
  assert.deepEqual(QTY_OPTIONS.map(sizeLabel), ['½', '1', '1½', '2']);
});

test('ค่าปุ่ม × ขนาด (½ / 1 / 1½) คิดครบทั้ง kcal โปรตีน คาร์บ ไขมัน', () => {
  assert.deepEqual(presetAmounts(P.normal, 1), { kcal: 550, protein: 25, carb: 70, fat: 20 });
  assert.deepEqual(presetAmounts(P.normal, 0.5), { kcal: 275, protein: 12.5, carb: 35, fat: 10 });
  assert.deepEqual(presetAmounts(P.normal, 1.5), { kcal: 825, protein: 37.5, carb: 105, fat: 30 });
  assert.deepEqual(presetAmounts(P.buffet, 1.5), { kcal: 2250, protein: 105, carb: 210, fat: 105 });
  assert.deepEqual(presetAmounts(P.snack, 0.5), { kcal: 75, protein: 2.5, carb: 10, fat: 3 });
  // ขนาดผิดปกติ (0/ติดลบ/ไม่ใช่ตัวเลข) ใช้ 1 แทน ไม่ได้ค่า 0 หรือ NaN
  for (const bad of [0, -1, NaN, undefined, 'abc']) assert.equal(presetAmounts(P.drink, bad).kcal, 250);
  // ค่าที่ผู้ใช้แก้ในตั้งค่ามีผลกับการคูณ
  const custom = resolvePresets({ normal: { kcal: 600, protein: 30, carb: 70, fat: 22 } }).find((p) => p.key === 'normal');
  assert.equal(presetAmounts(custom, 1.5).kcal, 900);
  assert.equal(custom.customized, true);
});

test('บันทึกจากปุ่มกะ: is_estimate = true, estimate_preset = key, มีแคล/โปรตีน/คาร์บ/ไขมันครบ, ชื่อว่าง = ชื่อปุ่ม', () => {
  const f = presetLogFields({ preset: P.heavy, size: 1.5, name: '', date: D, meal: 'เย็น' });
  assert.equal(f.is_estimate, true);
  assert.equal(f.estimate_preset, 'heavy');
  assert.equal(f.kcal_missing, false);
  assert.equal(f.kcal, 1200);
  assert.equal(f.protein, 45);
  assert.equal(f.carb, 135);
  assert.equal(f.fat, 52.5);
  assert.equal(f.qty, 1.5);
  assert.equal(f.name, 'มื้อหนัก');
  assert.equal(f.date, D);
  assert.equal(f.meal, 'เย็น');
  assert.equal(f.food_id, null);
  assert.equal(presetLogFields({ preset: P.buffet, size: 1, name: '  ชาบูชิ  ', date: D, meal: 'เย็น' }).name, 'ชาบูชิ');
  assert.equal(isKcalMissing(f), false);
});

test('ตรวจค่าปุ่มที่ผู้ใช้แก้: ปฏิเสธ kcal ว่าง/0/ติดลบ/ไม่ใช่ตัวเลข · ค่าอื่นว่าง = 0 · ข้อมูลซิงก์เพี้ยนใช้ค่าเริ่มต้น', () => {
  assert.equal(validatePresetValues({ kcal: '', protein: 1 }).ok, false);
  assert.equal(validatePresetValues({ kcal: 0 }).ok, false);
  assert.equal(validatePresetValues({ kcal: -5 }).ok, false);
  assert.equal(validatePresetValues({ kcal: 'abc' }).ok, false);
  assert.equal(validatePresetValues({ kcal: 99999 }).ok, false);
  assert.deepEqual(validatePresetValues({ kcal: 400 }), { ok: true, value: { kcal: 400, protein: 0, carb: 0, fat: 0 } });
  const r = resolvePresets({ light: { kcal: 'เสีย' }, normal: null, snack: { kcal: 200, protein: 6, carb: 22, fat: 8 }, zzz: { kcal: 1 } });
  assert.equal(r.length, 6);
  assert.equal(r.find((p) => p.key === 'light').kcal, 350);
  assert.equal(r.find((p) => p.key === 'normal').kcal, 550);
  assert.equal(r.find((p) => p.key === 'snack').kcal, 200);
  assert.deepEqual(resolvePresets(undefined).map((p) => p.kcal), FOOD_PRESETS.map((p) => p.kcal));
  assert.deepEqual(resolvePresets('ขยะ').map((p) => p.kcal), FOOD_PRESETS.map((p) => p.kcal));
});

// ---------- 2) นิยาม "ยังไม่มีแคล" ----------

test('isKcalMissing: null/undefined/ว่าง/ธง kcal_missing = ยังไม่มีแคล · log เดิมที่มี kcal (รวม 0) ไม่ใช่', () => {
  assert.equal(isKcalMissing({ kcal: null }), true);
  assert.equal(isKcalMissing({}), true);
  assert.equal(isKcalMissing({ kcal: '' }), true);
  assert.equal(isKcalMissing({ kcal: 300, kcal_missing: true }), true);
  assert.equal(isKcalMissing({ kcal: 450 }), false);
  assert.equal(isKcalMissing({ kcal: 0 }), false);
  assert.equal(isKcalMissing({ kcal: 450, kcal_missing: false }), false);
  assert.equal(isKcalMissing(null), false);
  const n = nameOnlyLogFields({ name: ' ก๋วยเตี๋ยวเรือ ', date: D, meal: 'กลางวัน' });
  assert.equal(n.kcal, null);
  assert.equal(n.kcal_missing, true);
  assert.equal(n.is_estimate, false);
  assert.equal(n.name, 'ก๋วยเตี๋ยวเรือ');
  assert.equal(isKcalMissing(n), true);
});

test('เติมแคลจากปุ่มกะ: ได้ค่าครบ + is_estimate + kcal_missing = false', () => {
  const f = fillFromPreset(P.light, 1.5);
  assert.deepEqual([f.kcal, f.protein, f.carb, f.fat], [525, 27, 67.5, 15]);
  assert.equal(f.kcal_missing, false);
  assert.equal(f.is_estimate, true);
  assert.equal(f.estimate_preset, 'light');
  assert.equal(isKcalMissing({ ...nameOnlyLogFields({ name: 'x', date: D, meal: 'เช้า' }), ...f }), false);
});

test('missingKcalLogs: เลือกเฉพาะมื้อที่ไม่มีแคลในช่วงวันที่ (7 วันล่าสุด) เรียงใหม่ → เก่า ไม่รวมที่ลบแล้ว', () => {
  const mk = (id, date, kcal, extra = {}) => ({ id, date, kcal, created_at: `${date}T05:00:00.000Z`, ...extra });
  const logs = [mk('a', '2026-10-13', null), mk('b', '2026-10-17', null), mk('c', '2026-10-17', 400), mk('d', '2026-10-06', null), mk('e', '2026-10-15', 100, { kcal_missing: true }), mk('f', '2026-10-16', null, { deleted: true })];
  assert.deepEqual(missingKcalLogs(logs, '2026-10-13', '2026-10-19').map((l) => l.id), ['b', 'e', 'a']);
  assert.deepEqual(missingKcalLogs(logs).map((l) => l.id), ['b', 'e', 'a', 'd']);
  assert.deepEqual(missingKcalLogs([], '2026-10-13', '2026-10-19'), []);
});

// ---------- 3) kcal = null ไม่ทำให้ analytics/เกมล่ม ----------

const weirdLogs = () => [
  { id: '1', date: D, meal: 'เช้า', name: 'ก', kcal: null, protein: 0, carb: 0, fat: 0, kcal_missing: true, deleted: false },
  { id: '2', date: D, meal: 'กลางวัน', name: 'ข', kcal: undefined, protein: undefined, deleted: false },
  { id: '3', date: D, meal: 'เย็น', name: 'ค', kcal: 'abc', protein: 'x', deleted: false },
  { id: '4', date: D, meal: 'เย็น', name: 'ง', kcal: '', deleted: false },
  { id: '5', date: '2026-10-14', meal: 'เช้า', name: 'จ', kcal: 500, protein: 30, carb: 50, fat: 10, deleted: false },
];

test('kcal = null/undefined/ว่าง/ไม่ใช่ตัวเลข ไม่ทำให้ analytics และเกมล่ม', () => {
  const logs = weirdLogs();
  const daily = dailyIntake(logs);
  assert.ok(Number.isFinite(daily[D].kcal));
  assert.equal(daily[D].missing, 3); // null / undefined / '' = ยังไม่มีแคล ('abc' ถือเป็นเลขเสีย นับ 0 แบบเดิม)
  assert.equal(daily['2026-10-14'].missing, 0);
  const sum = intakeSummary(daily, { kcal: 2000, protein_min: 100 }, [D, '2026-10-14', '2026-10-15']);
  assert.equal(sum.loggedDays, 2);
  assert.equal(sum.incompleteDays, 1);
  assert.equal(sum.completeDays, 1);
  assert.equal(sum.days[0].incomplete, true);
  assert.equal(sum.days[0].kcalOk, null);
  assert.ok(Number.isFinite(sum.avgKcal));
  assert.doesNotThrow(() => weeklySummary({ ws: '2026-10-12', asOf: '2026-10-19', bodyLogs: [], foodLogs: logs, sessions: [], sets: [], cardio: [], exercises: [], profile: { kcal: 2000, protein_min: 100 } }));
  const g = computeGame({ asOf: '2026-10-15', profile: PROFILE, foodLogs: logs, bodyLogs: [], sessions: [], sets: [], cardio: [], exercises: [], redemptions: [] });
  assert.ok(Number.isFinite(g.balance));
  assert.equal(g.days.find((d) => d.date === D).status, 'miss');
  // ทุกมื้อไม่มีแคลหมด: ไม่ล้ม ไม่ได้ coin แคลอรี่
  const only = new World();
  only.food(D, 'เช้า', null, 0, { kcal_missing: true });
  const og = only.game('2026-10-14');
  assert.equal(coinsOf(og, D, 'kcal'), 0);
  assert.doesNotThrow(() => estimateTDEE([], dailyIntake(only.foodLogs), {}, { asOf: '2026-10-14' }));
});

test('วิเคราะห์รายสัปดาห์: ไม่มีค่าเฉลี่ยแคล (ทุกวันไม่ครบ) ต้องไม่ขึ้นคำแนะนำ "ต่ำกว่าเป้า" ลวงๆ แต่บอกให้เติมแคล', () => {
  const logs = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'].map((date, i) => ({ id: `m${i}`, date, meal: 'เช้า', kcal: null, kcal_missing: true, protein: 0, deleted: false }));
  const s = weeklySummary({ ws: '2026-10-12', asOf: '2026-10-19', bodyLogs: [], foodLogs: logs, sessions: [], sets: [], cardio: [], exercises: [], profile: { kcal: 2000, kcal_tolerance: 100, protein_min: 120 } });
  assert.equal(s.intake.avgKcal, null);
  assert.equal(s.intake.incompleteDays, 5);
  assert.ok(!s.advice.some((a) => a.includes('ต่ำกว่าเป้า')), s.advice.join(' | '));
  assert.ok(s.advice.some((a) => a.includes('ยังมีมื้อไม่มีแคล')));
});

// ---------- 4) เกม: วันที่ไม่มีแคลไม่ได้ coin แคลอรี่ เติมแล้วได้คืน ----------

test('เกม: วันที่ยังมีมื้อไม่มีแคลไม่ได้ coin แคลอรี่และไฟไม่ผ่าน · เติมแคลแล้ว coin กับไฟของวันนั้นกลับมา (คำนวณใหม่เอง)', () => {
  const w = new World();
  w.food(D, 'เช้า', 700, 50);
  const missing = w.food(D, 'เย็น', null, 0, { kcal_missing: true, quick: true });
  let g = w.game('2026-10-14');
  assert.equal(coinsOf(g, D, 'kcal'), 0);
  assert.equal(statusOf(g, D), 'miss'); // เงื่อนไขแคลอรี่ของไฟยังไม่ผ่าน
  assert.equal(g.streak.run, 0);
  // เติมแคลย้อนหลัง (แก้เรคคอร์ดเดิม created_at ไม่เปลี่ยน): 700 + 1300 = 2000 ในช่วง 1900–2100
  Object.assign(missing, { kcal: 1300, protein: 80, kcal_missing: false, is_estimate: true, estimate_preset: 'heavy' });
  g = w.game('2026-10-14');
  assert.equal(coinsOf(g, D, 'kcal'), 5);
  assert.equal(coinsOf(g, D, 'protein'), 5); // 50 + 80 = 130 ≥ 120
  assert.equal(statusOf(g, D), 'pass');
  assert.equal(g.streak.run, 1);
  // ตัวเดียวกับวันที่จดครบแต่แรก (ไม่มีส่วนต่าง)
  const ref = new World();
  ref.goodFood(D);
  assert.equal(ref.game('2026-10-14').earned, g.earned);
});

test('เกม: ยังไม่มีแคลทั้งที่ยอดมื้ออื่นอยู่ในช่วงเป้าแล้ว ก็ยังไม่ได้ coin แคลอรี่ (ยอดไม่ครบ) · มื้อนั้นไม่นับโปรตีนแม้พิมพ์โปรตีนไว้ · โปรตีนจากมื้ออื่นถึงเป้ายังได้ coin', () => {
  const w = new World();
  w.food(D, 'เช้า', 1000, 70);
  w.food(D, 'กลางวัน', 1000, 60);
  w.food(D, 'เย็น', null, 200, { kcal_missing: true }); // โปรตีน 200 ต้องไม่ถูกนับ
  const g = w.game('2026-10-14');
  assert.equal(coinsOf(g, D, 'kcal'), 0);
  assert.equal(statusOf(g, D), 'miss');
  assert.equal(coinsOf(g, D, 'protein'), 5); // 70 + 60 = 130 ≥ 120 จากมื้ออื่น
  const w2 = new World();
  w2.food(D, 'เช้า', 1000, 50);
  w2.food(D, 'เย็น', null, 200, { kcal_missing: true });
  assert.equal(coinsOf(w2.game('2026-10-14'), D, 'protein'), 0); // 50 < 120 (ไม่เอา 200 ของมื้อที่ไม่มีแคลมานับ)
});

test('เกม: มื้อไม่มีแคลที่จดย้อนหลังนาน (ไม่สด) ก็ทำให้วันนั้นไม่ครบ · วันอื่นไม่กระทบ', () => {
  const w = new World();
  w.goodFood(D);
  w.food(D, 'ของว่าง', null, 0, { kcal_missing: true, created_at: '2026-10-20T05:00:00.000Z' }); // จดทีหลัง 7 วัน
  w.goodFood('2026-10-14');
  const g = w.game('2026-10-21');
  assert.equal(coinsOf(g, D, 'kcal'), 0);
  assert.equal(coinsOf(g, '2026-10-14', 'kcal'), 5);
});

test('เกม: "วันนี้ยังได้อีก" บอกให้เติมแคลอีก N มื้อ เพื่อนับ coin แคลอรี่ · ไม่มีมื้อค้าง = ข้อความเดิม', () => {
  const w = new World();
  w.food(D, 'เช้า', 700, 50);
  w.food(D, 'กลางวัน', null, 0, { kcal_missing: true });
  w.food(D, 'เย็น', null, 0, { kcal_missing: true });
  let g = w.game(D);
  const todo = g.today.todo.find((t) => t.reason === 'kcal');
  assert.equal(todo.text, 'เติมแคลอีก 2 มื้อเพื่อนับ coin แคลอรี่');
  assert.equal(todo.coins, 5);
  assert.equal(g.today.missingKcalMeals, 2);
  assert.equal(g.today.kcalInRange, false);
  assert.equal(g.streak.todayStatus, 'open');
  for (const l of w.foodLogs) if (l.kcal === null) Object.assign(l, { kcal: 650, kcal_missing: false });
  g = w.game(D);
  assert.equal(g.today.missingKcalMeals, 0);
  assert.ok(!g.today.todo.find((t) => t.reason === 'kcal').text.includes('เติมแคล'));
  assert.equal(g.today.kcalInRange, true); // 700 + 650 + 650 = 2000
});

test('เกม: บันทึกจากปุ่มกะ (is_estimate) นับเป็นการจดปกติ ได้ coin แคลอรี่/โปรตีนและไฟเหมือนจดละเอียด', () => {
  const w = new World();
  const mk = (preset, size, meal) => {
    const f = presetLogFields({ preset, size, date: D, meal });
    w.food(D, meal, f.kcal, f.protein, { is_estimate: true, estimate_preset: f.estimate_preset, kcal_missing: false, quick: true, qty: f.qty });
  };
  mk(P.light, 1, 'เช้า'); // 350 / 18
  mk(P.heavy, 1, 'กลางวัน'); // 800 / 30
  mk(P.heavy, 1, 'เย็น'); // 800 / 30 → 1950 kcal, โปรตีน 78
  mk(P.drink, 1, 'ของว่าง'); // 250 / 3 → 2200 รวม (เกินช่วง)
  let g = w.game('2026-10-14');
  assert.equal(coinsOf(g, D, 'kcal'), 0); // 2200 เกิน 2100
  const w2 = new World();
  for (const [preset, meal] of [[P.light, 'เช้า'], [P.heavy, 'กลางวัน'], [P.heavy, 'เย็น']]) {
    const f = presetLogFields({ preset, size: 1, date: D, meal });
    w2.food(D, meal, f.kcal, f.protein, { is_estimate: true, estimate_preset: f.estimate_preset, kcal_missing: false, quick: true });
  }
  g = w2.game('2026-10-14');
  assert.equal(coinsOf(g, D, 'kcal'), 5); // 350 + 800 + 800 = 1950
  assert.equal(statusOf(g, D), 'pass');
  assert.deepEqual(dayItems(g, D).map((i) => i.reason).filter((r) => r === 'kcal'), ['kcal']);
});

// ---------- 5) วิเคราะห์: ยอดรวมรายวัน + TDEE ตัดวันที่ไม่ครบ ----------

test('ยอดรวมรายวัน: มื้อไม่มีแคลไม่นับแคล/โปรตีน/คาร์บ/ไขมัน และบอกจำนวนมื้อที่ไม่มี (ใช้แสดง "≥ 1,200 kcal · ยังไม่มีแคล 1 มื้อ")', () => {
  const logs = [
    { id: 'a', date: D, meal: 'เช้า', kcal: 500, protein: 30, carb: 40, fat: 10, deleted: false },
    { id: 'b', date: D, meal: 'กลางวัน', kcal: 700, protein: 40, carb: 80, fat: 20, deleted: false },
    { id: 'c', date: D, meal: 'เย็น', kcal: null, protein: 99, carb: 99, fat: 99, kcal_missing: true, deleted: false },
  ];
  const d = dailyIntake(logs)[D];
  assert.deepEqual([d.kcal, d.protein, d.carb, d.fat, d.entries, d.missing], [1200, 70, 120, 30, 3, 1]);
});

function tdeeWorld({ partialDays = [] } = {}) {
  const logs = [];
  const body = [];
  for (let i = 0; i < 28; i++) {
    const date = `2026-10-${String(i + 1).padStart(2, '0')}`;
    if (partialDays.includes(date)) {
      logs.push({ id: `p${i}`, date, meal: 'เช้า', kcal: 900, protein: 40, deleted: false }, { id: `q${i}`, date, meal: 'เย็น', kcal: null, kcal_missing: true, deleted: false });
    } else logs.push({ id: `f${i}`, date, meal: 'เช้า', kcal: 2000, protein: 120, deleted: false });
    if (i % 3 === 0) body.push({ id: `b${i}`, date, weight_kg: 80 - i * 0.05, deleted: false, updated_at: date });
  }
  return { daily: dailyIntake(logs), points: cleanWeights(body) };
}

test('ประมาณ TDEE จริงตัดวันที่แคลไม่ครบออก: ค่าเฉลี่ยไม่ถูกดึงต่ำด้วยยอดบางส่วน', () => {
  const { daily, points } = tdeeWorld();
  const ok = estimateTDEE(points, daily, { goal: 'lose', rate_kg_week: 0.5 }, { asOf: '2026-10-28' });
  assert.equal(ok.ok, true);
  assert.equal(ok.avgIntake, 2000);
  assert.equal(ok.usedDays, 28);

  const partial = ['2026-10-05', '2026-10-08', '2026-10-11', '2026-10-14', '2026-10-20'];
  const t = tdeeWorld({ partialDays: partial });
  const est = estimateTDEE(t.points, t.daily, { goal: 'lose', rate_kg_week: 0.5 }, { asOf: '2026-10-28' });
  assert.equal(est.ok, true);
  assert.equal(est.avgIntake, 2000); // ถ้านับวันไม่ครบด้วย (900) ค่าเฉลี่ยจะต่ำกว่า 2000
  assert.equal(est.usedDays, 23);
  assert.equal(est.incompleteDays, 5);
});

test('ประมาณ TDEE จริง: ถ้าตัดวันไม่ครบแล้วเหลือน้อยกว่า 14 วัน = ข้อมูลยังไม่พอ และบอกจำนวนวันที่ถูกตัด', () => {
  const partial = Array.from({ length: 15 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  const t = tdeeWorld({ partialDays: partial });
  const est = estimateTDEE(t.points, t.daily, {}, { asOf: '2026-10-28' });
  assert.equal(est.ok, false);
  assert.equal(est.loggedDays, 13);
  assert.equal(est.incompleteDays, 15);
});

// ---------- 6) ค้นหา ----------

const foodsFor = (names, extra = {}) => names.map((name, i) => ({ id: `f${i}`, name, serving: '1 จาน', kcal: 500, protein: 20, carb: 60, fat: 15, favorite: false, deleted: false, ...(extra[name] || {}) }));

test('ค้นหาด้วยคำบางส่วนภาษาไทย: "กะเพรา" เจอทุกเมนูที่มีคำนี้ ไม่สนช่องว่าง/ตัวพิมพ์/วงเล็บ', () => {
  const foods = foodsFor(['ข้าวกะเพราไก่ (ไม่มีไข่)', 'ข้าวกะเพราหมูสับ', 'ข้าวกะเพราหมูกรอบ', 'ผัดไทย', 'กะเพราไก่ + ไข่ดาว', 'ข้าวคลุกกะปิ', 'Protein Shake']);
  const hit = (q) => searchFoods(foods, q).map((f) => f.name).sort();
  assert.deepEqual(hit('กะเพรา'), ['กะเพราไก่ + ไข่ดาว', 'ข้าวกะเพราไก่ (ไม่มีไข่)', 'ข้าวกะเพราหมูกรอบ', 'ข้าวกะเพราหมูสับ'].sort());
  assert.deepEqual(hit('ข้าว กะเพรา'), ['ข้าวกะเพราไก่ (ไม่มีไข่)', 'ข้าวกะเพราหมูกรอบ', 'ข้าวกะเพราหมูสับ'].sort()); // ช่องว่างในคำค้นไม่ทำให้พลาด
  assert.deepEqual(hit('  กะ เพ รา  ').length, 4);
  assert.deepEqual(hit('ไม่มีไข่'), ['ข้าวกะเพราไก่ (ไม่มีไข่)']);
  assert.deepEqual(hit('PROTEIN shake'), ['Protein Shake']);
  assert.equal(hit('').length, foods.length); // ว่าง = ทั้งหมด
  assert.deepEqual(hit('ไม่มีเมนูนี้'), []);
  assert.deepEqual(searchFoods([{ id: 'x', name: 'ข้าวกะเพรา', deleted: true }], 'กะเพรา'), []); // ไม่เอาที่ลบแล้ว
});

test('ค้นหากับเมนูตั้งต้นจริง: "กะเพรา" เจอทุกเมนูที่ชื่อมีคำนี้ (เดิม + เพิ่มใหม่)', () => {
  const all = planFoodSeed([]).add;
  const expected = all.filter((f) => f.name.includes('กะเพรา')).map((f) => f.name).sort();
  assert.ok(expected.length >= 4, `เมนูกะเพรา ${expected.length}`);
  assert.deepEqual(searchFoods(all, 'กะเพรา').map((f) => f.name).sort(), expected);
  assert.ok(searchFoods(all, 'กะเพรา').some((f) => f.name === 'ข้าวกะเพราหมูสับ')); // เมนูที่เพิ่มรอบนี้
});

test('ผลค้นหาเรียงรายการโปรดก่อน แล้วรายการที่ใช้บ่อย (มากไปน้อย) แล้วที่เหลือตามตัวอักษร', () => {
  const foods = foodsFor(['ข้าวมันไก่ก', 'ข้าวมันไก่ข', 'ข้าวมันไก่ค', 'ข้าวมันไก่ง', 'ข้าวมันไก่จ'], { ข้าวมันไก่จ: { favorite: true }, ข้าวมันไก่ง: { favorite: true } });
  const logs = [
    ...['f2', 'f2', 'f2'].map((food_id, i) => ({ id: `l${i}`, food_id })),
    ...['f1'].map((food_id) => ({ id: 'm1', food_id })),
    { id: 'n1', food_id: 'f4' }, { id: 'n2', food_id: 'f4' }, { id: 'n3', food_id: 'f4' }, { id: 'n4', food_id: 'f4' }, // โปรดและใช้เยอะ
    { id: 'z', food_id: 'f0', deleted: true }, // ที่ลบแล้วไม่นับ
  ];
  const usage = usageCounts(logs);
  assert.equal(usage.get('f2'), 3);
  assert.equal(usage.has('f0'), false);
  const order = searchFoods(foods, 'ข้าวมัน', usage).map((f) => f.name);
  assert.deepEqual(order, ['ข้าวมันไก่จ', 'ข้าวมันไก่ง', 'ข้าวมันไก่ค', 'ข้าวมันไก่ข', 'ข้าวมันไก่ก']);
  // ไม่มีประวัติการใช้: โปรดก่อน ที่เหลือเรียงตามตัวอักษร
  assert.deepEqual(searchFoods(foods, '').map((f) => f.name), ['ข้าวมันไก่ง', 'ข้าวมันไก่จ', 'ข้าวมันไก่ก', 'ข้าวมันไก่ข', 'ข้าวมันไก่ค']);
});

test('normText: ตัดช่องว่าง วงเล็บ ตัวพิมพ์', () => {
  assert.equal(normText(' ข้าวกะเพราไก่ (ไม่มีไข่) '), 'ข้าวกะเพราไก่ไม่มีไข่');
  assert.equal(normText('Protein  SHAKE'), 'proteinshake');
  assert.equal(normText(null), '');
  assert.equal(normText('ข้าวผัด[หมู]'), normText('ข้าวผัดหมู'));
});

// ---------- 7) จำนวน ½/1/1½/2 ----------

test('จำนวนที่ของเมนูในคลัง ½ / 1 / 1½ / 2 คูณค่าทั้งสี่ตัว', () => {
  const food = { kcal: 550, protein: 25, carb: 70, fat: 18 };
  assert.deepEqual(QTY_OPTIONS.map((q) => scaleFood(food, q).kcal), [275, 550, 825, 1100]);
  assert.deepEqual(scaleFood(food, 0.5), { kcal: 275, protein: 12.5, carb: 35, fat: 9 });
  assert.deepEqual(scaleFood(food, 2), { kcal: 1100, protein: 50, carb: 140, fat: 36 });
  assert.deepEqual(scaleFood({ kcal: 75, protein: 6.5, carb: 0.5, fat: 5 }, 1.5), { kcal: 112.5, protein: 9.8, carb: 0.8, fat: 7.5 });
  assert.deepEqual(scaleFood({ kcal: null }, 2), { kcal: 0, protein: 0, carb: 0, fat: 0 }); // คลังที่ค่าเสียไม่ทำให้ NaN
});

// ---------- 8) seed เมนูเพิ่ม ----------

const EXPECTED_DUPES = ['ข้าวเหนียว', 'หมูปิ้ง', 'ทูน่ากระป๋องในน้ำแร่', 'ไข่เจียว', 'แอปเปิ้ล'];

test('seed เมนูเพิ่ม: 73 รายการ เพิ่ม 68 ข้าม 5 ที่ซ้ำกับ seed เดิม · SEED_VERSION ถูกขึ้น', () => {
  assert.ok(SEED_VERSION >= 3);
  const extra = seedFoodsExtra();
  assert.equal(extra.length, 73);
  const plan = planFoodSeed([]);
  const base = seedFoods();
  assert.equal(plan.add.length, base.length + 68);
  assert.deepEqual(plan.skipped.map((s) => s.name).sort(), [...EXPECTED_DUPES].sort());
  assert.ok(plan.skipped.every((s) => s.reason === 'seed'));
  // ไม่มีชื่อซ้ำ (normalize แล้ว) และ id ไม่ซ้ำ
  const names = plan.add.map((f) => normText(f.name));
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(plan.add.map((f) => f.id)).size, plan.add.length);
  // รูปแบบเดียวกับ seed เดิม: ค่าประมาณ, id คงที่, ไม่ใช่รายการโปรด
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const f of extra) {
    assert.match(f.id, uuidRe);
    assert.equal(f.estimated, true);
    assert.equal(f.favorite, false);
    assert.equal(f.deleted, false);
    assert.ok(f.kcal >= 0 && f.protein >= 0 && f.carb >= 0 && f.fat >= 0, f.name);
  }
  assert.deepEqual(planFoodSeed([]).add.map((f) => f.id), planFoodSeed([]).add.map((f) => f.id)); // ได้ id เดิมทุกครั้ง
  // ค่าตรงกับ foods.md บางรายการ (ตัวอย่างที่มีเลขหลักพัน/ทศนิยม)
  const by = Object.fromEntries(extra.map((f) => [f.name, f]));
  assert.deepEqual([by['ชาบูชิ กินเยอะ'].kcal, by['ชาบูชิ กินเยอะ'].protein, by['ชาบูชิ กินเยอะ'].carb, by['ชาบูชิ กินเยอะ'].fat], [1700, 70, 200, 65]);
  assert.equal(by['ข้าวกะเพราหมูสับ'].kcal, 600);
});

test('seed เมนูเพิ่ม: อัปเกรดจาก v2 (มี seed เดิมอยู่แล้ว) เพิ่มเฉพาะเมนูใหม่ ไม่ซ้ำ และไม่แตะของเดิม', () => {
  const existing = seedFoods().map((f) => ({ ...f, favorite: true })); // ผู้ใช้ตั้งโปรดไว้
  const plan = planFoodSeed(existing);
  assert.equal(plan.add.length, 68);
  assert.ok(plan.add.every((f) => !existing.some((e) => e.id === f.id)));
  assert.deepEqual(plan.skipped.map((s) => s.name).sort(), [...EXPECTED_DUPES].sort());
});

test('seed เมนูเพิ่ม: ข้ามถ้าชื่อซ้ำกับอาหารที่ผู้ใช้สร้างเอง (normalize ช่องว่าง วงเล็บ ตัวพิมพ์) และไม่ใส่ซ้ำสองรอบ', () => {
  const user = [
    { id: 'u1', name: 'ข้าวไก่กรอบ เทอริยากิ', deleted: false }, // ช่องว่างต่างจากเมนู "ข้าวไก่กรอบเทอริยากิ"
    { id: 'u2', name: 'ข้าวหน้าไก่เทอริยากิ ย่าง ไม่ทอด', deleted: false }, // ไม่มีวงเล็บ
    { id: 'u3', name: 'PIZZA', deleted: false },
    { id: 'u4', name: 'พิซซ่า', deleted: false },
    { id: 'u5', name: 'เบอร์เกอร์ฟาสต์ฟู้ด', deleted: true }, // ผู้ใช้สร้างแล้วลบ: ไม่เอากลับมา
    { id: 'u6', name: 'ลาบหมู', deleted: false },
  ];
  const plan = planFoodSeed([...seedFoods(), ...user]);
  const skippedByUser = plan.skipped.filter((s) => s.reason === 'user').map((s) => s.name).sort();
  assert.deepEqual(skippedByUser, ['ข้าวไก่กรอบเทอริยากิ', 'ข้าวหน้าไก่เทอริยากิ (ย่าง ไม่ทอด)', 'พิซซ่า', 'เบอร์เกอร์ฟาสต์ฟู้ด', 'ลาบหมู'].sort());
  const addedNames = new Set(plan.add.map((f) => f.name));
  for (const n of skippedByUser) assert.ok(!addedNames.has(n), n);
  assert.equal(plan.add.length, 68 - 5);
  // วางแผนซ้ำหลังเพิ่มแล้ว (เช่น ซิงก์มาจากอีกเครื่อง) ไม่เพิ่มอะไรอีก
  const again = planFoodSeed([...seedFoods(), ...user, ...plan.add]);
  assert.equal(again.add.length, 0);
});

// ---------- 9) นำเข้าไฟล์เก่า/ใหม่ + CSV ----------

const importFile = (food_logs, version = DATA_VERSION) => ({ format: DATA_FORMAT, version, exported_at: '2026-10-19T00:00:00.000Z', tables: { food_logs } });
const oldLog = { id: 'old1', created_at: '2026-10-10T05:00:00.000Z', updated_at: '2026-10-10T05:00:00.000Z', deleted: false, date: '2026-10-10', meal: 'เช้า', food_id: null, name: 'ข้าวมันไก่', serving: '', qty: 1, kcal: 600, protein: 25, carb: 75, fat: 22, quick: false };
const newLogs = [
  { ...oldLog, id: 'new1', name: 'ก๋วยเตี๋ยวเรือ', kcal: null, protein: 0, carb: 0, fat: 0, quick: true, is_estimate: false, estimate_preset: null, kcal_missing: true },
  { ...oldLog, id: 'new2', name: 'ชาบูชิ', kcal: 1500, protein: 70, carb: 140, fat: 70, quick: true, is_estimate: true, estimate_preset: 'buffet', kcal_missing: false },
];

test('validateImport: รับไฟล์เก่า (ไม่มีฟิลด์ใหม่) และไฟล์ใหม่ (kcal = null + is_estimate/estimate_preset/kcal_missing) โดยไม่ดัดแปลงค่า', () => {
  const old = validateImport(importFile([oldLog]));
  assert.equal(old.food_logs[0].kcal, 600);
  assert.equal('is_estimate' in old.food_logs[0], false);
  assert.equal(isKcalMissing(old.food_logs[0]), false); // ไฟล์เก่าทำงานเหมือนเดิม
  const neu = validateImport(JSON.parse(JSON.stringify(importFile(newLogs)))); // ผ่าน JSON จริง (null ต้องไม่หาย)
  assert.equal(neu.food_logs[0].kcal, null);
  assert.equal(neu.food_logs[0].kcal_missing, true);
  assert.equal(neu.food_logs[1].is_estimate, true);
  assert.equal(neu.food_logs[1].estimate_preset, 'buffet');
  assert.equal(isKcalMissing(neu.food_logs[0]), true);
  // ไฟล์ผสมเก่า+ใหม่ในไฟล์เดียว และ version 2 เดิม
  assert.equal(validateImport(importFile([oldLog, ...newLogs], 2)).food_logs.length, 3);
  // ยังตรวจ id/date เหมือนเดิม
  assert.throws(() => validateImport(importFile([{ ...newLogs[0], id: '' }])), /ไม่มี id/);
  assert.throws(() => validateImport(importFile([{ ...newLogs[0], date: '13/10/2026' }])), /date/);
});

test('CSV food_logs: มีคอลัมน์ is_estimate และ kcal_missing เสมอ แม้มีแต่ log เดิม', () => {
  const header = (rows) => toCSV(csvRowsFor('food_logs', rows)).slice(1).split('\r\n')[0].split(',');
  const onlyOld = header([oldLog]);
  assert.ok(onlyOld.includes('is_estimate') && onlyOld.includes('kcal_missing'), onlyOld.join());
  const lines = toCSV(csvRowsFor('food_logs', [oldLog, ...newLogs])).slice(1).split('\r\n');
  const cols = lines[0].split(',');
  const val = (line, name) => line.split(',')[cols.indexOf(name)];
  assert.equal(val(lines[1], 'is_estimate'), 'false');
  assert.equal(val(lines[1], 'kcal_missing'), 'false');
  assert.equal(val(lines[2], 'kcal_missing'), 'true');
  assert.equal(val(lines[2], 'kcal'), ''); // null = ช่องว่าง
  assert.equal(val(lines[3], 'is_estimate'), 'true');
  // ตารางอื่นไม่ถูกแตะ
  const other = [{ id: 'x', a: 1 }];
  assert.equal(csvRowsFor('foods', other), other);
});

// ---------- 10) จดซ้ำจากรายการล่าสุด ----------

test('รายการล่าสุด: 5 รายการที่จดล่าสุดไม่ซ้ำกัน · จดซ้ำได้ฟิลด์ครบตามมื้อ/วันใหม่', () => {
  const mk = (id, name, min, extra = {}) => ({ id, name, date: '2026-10-19', meal: 'เช้า', created_at: `2026-10-19T0${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}:00.000Z`, kcal: 300, protein: 10, carb: 30, fat: 5, qty: 1, quick: false, deleted: false, ...extra });
  const logs = [
    mk('1', 'ไข่ต้ม', 1, { food_id: 'egg' }),
    mk('2', 'ชานม', 2, { quick: true, is_estimate: true, estimate_preset: 'drink' }),
    mk('3', 'ไข่ต้ม', 3, { food_id: 'egg', qty: 2 }), // ซ้ำ: เอาอันล่าสุด
    mk('4', 'มื้อปกติ', 4, { quick: true, is_estimate: true, estimate_preset: 'normal' }),
    mk('5', 'ก๋วยเตี๋ยวเรือ', 5, { quick: true, kcal: null, kcal_missing: true }),
    mk('6', 'ข้าวมันไก่', 6, { food_id: 'chk' }),
    mk('7', 'โจ๊ก', 7, { food_id: 'jok' }),
    mk('8', 'ที่ลบแล้ว', 8, { deleted: true }),
  ];
  const rec = recentDistinct(logs, 5);
  assert.deepEqual(rec.map((l) => l.id), ['7', '6', '5', '4', '3']);
  assert.equal(new Set(rec.map((l) => l.name)).size, 5);
  const copy = repeatLogFields(rec[3], { date: '2026-10-20', meal: 'เย็น' });
  assert.equal(copy.date, '2026-10-20');
  assert.equal(copy.meal, 'เย็น');
  assert.equal(copy.is_estimate, true);
  assert.equal(copy.estimate_preset, 'normal');
  assert.equal(copy.kcal, 300);
  assert.equal(copy.kcal_missing, false);
  const missingCopy = repeatLogFields(rec[2], { date: '2026-10-20', meal: 'เย็น' });
  assert.equal(missingCopy.kcal, null);
  assert.equal(missingCopy.kcal_missing, true);
  assert.equal('id' in copy || 'created_at' in copy, false); // เป็น log ใหม่ ไม่ใช่สำเนา id
  assert.deepEqual(recentDistinct([], 5), []);
});

// ---------- 11) ซิงก์ค่าปุ่มกะ (mock Supabase เดิม) ----------

const URL_ = 'https://mock-project.supabase.test';
const KEY = 'sb_publishable_mockkey';

test('ซิงก์ค่าปุ่มกะ: เรคคอร์ดตั้งค่า id คงที่ในตาราง profile ที่มีอยู่ ส่งขึ้นเซิร์ฟเวอร์ ดึงลงอีกเครื่อง แก้ทีหลังชนะ (LWW) และ log ที่ไม่มีแคลไม่หายระหว่างทาง', async () => {
  const clock = createClock();
  const mock = createMockSupabase({ url: URL_, key: KEY, clock: clock.now });
  const config = { url: URL_, publishableKey: KEY };
  const user = await makeUser(mock);
  const a = createDevice({ mock, clock, config, name: 'A' });
  const b = createDevice({ mock, clock, config, name: 'B' });
  await a.login(user.email, user.password);
  await b.login(user.email, user.password);

  const mine = { normal: { kcal: 620, protein: 28, carb: 72, fat: 22 }, drink: { kcal: 300, protein: 4, carb: 50, fat: 9 } };
  const rec = a.create('profile', { id: FOOD_PRESETS_ID, presets: mine });
  const missing = a.create('food_logs', { ...nameOnlyLogFields({ name: 'ก๋วยเตี๋ยวเรือ', date: D, meal: 'กลางวัน' }) });
  clock.tick();
  await a.sync.sync();
  const rows = mock.rowsOf(a.auth.getSession().user.id);
  const row = rows.find((r) => r.id === FOOD_PRESETS_ID);
  assert.equal(row.collection, 'profile'); // ไม่ได้สร้าง collection ใหม่
  assert.deepEqual(row.data.presets, mine);

  clock.tick();
  await b.sync.sync();
  assert.deepEqual(b.get('profile', FOOD_PRESETS_ID), rec);
  const resolved = resolvePresets(b.get('profile', FOOD_PRESETS_ID).presets);
  assert.equal(resolved.find((p) => p.key === 'normal').kcal, 620);
  assert.equal(resolved.find((p) => p.key === 'drink').kcal, 300);
  assert.equal(resolved.find((p) => p.key === 'snack').kcal, 150); // ปุ่มที่ไม่ได้แก้ใช้ค่าเริ่มต้น
  const got = b.get('food_logs', missing.id);
  assert.equal(got.kcal, null); // null ผ่านซิงก์ไม่กลายเป็น 0
  assert.equal(got.kcal_missing, true);
  assert.equal(isKcalMissing(got), true);

  // B แก้ค่าปุ่มทีหลัง → A ได้ค่าใหม่ ; B เติมแคล log → A ได้ค่าเติม
  clock.tick(5000);
  b.update('profile', FOOD_PRESETS_ID, { presets: { ...mine, normal: { kcal: 650, protein: 30, carb: 75, fat: 24 } } });
  b.update('food_logs', missing.id, { ...fillFromPreset(P.light, 1) });
  await b.sync.sync();
  clock.tick();
  await a.sync.sync();
  assert.equal(resolvePresets(a.get('profile', FOOD_PRESETS_ID).presets).find((p) => p.key === 'normal').kcal, 650);
  assert.equal(a.get('food_logs', missing.id).kcal, 350);
  assert.equal(isKcalMissing(a.get('food_logs', missing.id)), false);

  // คืนค่าเริ่มต้น (presets = null) ซิงก์ได้ และ resolvePresets ใช้ค่าเริ่มต้นทั้งหมด
  clock.tick(5000);
  a.update('profile', FOOD_PRESETS_ID, { presets: null });
  await a.sync.sync();
  clock.tick();
  await b.sync.sync();
  assert.deepEqual(resolvePresets(b.get('profile', FOOD_PRESETS_ID).presets).map((p) => p.kcal), FOOD_PRESETS.map((p) => p.kcal));

  // เรคคอร์ดตั้งค่าอยู่ในตาราง profile ที่มีอยู่ ไม่มีตารางใหม่ในรายการซิงก์/ส่งออก
  assert.ok(TABLES.includes('profile'));
  assert.ok(!TABLES.some((t) => /preset/.test(t)));
});
