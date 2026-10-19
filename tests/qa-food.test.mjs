// QA (เก็คโค่): ตรวจฟีเจอร์ "จดการกินแบบกะเอา" แบบอิสระจาก tests/food-quick.test.mjs
// - ตัวเลขคิดมือ (ปุ่มกะ × ขนาด, ปัดเศษ) · กฎ "ไม่ครบ" ของเกมกับวิเคราะห์ต้องตรงกัน · เติมแคลย้อนหลัง
// - seed v3 (ไม่ซ้ำ ไม่เอาของที่ลบกลับมา ไม่ทับของที่แก้ ซิงก์สองเครื่องไม่ซ้ำ) · CSV · ค่าปุ่มเพี้ยน · ซิงก์ผ่าน mock Supabase
// - บั๊กที่พบเขียนเป็น { todo: 'BUG-...' } เพื่อให้ node --test ยัง exit 0 (เอา todo ออกเมื่อแก้แล้ว)
// ข้อมูลสมมติทั้งหมด · ไม่ติดต่อเซิร์ฟเวอร์จริง
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  FOOD_PRESETS, QTY_OPTIONS, fillFromPreset, isKcalMissing, nameOnlyLogFields, normText, presetAmounts, presetLogFields, resolvePresets, scaleFood, searchFoods, validatePresetValues,
} from '../js/food-quick.js';
import { dailyIntake, estimateTDEE, intakeSummary, cleanWeights } from '../js/analytics.js';
import { computeGame } from '../js/game.js';
import { SEED_TIME_V3, planFoodSeed, seedFoods, seedFoodsExtra } from '../js/seed.js';
import { csvRowsFor, toCSV } from '../js/csv.js';
import { mergeRows } from '../js/lww.js';
import { FOOD_PRESETS_ID, PROFILE_ID, TABLES } from '../js/constants.js';
import { addDays, dateRange } from '../js/dates.js';
import { World, PROFILE, at, coinsOf, statusOf } from './qa-game-helpers.mjs';
import { createMockSupabase } from './mock-supabase.mjs';
import { createClock, createDevice, makeUser } from './memory-device.mjs';

const P = Object.fromEntries(FOOD_PRESETS.map((p) => [p.key, p]));
const D = '2026-10-13';

// ---------- 1) ปุ่มกะ × ขนาด: ตารางที่คิดมือ ----------

test('QA ปุ่มกะ 6 ปุ่ม × ขนาด ½/1/1½ ตรงกับตารางที่คิดมือ (kcal / โปรตีน / คาร์บ / ไขมัน)', () => {
  // [key, ขนาด] → [kcal, P, C, F]
  const hand = {
    snack: { 0.5: [75, 2.5, 10, 3], 1: [150, 5, 20, 6], 1.5: [225, 7.5, 30, 9] },
    light: { 0.5: [175, 9, 22.5, 5], 1: [350, 18, 45, 10], 1.5: [525, 27, 67.5, 15] },
    normal: { 0.5: [275, 12.5, 35, 10], 1: [550, 25, 70, 20], 1.5: [825, 37.5, 105, 30] },
    heavy: { 0.5: [400, 15, 45, 17.5], 1: [800, 30, 90, 35], 1.5: [1200, 45, 135, 52.5] },
    buffet: { 0.5: [750, 35, 70, 35], 1: [1500, 70, 140, 70], 1.5: [2250, 105, 210, 105] },
    drink: { 0.5: [125, 1.5, 22.5, 3.5], 1: [250, 3, 45, 7], 1.5: [375, 4.5, 67.5, 10.5] },
  };
  for (const [key, sizes] of Object.entries(hand)) {
    for (const [size, want] of Object.entries(sizes)) {
      const a = presetAmounts(P[key], Number(size));
      assert.deepEqual([a.kcal, a.protein, a.carb, a.fat], want, `${key} ×${size}`);
      const log = presetLogFields({ preset: P[key], size: Number(size), date: D, meal: 'เย็น' });
      assert.deepEqual([log.kcal, log.protein, log.carb, log.fat], want, `log ${key} ×${size}`);
      assert.equal(log.qty, Number(size));
      assert.equal(log.is_estimate, true);
      assert.equal(log.estimate_preset, key);
      const fill = fillFromPreset(P[key], Number(size));
      assert.deepEqual([fill.kcal, fill.protein, fill.carb, fill.fat], want, `fill ${key} ×${size}`);
      assert.equal(fill.kcal_missing, false);
    }
  }
});

test('QA ปัดเศษ: ผลคูณมี ≤ 1 ทศนิยมและคลาดจากค่าจริงไม่เกิน 0.05 ทั้งเมนู seed ทั้งหมด × จำนวน ½/1/1½/2 และค่าปุ่มที่ผู้ใช้ตั้งเป็นทศนิยม', () => {
  const foods = [...seedFoods(), ...seedFoodsExtra(), { kcal: 333.3, protein: 7.7, carb: 41.1, fat: 9.9 }, { kcal: 0.05, protein: 0.15, carb: 0.25, fat: 0.35 }];
  for (const f of foods) {
    for (const q of QTY_OPTIONS) {
      const r = scaleFood(f, q);
      for (const k of ['kcal', 'protein', 'carb', 'fat']) {
        assert.ok(Math.abs(r[k] * 10 - Math.round(r[k] * 10)) < 1e-6, `${f.name} ×${q} ${k} = ${r[k]} ไม่ใช่ทศนิยม 1 ตำแหน่ง`);
        assert.ok(Math.abs(r[k] - f[k] * q) <= 0.0501, `${f.name} ×${q} ${k}: ${r[k]} vs ${f[k] * q}`);
      }
    }
  }
  // ค่าปุ่มทศนิยมที่ผู้ใช้ตั้ง
  const v = validatePresetValues({ kcal: '333.33', protein: '7.77', carb: '', fat: '0.04' });
  assert.deepEqual(v.value, { kcal: 333.3, protein: 7.8, carb: 0, fat: 0 });
  assert.deepEqual(presetAmounts({ ...P.normal, ...v.value }, 1.5), { kcal: 500, protein: 11.7, carb: 0, fat: 0 }); // 333.3×1.5=499.95 → 500
});

test('QA ขอบเขตค่าปุ่มที่แก้เอง: kcal 1–5000, โปรตีน/ไขมัน 0–500, คาร์บ 0–800, ค่าว่าง = 0 (ยกเว้น kcal)', () => {
  assert.equal(validatePresetValues({ kcal: 1 }).ok, true);
  assert.equal(validatePresetValues({ kcal: 5000, protein: 500, carb: 800, fat: 500 }).ok, true);
  for (const bad of [{ kcal: 0 }, { kcal: 0.9 }, { kcal: 5000.1 }, { kcal: '' }, { kcal: null }, {}, { kcal: 'abc' }, { kcal: Infinity }, { kcal: NaN }, { kcal: 100, protein: -1 }, { kcal: 100, protein: 500.1 }, { kcal: 100, carb: 800.1 }, { kcal: 100, fat: 501 }]) {
    assert.equal(validatePresetValues(bad).ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(validatePresetValues({ kcal: 100 }).value, { kcal: 100, protein: 0, carb: 0, fat: 0 });
});

test('QA ค่าปุ่มเพี้ยน (ข้อมูลซิงก์เสีย/ไฟล์นำเข้า): resolvePresets ไม่โยน ไม่ทำ prototype เปื้อน ใช้ค่าเริ่มต้นของปุ่มที่เสีย', () => {
  const defaults = FOOD_PRESETS.map((p) => [p.key, p.kcal, p.protein, p.carb, p.fat]);
  const flat = (ps) => ps.map((p) => [p.key, p.kcal, p.protein, p.carb, p.fat]);
  for (const bad of [null, undefined, 'x', 5, [], [1, 2], {}, { normal: null }, { normal: 'x' }, { normal: [] }, { normal: { kcal: 'x' } }, { normal: { kcal: -5 } }, { normal: { kcal: 1e9 } }, { snack: { kcal: 10, protein: -1 } }, JSON.parse('{"__proto__":{"kcal":1},"constructor":{"kcal":2},"toString":{"kcal":3}}')]) {
    assert.deepEqual(flat(resolvePresets(bad)), defaults, JSON.stringify(bad));
  }
  assert.equal({}.kcal, undefined); // ไม่มีอะไรหลุดเข้า Object.prototype
  // ปุ่มที่ถูกต้องใช้ค่าที่แก้ ปุ่มที่เสียใช้ค่าเริ่มต้น และ customized บอกถูก
  const mixed = resolvePresets({ normal: { kcal: 620, protein: 28, carb: 72, fat: 22 }, drink: { kcal: 'x' }, heavy: { kcal: 800, protein: 30, carb: 90, fat: 35 } });
  assert.equal(mixed.find((p) => p.key === 'normal').kcal, 620);
  assert.equal(mixed.find((p) => p.key === 'normal').customized, true);
  assert.equal(mixed.find((p) => p.key === 'drink').kcal, 250);
  assert.equal(mixed.find((p) => p.key === 'heavy').customized, false); // ค่าเท่าค่าเริ่มต้น = ไม่ถือว่าแก้
});

// ---------- 2) กฎ "ไม่ครบ" ของเกมกับวิเคราะห์ต้องตรงกัน (สุ่มแบบกำหนดเมล็ด) ----------

function rng(seed) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

test('QA เกมกับวิเคราะห์ใช้กฎ "ไม่ครบ" เดียวกัน: จำนวนมื้อไม่มีแคลของวันตรงกัน · วันที่ไม่ครบไม่ได้ coin แคลอรี่และไฟไม่ผ่านเสมอ (200 โลกสุ่ม)', () => {
  const r = rng(424242);
  const pick = (a) => a[Math.floor(r() * a.length)];
  for (let iter = 0; iter < 200; iter++) {
    const w = new World();
    const dates = Array.from({ length: 8 }, (_, i) => addDays('2026-10-05', i));
    for (const d of dates) {
      for (let i = 0; i < Math.floor(r() * 4); i++) {
        const kind = pick(['num', 'num', 'null', 'undef', 'empty', 'flag', 'zero', 'str']);
        const extra = kind === 'flag' ? { kcal_missing: true } : {};
        const kcal = { num: pick([300, 700, 1000, 1300]), null: null, undef: undefined, empty: '', flag: pick([null, 500]), zero: 0, str: '700' }[kind];
        const late = r() < 0.15 ? { created_at: at(addDays(d, 6)) } : {};
        const rec = w.food(d, pick(['เช้า', 'กลางวัน', 'เย็น', 'ของว่าง']), kcal, pick([0, 50, 80]), { ...extra, ...late });
        if (kind === 'undef') delete rec.kcal;
        if (r() < 0.05) rec.deleted = true;
      }
    }
    const daily = dailyIntake(w.foodLogs);
    const past = computeGame(w.input('2026-10-14'));
    for (const d of dates) {
      const missingAnalytics = daily[d]?.missing || 0;
      const missingGame = computeGame(w.input(d)).today.missingKcalMeals;
      assert.equal(missingGame, missingAnalytics, `iter ${iter} ${d}`);
      if (d < '2026-10-14' && missingAnalytics > 0) {
        assert.equal(coinsOf(past, d, 'kcal'), 0, `iter ${iter} ${d} ได้ coin แคลอรี่ทั้งที่ไม่ครบ`);
        assert.notEqual(statusOf(past, d), 'pass', `iter ${iter} ${d} ไฟผ่านทั้งที่แคลอรี่ไม่ครบ`);
      }
    }
  }
});

test('QA เติมแคลย้อนหลัง: ภายใน 2 วันและเกิน 2 วัน ผลเกมเหมือนวันที่จดครบตั้งแต่แรกทุกประการ (coin, ไฟ, ledger)', () => {
  for (const fillAt of ['2026-10-14', '2026-10-15', '2026-10-20', '2026-10-30']) {
    const mk = (missing) => {
      const w = new World();
      w.food('2026-10-12', 'เช้า', 700, 50); // วันก่อนหน้า ผ่าน
      w.food('2026-10-12', 'เย็น', 1300, 80);
      w.food(D, 'เช้า', 700, 50);
      const m = w.food(D, 'เย็น', missing ? null : 1300, missing ? 0 : 80, missing ? { kcal_missing: true, quick: true } : { quick: true });
      w.food('2026-10-14', 'เช้า', 700, 50);
      w.food('2026-10-14', 'เย็น', 1300, 80);
      return { w, m };
    };
    const ref = mk(false).w.game('2026-11-05');
    const { w, m } = mk(true);
    const before = w.game(fillAt);
    assert.equal(coinsOf(before, D, 'kcal'), 0, 'ก่อนเติม ไม่มี coin แคลอรี่');
    assert.equal(statusOf(before, D), 'miss');
    // เติมแคล = แก้เรคคอร์ดเดิม (created_at ไม่เปลี่ยน) ตอนวัน fillAt
    Object.assign(m, { kcal: 1300, protein: 80, kcal_missing: false, updated_at: at(fillAt) });
    const after = w.game('2026-11-05');
    assert.equal(after.earned, ref.earned, `เติมตอน ${fillAt}: earned`);
    assert.equal(after.balance, ref.balance);
    assert.deepEqual(after.ledger, ref.ledger);
    assert.deepEqual(after.days, ref.days);
    assert.deepEqual(after.streak, ref.streak);
    assert.equal(coinsOf(after, D, 'kcal'), 5, `เติมตอน ${fillAt}: coin แคลอรี่กลับมา`);
    assert.equal(statusOf(after, D), 'pass');
  }
});

test('QA มื้อที่ไม่มีแคลถูกจดย้อนหลังนาน (ไม่สด) แล้วเติมแคลทีหลัง: ไฟกลับมาแต่ coin แคลอรี่ไม่ได้ (ตามกฎ backdate เดิม) · ไม่ทำให้วันอื่นเพี้ยน', () => {
  const w = new World();
  w.goodFood(D);
  const late = w.food(D, 'ของว่าง', null, 0, { kcal_missing: true, created_at: at('2026-10-25') });
  assert.equal(coinsOf(w.game('2026-10-26'), D, 'kcal'), 0);
  assert.equal(statusOf(w.game('2026-10-26'), D), 'miss');
  Object.assign(late, { kcal: 0, kcal_missing: false }); // เติมเป็น 0 (เช่น น้ำเปล่า)
  const g = w.game('2026-10-26');
  assert.equal(statusOf(g, D), 'pass'); // ไฟนับจากข้อมูลทั้งหมด
  assert.equal(coinsOf(g, D, 'kcal'), 5); // มื้อที่เหลือ (จดตรงเวลา) ยังอยู่ในช่วง และมื้อสาย 0 kcal ไม่เปลี่ยนยอด
});

test('QA วันที่มีมื้อได้รับอนุญาต (แลกของกิน) + มีมื้อไม่มีแคล: ไฟเป็น allowed แต่ไม่ได้ coin แคลอรี่', () => {
  const w = new World();
  w.food(D, 'เช้า', 700, 50);
  w.food(D, 'เย็น', null, 0, { kcal_missing: true });
  w.redeem(D);
  const g = w.game('2026-10-14');
  assert.equal(statusOf(g, D), 'allowed');
  assert.equal(coinsOf(g, D, 'kcal'), 0);
});

test('QA ประมาณ TDEE: ขอบ 13/14 วันหลังตัดวันไม่ครบ · วัน kcal 0 ที่ไม่ใช่ missing ไม่ถูกตัดแต่ต้อง ≥ 800 จึงนับ', () => {
  const dates = dateRange('2026-10-01', '2026-10-28');
  const mk = (incompleteCount) => {
    const logs = dates.map((date, i) => (i < incompleteCount ? [{ id: `a${i}`, date, meal: 'เช้า', kcal: 1900, protein: 100, deleted: false }, { id: `b${i}`, date, meal: 'เย็น', kcal: null, kcal_missing: true, deleted: false }] : [{ id: `a${i}`, date, meal: 'เช้า', kcal: 2000, protein: 100, deleted: false }])).flat();
    const body = dates.filter((_, i) => i % 3 === 0).map((date, i) => ({ id: `w${i}`, date, weight_kg: 80 - i * 0.2, deleted: false, updated_at: date }));
    return estimateTDEE(cleanWeights(body), dailyIntake(logs), { goal: 'lose', rate_kg_week: 0.5 }, { asOf: '2026-10-28' });
  };
  assert.equal(mk(14).ok, true); // เหลือ 14 วัน = พอดี
  assert.equal(mk(14).usedDays, 14);
  assert.equal(mk(14).avgIntake, 2000);
  assert.equal(mk(15).ok, false); // เหลือ 13 วัน
  assert.equal(mk(15).loggedDays, 13);
  assert.equal(mk(15).incompleteDays, 15);
  assert.equal(mk(0).incompleteDays, 0);
});

// ---------- 3) seed เมนูเพิ่ม (v3) ----------

const norm = (s) => String(s).normalize('NFC').toLowerCase().replace(/[\s\u200b-\u200d\ufeff()[\]{}（）［］]+/g, '');
const apply = (existing, plan) => [...existing, ...plan.add.map((f) => ({ ...f }))];

test('QA seed v3: ผลวางแผนตรงกับการคำนวณอิสระ (ชื่อซ้ำเทียบหลังตัดช่องว่าง/วงเล็บ/ตัวพิมพ์) บนข้อมูลผู้ใช้สุ่ม 100 ชุด · ไม่ซ้ำ ไม่ทับ ไม่เอาของที่ลบกลับมา', () => {
  const r = rng(777);
  const base = seedFoods();
  const extra = seedFoodsExtra();
  for (let iter = 0; iter < 100; iter++) {
    const existing = [];
    for (const f of base) {
      const roll = r();
      if (roll < 0.1) continue; // บางเครื่องไม่มี seed บางตัว (เช่นนำเข้าไฟล์เก่า)
      existing.push({ ...f, deleted: r() < 0.2, favorite: r() < 0.2, kcal: r() < 0.2 ? 999 : f.kcal, name: r() < 0.1 ? `${f.name} (แก้ชื่อ)` : f.name });
    }
    for (const e of extra) if (r() < 0.15) existing.push({ id: `user-${iter}-${existing.length}`, name: r() < 0.5 ? e.name : ` ${e.name.slice(0, 3)} ${e.name.slice(3)} `, deleted: r() < 0.3 });
    const snapshot = JSON.stringify(existing);
    const plan = planFoodSeed(existing);
    assert.equal(JSON.stringify(existing), snapshot, 'planFoodSeed ต้องไม่แก้ข้อมูลที่รับเข้า');
    // คาดการณ์อิสระ
    const have = new Set(existing.map((f) => norm(f.name)));
    for (const f of base) have.add(norm(f.name));
    const ids = new Set(existing.map((f) => f.id));
    const wantExtra = [];
    for (const f of extra) {
      const n = norm(f.name);
      if (have.has(n)) continue;
      have.add(n);
      if (!ids.has(f.id)) wantExtra.push(f.id);
    }
    const wantBase = base.filter((f) => !ids.has(f.id)).map((f) => f.id);
    assert.deepEqual(plan.add.map((f) => f.id).sort(), [...wantBase, ...wantExtra].sort(), `iter ${iter}`);
    // ไม่ทับของที่มี / ไม่เอาของที่ลบกลับมา
    for (const f of plan.add) assert.ok(!ids.has(f.id), `${f.name} มี id นี้แล้ว`);
    const after = apply(existing, plan);
    const live = after.filter((f) => !f.deleted).map((f) => norm(f.name));
    const dupNames = live.filter((n, i) => live.indexOf(n) !== i);
    // ชื่อซ้ำที่มีอยู่แล้วในเครื่องก่อน seed (ของผู้ใช้เอง) ไม่ใช่ความผิดของ seed: ตรวจเฉพาะที่ seed เป็นคนเพิ่ม
    const baseIds = new Set(base.map((f) => f.id)); // ของตั้งต้นเดิมเพิ่มเมื่อ id หายไปเท่านั้น (พฤติกรรมเดิม ไม่เช็กชื่อ) — ตรวจเฉพาะเมนูเพิ่มเติมที่ไม่ใช่ id เดียวกับของเดิม
    const addedNames = new Set(plan.add.filter((f) => extra.some((e) => e.id === f.id) && !baseIds.has(f.id)).map((f) => norm(f.name)));
    for (const n of dupNames) assert.ok(!addedNames.has(n), `seed เพิ่มชื่อซ้ำ: ${n}`);
    // วางแผนซ้ำหลังเพิ่มแล้ว = ไม่มีอะไรเพิ่ม (idempotent)
    assert.equal(planFoodSeed(after).add.length, 0, `iter ${iter} ไม่ idempotent`);
  }
});

test('QA seed v3: เมนูใหม่ลง id คงที่ ใช้เวลา seed (เก่ากว่าการแก้/ลบของผู้ใช้เสมอ) · ไม่ชนกับ id ของท่า/รางวัล', () => {
  const extra = seedFoodsExtra();
  assert.ok(extra.every((f) => f.created_at === SEED_TIME_V3 && f.updated_at === SEED_TIME_V3));
  assert.deepEqual(seedFoodsExtra().map((f) => f.id), extra.map((f) => f.id));
  const ids = new Set([...seedFoods(), ...extra].map((f) => f.id));
  assert.equal(ids.size, seedFoods().length + 68); // เมนูเพิ่มเติม 73 รายการ มี 5 รายการชื่อเดียวกับของเดิม → ได้ id เดียวกัน (ไม่มีทางซ้ำแม้เครื่องที่ขาด seed เดิม)
  for (const e of extra.filter((x) => seedFoods().some((f) => f.id === x.id))) assert.equal(norm(seedFoods().find((f) => f.id === e.id).name), norm(e.name));
});

test('QA seed v3 สองเครื่องอัปเกรดแยกกันแล้วซิงก์ (LWW): ได้ชุดเมนูเดียวกัน ไม่ซ้ำ · การแก้/ลบของผู้ใช้ชนะ seed · ข้อจำกัดชื่อซ้ำที่ README บอกไว้', async () => {
  const existing = seedFoods(); // ทั้งสองเครื่องมี seed เก่าอยู่ (ซิงก์กันแล้ว)
  const A = new Map(apply(existing, planFoodSeed(existing)).map((f) => [f.id, f]));
  const B = new Map(apply(existing, planFoodSeed(existing)).map((f) => [f.id, f]));
  assert.deepEqual([...A.keys()].sort(), [...B.keys()].sort());
  // ผู้ใช้เครื่อง A กดโปรดเมนูใหม่ 1 อัน, ลบอีก 1 อัน (เวลาจริง > เวลา seed)
  const [x, y] = seedFoodsExtra().filter((f) => !existing.some((e) => e.id === f.id));
  A.set(x.id, { ...A.get(x.id), favorite: true, updated_at: '2026-10-19T09:00:00.000Z' });
  A.set(y.id, { ...A.get(y.id), deleted: true, updated_at: '2026-10-19T09:00:01.000Z' });
  const toRows = (m) => [...m.values()].map((f) => ({ id: f.id, collection: 'foods', data: f, deleted: !!f.deleted, client_updated_at: f.updated_at }));
  const sync = async (into, from) => mergeRows(toRows(from), { tables: TABLES, get: async (_, id) => into.get(id), put: async (_, rec) => into.set(rec.id, rec) });
  await sync(B, A);
  await sync(A, B);
  assert.deepEqual([...A.keys()].sort(), [...B.keys()].sort());
  assert.equal(B.get(x.id).favorite, true);
  assert.equal(B.get(y.id).deleted, true);
  assert.equal(A.size, B.size);
  assert.equal(A.size, seedFoods().length + 68);
  // ข้อจำกัดที่ README บอกไว้: เครื่อง A มีอาหารที่ผู้ใช้สร้างชื่อซ้ำกับเมนูใหม่ แต่เครื่อง B ไม่มี → B เพิ่มเมนูนั้น → หลังซิงก์ชื่อซ้ำ (เป็นพฤติกรรมที่ยอมรับ ไม่ใช่บั๊ก)
  const dup = seedFoodsExtra().find((f) => f.name === 'ลาบหมู');
  const userA = [...existing, { id: 'u-A', name: 'ลาบหมู', deleted: false }];
  const planA = planFoodSeed(userA);
  const planB = planFoodSeed(existing);
  assert.ok(!planA.add.some((f) => f.id === dup.id));
  assert.ok(planB.add.some((f) => f.id === dup.id));
});

// ---------- 4) CSV ----------

test('QA CSV: กันสูตร (= + - @ TAB CR) ทุกคอลัมน์ข้อความ · ตัวเลขติดลบไม่ถูกใส่ \' · profile ที่มีค่าปุ่ม (object) เป็น JSON ใน 1 เซลล์', () => {
  const evil = ['=1+1', '+1', '-1', '@A1', '\t=x', '\r=x', '=HYPERLINK("http://x","y")'];
  const rows = evil.map((name, i) => ({ id: `r${i}`, name, serving: name, kcal: 5, protein: 1 }));
  const csv = toCSV(csvRowsFor('food_logs', rows)).slice(1);
  for (const line of csv.split('\r\n').slice(1, -1)) {
    // ไม่มีเซลล์ (ที่ไม่ได้อยู่ในเครื่องหมายคำพูด) ขึ้นต้นด้วยอักขระสูตร
    assert.ok(!/(^|,)[=+\-@\t]/.test(line.replace(/"[^"]*"/g, '""')), line);
  }
  assert.ok(toCSV([{ id: 'n', kcal: -5 }]).includes(',-5')); // ตัวเลขจริงติดลบไม่ถูกใส่ ' (เฉพาะสตริง)
  const prof = toCSV([{ id: PROFILE_ID, kcal: 2000 }, { id: FOOD_PRESETS_ID, presets: { normal: { kcal: 620, protein: 28, carb: 72, fat: 22 } } }]).slice(1);
  assert.ok(prof.includes('"{""normal"":{""kcal"":620,""protein"":28,""carb"":72,""fat"":22}}"'));
});

// ---------- 5) ซิงก์ (mock Supabase) ----------

const URL_ = 'https://mock-project.supabase.test';
const KEY = 'sb_publishable_mockkey';

async function twoDevices() {
  const clock = createClock();
  const mock = createMockSupabase({ url: URL_, key: KEY, clock: clock.now });
  const config = { url: URL_, publishableKey: KEY };
  const user = await makeUser(mock);
  const a = createDevice({ mock, clock, config, name: 'A' });
  const b = createDevice({ mock, clock, config, name: 'B' });
  await a.login(user.email, user.password);
  await b.login(user.email, user.password);
  return { clock, mock, a, b };
}

test('QA ซิงก์: แก้ค่าปุ่มบนเครื่องหนึ่ง และแก้โปรไฟล์บนอีกเครื่องพร้อมกัน — ทั้งคู่รอด (เรคคอร์ดแยก id จึงไม่ทับกัน)', async () => {
  const { clock, a, b } = await twoDevices();
  a.create('profile', { id: PROFILE_ID, kcal: 2000, protein_min: 120 });
  clock.tick();
  await a.sync.sync();
  clock.tick();
  await b.sync.sync();
  // ออฟไลน์ทั้งคู่ แก้พร้อมกัน
  a.online = false;
  b.online = false;
  clock.tick(1000);
  a.create('profile', { id: FOOD_PRESETS_ID, presets: { normal: { kcal: 650, protein: 30, carb: 75, fat: 24 } } });
  clock.tick(1000);
  b.update('profile', PROFILE_ID, { kcal: 1800 });
  a.online = true;
  b.online = true;
  for (let i = 0; i < 2; i++) {
    clock.tick(1000);
    await a.sync.sync();
    clock.tick(1000);
    await b.sync.sync();
  }
  for (const d of [a, b]) {
    assert.equal(d.get('profile', PROFILE_ID).kcal, 1800, `${d.name} โปรไฟล์`);
    assert.equal(d.get('profile', FOOD_PRESETS_ID).presets.normal.kcal, 650, `${d.name} ค่าปุ่ม`);
  }
});

test('QA ซิงก์: สองเครื่องแก้ log เดียวกัน (A เติมแคล, B แก้ชื่อทีหลังโดยยังไม่ได้ซิงก์) → ฝั่งใหม่กว่าชนะทั้งเรคคอร์ด จึงเติมแคลของ A หาย (LWW ตามที่ออกแบบ — บันทึกไว้เป็นพฤติกรรมที่ผู้ใช้อาจเจอ)', async () => {
  const { clock, a, b } = await twoDevices();
  const log = a.create('food_logs', nameOnlyLogFields({ name: 'ก๋วยเตี๋ยวเรือ', date: D, meal: 'กลางวัน' }));
  clock.tick();
  await a.sync.sync();
  clock.tick();
  await b.sync.sync();
  a.online = false;
  b.online = false;
  clock.tick(1000);
  a.update('food_logs', log.id, { ...fillFromPreset(P.light, 1) });
  clock.tick(1000);
  b.update('food_logs', log.id, { name: 'ก๋วยเตี๋ยวเรือ (ร้านป้า)' });
  a.online = true;
  b.online = true;
  for (let i = 0; i < 2; i++) {
    clock.tick(1000);
    await a.sync.sync();
    clock.tick(1000);
    await b.sync.sync();
  }
  for (const d of [a, b]) {
    const l = d.get('food_logs', log.id);
    assert.equal(l.name, 'ก๋วยเตี๋ยวเรือ (ร้านป้า)');
    assert.equal(l.kcal, null); // การเติมแคลของ A ถูกทับ
    assert.equal(isKcalMissing(l), true);
  }
});

// ---------- 5.1) เรคคอร์ดค่าปุ่มอยู่ในตาราง profile: ห้ามมีโค้ดอ่านตารางนี้แบบ "ทั้งตาราง/แถวแรก" ----------

test('QA เรคคอร์ดค่าปุ่ม (…0003) อยู่ใน collection profile: ไม่มีโค้ดใน js/ อ่าน profile แบบ list/แถวแรก/loadAll().profile (จะทำให้ค่าปุ่มถูกมองเป็นโปรไฟล์)', () => {
  const dir = new URL('../js/', import.meta.url);
  const files = [];
  const walk = (u) => {
    for (const e of readdirSync(u, { withFileTypes: true })) {
      if (e.isDirectory()) walk(new URL(`${e.name}/`, u));
      else if (e.name.endsWith('.js')) files.push(new URL(e.name, u));
    }
  };
  walk(dir);
  assert.ok(files.length > 20);
  const risky = [/list\(\s*['"]profile['"]/, /listByIndex\(\s*['"]profile['"]/, /\.profile\s*\[/, /(data|all|tables|snap\w*)\.profile(?!_)/, /listDateRange\(\s*['"]profile['"]/];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of risky) assert.ok(!re.test(text), `${f.pathname.split('/js/')[1]} อ่านตาราง profile แบบเสี่ยง: ${re}`);
  }
  // และที่อ่านต้องอ่านด้วย id เท่านั้น
  const db = readFileSync(new URL('db.js', dir), 'utf8');
  assert.ok(/get\('profile', PROFILE_ID\)/.test(db) && /get\('profile', FOOD_PRESETS_ID\)/.test(db));
});

// ---------- 6) ความเป็นส่วนตัวของไฟล์ที่เพิ่ม ----------

test('QA ความเป็นส่วนตัว: ไฟล์ใหม่ของฟีเจอร์ไม่มีอีเมล/ชื่อ/โทเคน/พาธเครื่อง/เลขโทรศัพท์', () => {
  const files = ['js/food-quick.js', 'js/views/food-estimate.js', 'js/seed.js', 'tests/food-quick.test.mjs']; // (ไม่สแกนไฟล์นี้เองเพราะมีตัวอย่างรูปแบบอยู่ในโค้ด)
  const bad = [/[\w.+-]+@(?!example\.com)[\w-]+\.[a-z]{2,}/i, /C:\\Users|C:\/Users|\/Users\//, /eyJ[A-Za-z0-9_-]{20,}/, /sb_secret|service_role/, /\b0[689]\d{8}\b/, /\b\d{13}\b/];
  for (const f of files) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const re of bad) assert.ok(!re.test(text), `${f} ตรงกับ ${re}`);
  }
});

// ---------- 7) บั๊กที่พบ (todo: เอา todo ออกเมื่อแก้แล้ว) ----------

test('BUG-F1 (เล็ก): วันที่ยังมีมื้อไม่มีแคล โปรตีนที่เห็นเป็นแค่ค่าขั้นต่ำ — หน้าวิเคราะห์ไม่ควรตัดสินว่า "ไม่ถึงเป้าโปรตีน" (proteinOk ควรเป็น null และไม่นับในตัวหาร "ถึงเป้า X/Y วัน")', () => {
  const logs = [
    { id: 'a', date: D, meal: 'เช้า', kcal: 500, protein: 40, deleted: false },
    { id: 'b', date: D, meal: 'เย็น', kcal: null, kcal_missing: true, protein: 0, deleted: false },
    { id: 'c', date: '2026-10-14', meal: 'เช้า', kcal: 1000, protein: 130, deleted: false },
  ];
  const sum = intakeSummary(dailyIntake(logs), { kcal: 2000, protein_min: 120 }, [D, '2026-10-14']);
  assert.equal(sum.days[0].incomplete, true);
  assert.equal(sum.days[0].proteinOk, null);
});

test('BUG-F2 (เล็ก): ค้นหา "กระเพรา" (สะกดที่คนพิมพ์บ่อย) ไม่เจอเมนู "กะเพรา" เลย', () => {
  const all = planFoodSeed([]).add;
  assert.ok(searchFoods(all, 'กะเพรา').length >= 4);
  assert.ok(searchFoods(all, 'กระเพรา').length >= 4);
});
