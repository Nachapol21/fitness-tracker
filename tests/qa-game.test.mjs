// QA อิสระ (เก็คโค่ 🦎): ตรวจเกม coin + streak ด้วยตัวเลขที่คิดมือ · ขอบเขต · กันโกง · ไฟสำรอง/วันพัก/วันได้รับอนุญาต
// ข้อมูลสมมติทั้งหมด · เทสต์ที่ติด { todo: 'BUG-...' } คือบั๊ก/ช่องโหว่ที่ยังไม่แก้ (รายงานแยก) — ไม่ทำให้ node --test ล้ม
// และจะกลายเป็น "ผ่าน" เองเมื่อแก้แล้ว (node แสดงเป็น todo ที่ผ่าน)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeGame, checkRedeem, coinTransactions, canCancelRedemption, normalizeSettings, tierMultiplier } from '../js/game.js';
import { redeemReward, buyFreeze, cancelRedemption, GameError } from '../js/game-actions.js';
import { addDays, dateRange } from '../js/dates.js';
import { validateImport } from '../js/db.js';
import { DATA_FORMAT, TABLES } from '../js/constants.js';
import { World, PROFILE, at, dayItems, dayTotal, coinsOf, statusOf, handScenario, HAND_DAYS } from './qa-game-helpers.mjs';

// ---------- 1) คิดมือ 4 สัปดาห์เทียบ computeGame ----------

test('QA คิดมือ: 4 สัปดาห์ (ไฟดับ 2 ครั้ง, ตัวคูณ ×1.2/×1.5, โบนัส, วันได้รับอนุญาต) ตรงทุกวัน', () => {
  const g = handScenario().game('2026-10-19');
  const got = g.ledger.map((d) => [d.date, d.total]);
  assert.deepEqual(got, HAND_DAYS);
  assert.equal(g.earned, 586);
  assert.equal(g.spent, 150);
  assert.equal(g.balance, 436);
  // ไฟ: สิ้น 18 ต.ค. = 6 (13–18; 16 เป็นวันได้รับอนุญาต) · ตัวคูณยังเป็น ×1 · ไฟดับที่ 12 ต.ค. หลังไฟ 4 วัน
  assert.equal(g.streak.run, 6);
  assert.equal(g.streak.runStart, '2026-10-13');
  assert.equal(g.streak.multiplier, 1);
  assert.deepEqual(g.streak.lastBreak, { date: '2026-10-12', length: 4 });
  assert.deepEqual(g.streak.nextTier, { days: 7, mult: 1.2, left: 1 });
  assert.equal(g.streak.weeks, 4);
  assert.equal(g.streak.weekCount, 0);
  const miss = g.days.filter((d) => d.status === 'miss').map((d) => d.date);
  assert.deepEqual(miss, ['2026-10-07', '2026-10-12']);
  assert.equal(statusOf(g, '2026-10-16'), 'allowed');
  assert.equal(g.days.length, 28);
  // ตัวคูณของแต่ละวันคือความยาวไฟ ณ สิ้นวันก่อนหน้า
  const mult = (d) => g.days.find((x) => x.date === d).mult;
  assert.deepEqual([mult('2026-09-27'), mult('2026-09-28'), mult('2026-10-04'), mult('2026-10-05'), mult('2026-10-07'), mult('2026-10-08')], [1, 1.2, 1.2, 1.5, 1.5, 1]);
  // ledger รวมกันเท่า earned และทุกรายการเป็นจำนวนเต็ม
  assert.equal(g.ledger.reduce((a, d) => a + d.total, 0), g.earned);
  for (const d of g.ledger) for (const i of d.items) assert.ok(Number.isInteger(i.coins) && i.coins > 0);
  // ประวัติธุรกรรม (มุมมอง) รวมแล้วเท่ายอดคงเหลือ
  const tx = coinTransactions(g, handScenario().redemptions);
  assert.equal(tx.reduce((a, r) => a + r.amount, 0), 436);
});

test('QA คิดมือ: วันนี้ (จันทร์ 19 ต.ค. ยังไม่จด) ได้รายการ todo ครบ และไม่นับ coin แคลอรี่ของวันนี้', () => {
  const w = handScenario();
  const g0 = w.game('2026-10-19');
  assert.equal(g0.streak.todayStatus, 'open');
  assert.equal(g0.streak.display, 6);
  const reasons = g0.today.todo.map((t) => t.reason).sort();
  assert.deepEqual(reasons, ['cardio', 'kcal', 'protein', 'steps', 'week_bonus', 'weigh', 'workout']);
  // โปรตีนอีก 120 ก. ได้ +5 (ตัวคูณ ×1)
  assert.equal(g0.today.todo.find((t) => t.reason === 'protein').text, 'โปรตีนอีก 120 ก.');
  w.goodFood('2026-10-19');
  const g1 = w.game('2026-10-19');
  assert.equal(coinsOf(g1, '2026-10-19', 'kcal'), 0, 'coin แคลอรี่รอจบวัน');
  assert.equal(coinsOf(g1, '2026-10-19', 'protein'), 5);
  assert.equal(g1.streak.display, 7);
  assert.equal(g1.streak.run, 6);
  // พรุ่งนี้ (วัน 19 จบแล้ว): ได้ coin แคลอรี่ และไฟ 7 → ตัวคูณ ×1.2 สำหรับวันที่ 20
  const g2 = w.game('2026-10-20');
  assert.equal(coinsOf(g2, '2026-10-19', 'kcal'), 5);
  assert.equal(g2.streak.run, 7);
  assert.equal(g2.streak.multiplier, 1.2);
});

// ---------- 2) ขอบเขตสัปดาห์และเวลา ----------

test('QA ขอบสัปดาห์ จ–อา: ฝึกครั้งที่ 4 วันอาทิตย์ได้โบนัสสัปดาห์นั้น แต่วันจันทร์ถัดไปนับเป็นสัปดาห์ใหม่', () => {
  const mk = (fourth) => {
    const w = new World();
    for (const d of ['2026-10-12', '2026-10-13', '2026-10-15']) w.train(d);
    w.train(fourth);
    return w.game('2026-10-20');
  };
  const sun = mk('2026-10-18');
  assert.equal(coinsOf(sun, '2026-10-18', 'week_bonus'), 30);
  assert.equal(sun.streak.weeks, 1, 'สัปดาห์ 12–18 ครบ 4 ครั้ง');
  const mon = mk('2026-10-19');
  assert.equal(coinsOf(mon, '2026-10-19', 'week_bonus'), 0);
  assert.equal(dayItems(mon, '2026-10-18').length, 0);
  assert.equal(mon.streak.weeks, 0, 'สัปดาห์ 12–18 ฝึกแค่ 3 ครั้ง');
  assert.equal(mon.streak.weekCount, 1, 'ครั้งที่ 4 ของเดิมกลายเป็นครั้งที่ 1 ของสัปดาห์ใหม่');
  // โบนัสครั้งเดียวต่อสัปดาห์ แม้ฝึกครั้งที่ 5, 6
  const w = new World();
  for (const d of dateRange('2026-10-12', '2026-10-17')) w.train(d);
  const g = w.game('2026-10-26');
  assert.equal(g.ledger.flatMap((d) => d.items).filter((i) => i.reason === 'week_bonus').length, 1);
});

test('QA ขอบสัปดาห์: โควตาวันพักและวันได้รับอนุญาตรีเซ็ตทุกวันจันทร์ (อาทิตย์ = วันพักที่ 4 พลาด, จันทร์ผ่าน)', () => {
  const w = new World();
  for (const d of dateRange('2026-10-12', '2026-10-19')) w.goodFood(d);
  w.train('2026-10-12'); // พัก: อ พ พฤ ศ ส อา (6 วัน) — เกิน 3
  const g = w.game('2026-10-20');
  assert.deepEqual(g.days.map((d) => d.status), ['pass', 'pass', 'pass', 'pass', 'miss', 'miss', 'miss', 'pass']);
  assert.equal(g.streak.run, 1);
});

test('QA เวลาไทยเที่ยงคืน: 23:59:59 ไทยยังนับ 2 วัน, 00:00:00 ไทยนับ 3 วัน (ทุกโซนเวลาของเครื่องให้ผลเหมือนกัน)', () => {
  const script = fileURLToPath(new URL('./qa-game-tz-child.mjs', import.meta.url));
  const zones = ['UTC', 'Asia/Bangkok', 'America/Los_Angeles', 'America/St_Johns', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Lord_Howe', 'Europe/London'];
  const results = zones.map((tz) => {
    const out = execFileSync(process.execPath, [script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    return { tz, ...JSON.parse(out) };
  });
  const ref = results[0];
  assert.equal(ref.edgeIn, 1, 'ช้า 2 วันตามเวลาไทยต้องได้ coin ชั่งน้ำหนัก');
  assert.equal(ref.edgeOut, 0, 'ช้า 3 วันตามเวลาไทยต้องไม่ได้ coin');
  assert.equal(ref.main.balance, 436);
  for (const r of results) {
    assert.deepEqual(r.main, ref.main, `ผลคำนวณเกมต่างกันที่ TZ=${r.tz}`);
    assert.equal(r.edgeIn, ref.edgeIn, r.tz);
    assert.equal(r.edgeOut, ref.edgeOut, r.tz);
  }
  // sanity ของตัวช่วยเอง: toDateStr (ใช้หา "วันนี้" ของเครื่อง) เปลี่ยนตามโซนจริง → เทสต์นี้ตั้ง TZ ได้ผล
  const day = Object.fromEntries(results.map((r) => [r.tz, r.localDay]));
  assert.equal(day['Asia/Bangkok'], '2026-10-19'); // 20:30Z = 03:30 ไทย วันถัดไป
  assert.equal(day['Pacific/Pago_Pago'], '2026-10-18');
});

// ---------- 3) วันที่ไม่ได้จด / ขอบช่วงแคลอรี่ ----------

test('QA แคลอรี่ขอบช่วง 1800–2100: 1800 และ 2100 ผ่าน, 1799/2101 ไม่ผ่าน, ทศนิยมปัดตามที่แสดง, ต้อง 2 มื้อที่ต่างกัน', () => {
  const day = (parts) => {
    const w = new World();
    parts.forEach(([meal, kcal], i) => w.food('2026-10-13', meal, kcal, i === 0 ? 130 : 0));
    // รอบแก้ 1: ค่าตั้งต้นของช่วงเปลี่ยนเป็น เป้า ± kcal_tolerance ของโปรไฟล์ (1900–2100) เทสต์นี้ตรวจขอบ 1800–2100 จึง override ในตั้งค่าเกม (ต่ำกว่า 200 / สูงกว่า 100)
    return w.game('2026-10-14', { settings: { kcal_below: 200, kcal_above: 100 } });
  };
  const ok = (parts) => coinsOf(day(parts), '2026-10-13', 'kcal') === 5;
  assert.ok(ok([['เช้า', 900], ['เย็น', 900]]), '1800 พอดี');
  assert.ok(ok([['เช้า', 1000], ['เย็น', 1100]]), '2100 พอดี');
  assert.ok(!ok([['เช้า', 900], ['เย็น', 899]]), '1799');
  assert.ok(!ok([['เช้า', 1000], ['เย็น', 1101]]), '2101');
  assert.ok(ok([['เช้า', 1000], ['เย็น', 1100.04]]), '2100.04 ปัดเป็น 2100.0');
  assert.ok(!ok([['เช้า', 1000], ['เย็น', 1100.06]]), '2100.06 ปัดเป็น 2100.1');
  assert.ok(!ok([['เช้า', 2000]]), 'มื้อเดียว');
  assert.ok(!ok([['เช้า', 1000], ['เช้า', 1000]]), 'สองรายการแต่มื้อเดียวกัน');
  // kcal เป็นข้อความตัวเลข/ไม่ใช่ตัวเลข ไม่ทำให้พัง (นับเป็น 0)
  const w = new World();
  w.food('2026-10-13', 'เช้า', '1000', 0);
  w.food('2026-10-13', 'เย็น', '1000', 0);
  w.food('2026-10-13', 'ว่าง', 'abc', 0);
  assert.equal(coinsOf(w.game('2026-10-14'), '2026-10-13', 'kcal'), 5);
  // kcal = null คือ "ยังไม่มีแคล" (จดจากชื่ออย่างเดียว): วันนั้นแคลอรี่ไม่ครบ ไม่ได้ coin แคลอรี่ จนกว่าจะเติมแคล (ดู tests/food-quick.test.mjs)
  w.food('2026-10-13', 'ว่าง2', null, 0);
  assert.equal(coinsOf(w.game('2026-10-14'), '2026-10-13', 'kcal'), 0);
});

test('QA วันที่ไม่ได้จดอะไรเลย: ไฟดับ ไม่มี coin ไม่กินโควตาวันพัก · วันที่ชั่งน้ำหนักอย่างเดียว (ไม่มีอาหาร) ก็พลาด', () => {
  const w = new World();
  w.goodFood('2026-10-12'); // พัก 1
  w.body('2026-10-13', { weight_kg: 80 }); // ไม่มีอาหาร: พลาด แต่ได้ coin ชั่งน้ำหนัก
  // 14 ไม่มีอะไร
  w.goodFood('2026-10-15'); // พัก 2
  const g = w.game('2026-10-16');
  assert.deepEqual(g.days.map((d) => d.status), ['pass', 'miss', 'miss', 'pass']);
  assert.equal(dayTotal(g, '2026-10-13'), 1);
  assert.equal(dayTotal(g, '2026-10-14'), 0);
  assert.equal(g.streak.run, 1);
  assert.equal(g.rest.used, 2); // จ 12 และ พฤ 15 เป็นวันพักที่ผ่านแล้ว (อ/พ พลาด ไม่กินโควตา)
});

test('QA ไม่ตั้งเป้าแคลอรี่ในโปรไฟล์: ไฟนับไม่ได้ (ทุกวันพลาด) แต่ coin อื่นยังได้ และไม่พัง', () => {
  const w = new World();
  w.goodFood('2026-10-13');
  w.train('2026-10-13');
  const g = w.game('2026-10-14', { profile: { kcal: null, protein_min: null } });
  assert.equal(statusOf(g, '2026-10-13'), 'miss');
  assert.equal(coinsOf(g, '2026-10-13', 'workout'), 10);
  assert.equal(coinsOf(g, '2026-10-13', 'kcal'), 0);
  assert.equal(g.targetKcal, null);
});

// ---------- 4) ไฟสำรอง × วันพัก × วันได้รับอนุญาต ----------

test('QA ไฟสำรองช่วยวันที่พลาดเพราะวันพักเกิน 3 วัน (และวันถัดไปที่พลาดอีกต้องดับ)', () => {
  const w = new World();
  for (const d of dateRange('2026-10-12', '2026-10-18')) w.goodFood(d);
  w.train('2026-10-12');
  w.freeze('2026-10-12');
  // จ ฝึก · อ พ พฤ = พัก 1–3 · ศ(16) พัก 4 → ไฟสำรอง · ส(17) พัก 4 อีก → ดับ · อา(18) พลาด
  const g = w.game('2026-10-19');
  assert.deepEqual(g.days.map((d) => d.status), ['pass', 'pass', 'pass', 'pass', 'freeze', 'miss', 'miss']);
  assert.equal(g.freeze.held, false);
  assert.equal(g.streak.run, 0);
  assert.equal(g.streak.lastBreak.length, 4); // 12–15 (ไฟสำรองไม่เพิ่มความยาว)
  assert.equal(g.rest.used, 0);
});

test('QA ไฟสำรอง: วันที่ได้รับอนุญาตอยู่แล้วไม่ใช้ไฟสำรอง · เกินโควตาอนุญาต → ใช้ไฟสำรองแทน', () => {
  const w = new World();
  w.freeze('2026-10-12');
  for (const d of ['2026-10-12', '2026-10-13']) {
    w.goodFood(d);
    w.train(d);
    w.food(d, 'ว่าง', 1500, 0, { quick: true });
    w.redeem(d, { id: `rd${d}` });
  }
  // 12 = อนุญาต (ไม่ใช้ไฟสำรอง) · 13 = อนุญาตครั้งที่ 2 ในสัปดาห์เดียวกัน → พลาด → ไฟสำรองช่วย
  const g = w.game('2026-10-14');
  assert.deepEqual(g.days.map((d) => d.status), ['allowed', 'freeze']);
  assert.equal(g.freeze.held, false);
  assert.equal(g.allowed.used, 1);
});

test('QA ไฟสำรองไม่ถูกใช้กับ "วันนี้" แม้วันนี้ยังไม่ได้จดและเป็นวันพักที่เกินโควตาแล้ว', () => {
  const w = new World();
  for (const d of dateRange('2026-10-12', '2026-10-15')) w.goodFood(d);
  w.freeze('2026-10-12');
  const g = w.game('2026-10-16'); // จ–พฤ พัก 4 วัน (พฤ = พัก 4 พลาด → ไฟสำรอง) · ศ 16 ยังไม่จบ
  assert.equal(statusOf(g, '2026-10-15'), 'freeze');
  assert.equal(g.streak.todayStatus, 'open');
  assert.equal(g.days.length, 4);
});

// ผลตรวจ: วันได้รับอนุญาต (แลกของกิน) ที่ "ไม่ได้ฝึก" ตกอยู่ภายใต้เพดานวันพักด้วย → ถ้าสัปดาห์นั้นพักครบ 3 วันแล้ว
// ไฟดับทั้งที่แอปบอกว่า "วันนี้เป็นวันได้รับอนุญาต ไฟไม่ดับ" (views/game.js:274) เพราะ sheet ตรวจแค่โควตาอนุญาต ไม่ตรวจโควตาวันพัก
test('QA วันได้รับอนุญาตที่ไม่ได้ฝึก ต้องไม่ถูกตัดไฟเพราะเพดานวันพัก', () => {
  // จ อ พ ไม่ได้ฝึก (พัก 3 วัน เต็มโควตา) · พฤ ศ ส ฝึก · อา ไม่ฝึก + กินเกินช่วง + แลกชาบู
  const w2 = new World();
  for (const d of dateRange('2026-10-12', '2026-10-17')) w2.goodFood(d);
  w2.train('2026-10-15');
  w2.train('2026-10-16');
  w2.train('2026-10-17'); // จ อ พ พัก 3 · พฤ ศ ส ฝึก
  w2.goodFood('2026-10-18');
  w2.food('2026-10-18', 'เย็น', 1200, 0, { quick: true });
  w2.redeem('2026-10-18'); // อาทิตย์: ไม่ฝึก + กินเกินช่วง + แลกชาบู → ควรเป็น allowed
  const g = w2.game('2026-10-19');
  assert.equal(statusOf(g, '2026-10-18'), 'allowed');
});

test('QA ช่วงแคลอรี่ของเกมควรตรงกับช่วงที่โปรไฟล์/หน้าอื่นของแอปใช้ (เป้า ± kcal_tolerance ตามสเปค)', () => {
  const w = new World();
  w.food('2026-10-13', 'เช้า', 900, 60);
  w.food('2026-10-13', 'เย็น', 950, 70); // 1850 kcal: โปรไฟล์ตั้งช่วงที่ยอมรับ ±100 → 1900–2100 → 1850 ต้องไม่ผ่าน
  const g = w.game('2026-10-14', { profile: { ...PROFILE, kcal_tolerance: 100 } });
  assert.equal(coinsOf(g, '2026-10-13', 'kcal'), 0);
  assert.equal(statusOf(g, '2026-10-13'), 'miss');
});

// ---------- 5) เพดานตัวคูณ ----------

test('QA เพดานตัวคูณ ×2: ไฟ 29 วัน ×1.5 · 30 วันขึ้นไป ×2 ไม่เพิ่มอีกแม้ไฟ 100 วัน · ปัดเศษลงต่อรายการ', () => {
  const w = new World();
  const start = '2026-06-01';
  const days = dateRange(start, addDays(start, 99));
  for (const d of days) {
    w.goodFood(d);
    const dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (dow < 4) w.train(d);
  }
  w.body(days[30], { weight_kg: 80, steps: 9000 }); // วันที่ 31 (ไฟก่อนหน้า 30 วัน → ×2)
  const g = w.game(addDays(start, 100));
  const m = (i) => g.days[i].mult;
  assert.equal(m(0), 1);
  assert.equal(m(6), 1);
  assert.equal(m(7), 1.2);
  assert.equal(m(13), 1.2);
  assert.equal(m(14), 1.5);
  assert.equal(m(29), 1.5, 'ไฟ 29 ณ สิ้นวันที่ 29 (วันที่ 30 ใช้ ×1.5)');
  assert.equal(m(30), 2);
  assert.equal(m(99), 2);
  assert.equal(Math.max(...g.days.map((d) => d.mult)), 2);
  // ชั่ง 1 × 2 = 2 · ก้าว 2 × 2 = 4 · ไม่ปัดผิด
  assert.equal(coinsOf(g, days[30], 'weigh'), 2);
  assert.equal(coinsOf(g, days[30], 'steps'), 4);
  // โบนัสรายสัปดาห์ไม่คูณ แม้ ×2
  const bonus = g.ledger.find((d) => d.date === days[31]); // วันที่ 32 = พฤ... ตรวจเฉพาะรายการโบนัส
  const allBonus = g.ledger.flatMap((d) => d.items).filter((i) => i.reason === 'week_bonus');
  assert.ok(allBonus.length >= 10);
  for (const i of allBonus) assert.equal(i.coins, 30);
  assert.ok(bonus === undefined || bonus.items.length >= 0);
  // ตัวคูณเมื่อผู้ใช้ตั้งขั้นสลับกัน (ขั้น 3 วันน้อยกว่าขั้น 1) ยังเลือกขั้นที่ถูก
  const odd = { tier1_days: 7, tier1_mult: 1.2, tier2_days: 5, tier2_mult: 1.1, tier3_days: 30, tier3_mult: 2 };
  assert.equal(tierMultiplier(5, odd), 1.1);
  assert.equal(tierMultiplier(8, odd), 1.2);
});

// ---------- 6) กันโกง / กันข้อมูลเพี้ยน ----------

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function shuffled(arr, r) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('QA ผลคำนวณไม่ขึ้นกับลำดับข้อมูล (สองเครื่องที่ซิงก์ครบแล้วยอดต้องเท่ากัน): สุ่ม 40 ชุด × สลับลำดับ', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const w = new World();
    const days = dateRange('2026-08-24', '2026-10-18');
    for (const d of days) {
      if (r() < 0.8) {
        w.food(d, 'เช้า', 400 + Math.floor(r() * 900), Math.floor(r() * 80), r() < 0.1 ? { created_at: at(addDays(d, 4)) } : {});
        w.food(d, 'เย็น', 400 + Math.floor(r() * 1200), Math.floor(r() * 80));
      }
      if (r() < 0.55) w.train(d, 3 + Math.floor(r() * 3), 2 + Math.floor(r() * 3), { weight: 40 + Math.floor(r() * 30), reps: 5 + Math.floor(r() * 6) });
      if (r() < 0.3) w.cardioFor(d, 10 + Math.floor(r() * 30));
      if (r() < 0.4) w.body(d, { weight_kg: 70 + r() * 5, steps: Math.floor(r() * 12000) });
      if (r() < 0.05) w.redeem(d, { coins: 20, price: 20, kcal: r() < 0.5 ? 300 : 0 });
      if (r() < 0.03) w.freeze(d);
    }
    const base = w.game('2026-10-19');
    for (let k = 0; k < 3; k++) {
      const w2 = Object.assign(new World(), {
        foodLogs: shuffled(w.foodLogs, r), bodyLogs: shuffled(w.bodyLogs, r), sessions: shuffled(w.sessions, r), sets: shuffled(w.sets, r),
        cardio: shuffled(w.cardio, r), redemptions: shuffled(w.redemptions, r), exercises: shuffled(w.exercises, r),
      });
      assert.deepEqual(w2.game('2026-10-19'), base, `seed ${seed} รอบ ${k}`);
    }
    assert.ok(Number.isFinite(base.balance));
    assert.equal(base.ledger.reduce((a, d) => a + d.total, 0), base.earned);
  }
});

test('QA แก้/ลบ log ย้อนหลังแล้วยอดเปลี่ยนตามจริงและไม่ได้ coin ซ้ำ: ลบแล้วจดใหม่ (id ใหม่) ในวันเดิม = ยอดเท่าเดิม', () => {
  const w = new World();
  w.goodFood('2026-10-14');
  w.train('2026-10-14');
  const b = w.body('2026-10-14', { weight_kg: 80, steps: 9000 });
  const base = w.game('2026-10-16').earned;
  assert.equal(base, 10 + 5 + 5 + 2 + 1);
  // ผู้ใช้ลบแล้วจดใหม่ 5 รอบ (id ใหม่ทุกครั้ง) ภายในกรอบ 2 วัน
  for (let i = 0; i < 5; i++) {
    b.deleted = true;
    w.body('2026-10-14', { weight_kg: 80, steps: 9000 }, { created_at: at('2026-10-15') });
  }
  assert.equal(w.game('2026-10-16').earned, base, 'จดซ้ำหลาย body_log ในวันเดียวกัน ต้องได้ชั่ง/ก้าวครั้งเดียว');
  // ลบ log ทั้งหมดที่ได้ coin ไปแล้ว → ยอดลดลงเท่าที่เคยได้ (ไม่ได้ติดค้าง)
  w.foodLogs.forEach((f) => (f.deleted = true));
  assert.equal(w.game('2026-10-16').earned, base - 10);
});

test('QA ข้อมูลที่ถูกลบ (deleted) ที่ส่งเข้า computeGame โดยตรงต้องไม่ถูกนับ รวมถึงเซ็ตที่ลบแล้ว', () => {
  const w = new World();
  w.goodFood('2026-10-14');
  const s = w.train('2026-10-14', 2, 3); // 2 ท่า 6 เซ็ต ยังไม่ถึงเกณฑ์
  assert.equal(coinsOf(w.game('2026-10-16'), '2026-10-14', 'workout'), 0);
  // เพิ่มเซ็ตอีก 4 ท่า แต่ทุกเซ็ตถูกลบแล้ว (deleted) → ต้องยังไม่ถึงเกณฑ์
  for (let e = 3; e <= 6; e++) w.sets.push(w.rec({ date: '2026-10-14', session_id: s.id, exercise_id: `ex${e}`, order: 0, weight_kg: 50, reps: 8, is_warmup: false, deleted: true }));
  assert.equal(coinsOf(w.game('2026-10-16'), '2026-10-14', 'workout'), 0, 'เซ็ตที่ลบแล้วถูกนับเป็นการฝึก');
});

test('QA จดล่วงหน้า: บันทึกของ "วันพรุ่งนี้" ที่จดไว้วันนี้ ไม่ควรได้ coin เมื่อถึงวันนั้น', () => {
  // แอปให้เลื่อนไปวันที่ในอนาคตแล้วจดได้ (common.js dateNav ไม่มีเพดาน) → จดอาหาร/ฝึก/ชั่งของพรุ่งนี้ไว้ล่วงหน้าตอนนี้
  const w = new World();
  const created = { created_at: at('2026-10-19') };
  w.food('2026-10-20', 'เช้า', 700, 50, created);
  w.food('2026-10-20', 'เย็น', 1300, 80, created);
  w.train('2026-10-20', 4, 3, { extra: created, setExtra: created });
  w.body('2026-10-20', { weight_kg: 80, steps: 9000 }, created);
  const g = w.game('2026-10-21'); // วันพรุ่งนี้ผ่านไปแล้ว
  assert.equal(g.earned, 0);
});

test('QA เซ็ตที่เติมทีหลัง (>2 วัน) ในครั้งฝึกที่สร้างตรงเวลา ต้องไม่ได้ coin PR', () => {
  const w = new World();
  // ครั้งที่ 1 (6 ต.ค.): 50 กก. × 8 จดตรงเวลา · ครั้งที่ 2 (13 ต.ค.): สร้าง session ตรงเวลา แต่เติมเซ็ต 70 กก. × 8 ทีหลังเมื่อ 20 ต.ค.
  w.train('2026-10-06', 1, 3, { weight: 50, reps: 8 });
  const s = w.train('2026-10-13', 1, 1, { weight: 50, reps: 8 });
  w.sets.push(w.rec({ date: '2026-10-13', session_id: s.id, exercise_id: 'ex1', order: 5, weight_kg: 70, reps: 8, is_warmup: false, created_at: at('2026-10-20') }));
  const g = w.game('2026-10-25');
  assert.equal(coinsOf(g, '2026-10-13', 'pr'), 0);
});

test('QA PR ปกติยังทำงาน (ควบคุม): 50→55 กก. ได้ +5 ต่อท่า', () => {
  const w = new World();
  w.train('2026-10-06', 1, 3, { weight: 50, reps: 8 });
  w.train('2026-10-13', 1, 3, { weight: 55, reps: 8 });
  assert.equal(coinsOf(w.game('2026-10-14'), '2026-10-13', 'pr'), 5);
});

test('QA แก้ค่าของ log ที่จดไว้ตรงเวลาทีหลังเกิน 2 วัน (เช่นจดน้อยๆ ก่อนแล้วมาแก้) ไม่ควรได้ coin เพิ่ม', { todo: 'WONTFIX: ดูแค่ created_at ตั้งใจ (เป็นมิตรกับคนที่แก้ข้อมูลผิดทีหลัง) เหตุผลอยู่ใน README หัวข้อ เกม coin และ streak' }, () => {
  const w = new World();
  // วันที่ 10 ต.ค. จดมื้อเดียว 100 kcal ตรงเวลา แล้ววันที่ 18 ต.ค. มาแก้เป็น 2 มื้อรวม 2000 + โปรตีน (แก้เรคคอร์ดเดิม + เพิ่มมื้อ → มื้อเพิ่มมี created_at ใหม่ จึงไม่ได้)
  const f = w.food('2026-10-10', 'เช้า', 100, 0);
  const g1 = w.game('2026-10-12');
  assert.equal(g1.earned, 0);
  f.kcal = 2000;
  f.protein = 130;
  f.updated_at = at('2026-10-18'); // แก้ 8 วันหลัง
  // ต้องเพิ่มอีกมื้อให้ครบ 2 มื้อ — ใช้มื้อที่ 2 ที่ "จดตรงเวลา" เป็น 0 kcal เพื่อให้นับมื้อ
  w.food('2026-10-10', 'เย็น', 0, 0);
  const g2 = w.game('2026-10-19');
  assert.equal(g2.earned, 0);
});

test('QA นาฬิกาเครื่องเดินไปอนาคตแล้วจด (created_at ในอนาคต) แล้วนาฬิกากลับมาเป็นปกติ: ข้อมูลไม่ได้ coin ใน/ไม่ทำให้เพี้ยน', () => {
  const w = new World();
  // วันที่ 19 ต.ค. จดเมื่อนาฬิกาเดินไปที่ 30 ต.ค. (created_at 30 ต.ค.) → ช้ากว่า date 11 วัน → ไม่ได้ coin แต่ไม่พัง
  w.goodFood('2026-10-19', { created_at: at('2026-10-30') });
  const g = w.game('2026-10-19');
  assert.equal(g.earned, 0);
  assert.equal(g.streak.todayStatus, 'pass', 'ไฟยังนับ (แค่ไม่ได้ coin)');
  // รายการที่ date อยู่ในอนาคต (นาฬิกาเดินไป แล้วกลับ) ไม่นับในการคำนวณวันนี้ และไม่ทำให้ไฟ/ยอดเปลี่ยน
  const w2 = new World();
  w2.goodFood('2026-10-30');
  w2.train('2026-10-30');
  w2.redeem('2026-10-30', { coins: 50, price: 50 });
  const g2 = w2.game('2026-10-19');
  assert.equal(g2.earned, 0);
  assert.equal(g2.streak.display, 0);
  assert.equal(g2.spent, 50, 'การแลกที่ลงวันที่ในอนาคตยังหัก coin (กันเปลี่ยนนาฬิกาเพื่อคืน coin)');
});

test('QA cooldown เมื่อนาฬิกาเดินไปอนาคตแล้วแลก: ย้อนกลับมาปกติยังติด cooldown ตามวันที่ที่ลงไว้ และยกเลิกไม่ได้', () => {
  const reward = { id: 'rw1', name: 'ชานม', emoji: '🧋', price: 60, kcal: 450, cooldown_days: 3, active: true };
  const red = { id: 'r1', kind: 'reward', reward_id: 'rw1', date: '2026-10-30', coins: 60, deleted: false };
  const chk = checkRedeem({ reward, balance: 999, redemptions: [red], today: '2026-10-19' });
  assert.equal(chk.ok, false);
  assert.equal(chk.cooldownLeft, 14); // 3 + 11 วัน
  assert.equal(canCancelRedemption(red, '2026-10-19'), false);
  // นาฬิกาย้อนไปอดีต: แลกชานมเมื่อวาน (ลงวันที่ 10-18) วันนี้ 10-17 → ยังติด
  const past = { ...red, date: '2026-10-18' };
  assert.equal(checkRedeem({ reward, balance: 999, redemptions: [past], today: '2026-10-17' }).ok, false);
});

test('QA แก้ราคารางวัลหลังแลก: ประวัติ/ยอดใช้ราคา ณ ตอนแลก (snapshot) ไม่เปลี่ยน', async () => {
  const created = [];
  const store = {
    uuid: () => `id${created.length}`,
    create: async (t, f) => (created.push([t, f]), { id: `r${created.length}`, created_at: at('2026-10-19'), updated_at: at('2026-10-19'), deleted: false, ...f }),
    update: async () => {},
    remove: async () => {},
  };
  const reward = { id: 'rw9', name: 'ขนม', emoji: '🍰', price: 40, kcal: 0, cooldown_days: 0, active: true };
  const { redemption } = await redeemReward(store, { reward, game: { balance: 500, freeze: { held: false, price: 30 } }, redemptions: [], today: '2026-10-19' });
  reward.price = 400; // ผู้ใช้แก้ราคาทีหลัง
  const w = new World();
  w.redemptions.push(redemption);
  const g = w.game('2026-10-20');
  assert.equal(g.spent, 40);
  assert.equal(coinTransactions(g, w.redemptions).find((t) => t.kind === 'spend').amount, -40);
});

test('QA แลกซ้ำรัวๆ ด้วยข้อมูลล่าสุด: ครั้งที่สองติด cooldown/ยอดไม่พอ → ไม่เขียนอะไรเพิ่ม', async () => {
  const rows = [];
  const store = { uuid: () => crypto.randomUUID(), create: async (t, f) => (rows.push(f), { id: `r${rows.length}`, ...f, deleted: false }), update: async () => {}, remove: async () => {} };
  const reward = { id: 'rw1', name: 'ชานม', emoji: '🧋', price: 60, kcal: 450, cooldown_days: 3, active: true };
  const game = { balance: 100, freeze: { held: false, price: 30 } };
  const first = await redeemReward(store, { reward, game, redemptions: [], today: '2026-10-19', addFood: false });
  // ผู้เรียกอ่านข้อมูลล่าสุดมาแล้ว: balance 40, redemptions มีรายการแรก
  await assert.rejects(redeemReward(store, { reward, game: { ...game, balance: 40 }, redemptions: [first.redemption], today: '2026-10-19' }), GameError);
  assert.equal(rows.length, 1);
});

test('QA แลก/ซื้อไฟสำรอง ซ้ำจาก sheet ที่เปิดค้างสองอัน (ข้อมูลเก่าชุดเดียวกัน) ต้องไม่หัก coin เกินยอด/ข้าม cooldown', async () => {
  const rows = [];
  const store = { uuid: () => crypto.randomUUID(), create: async (t, f) => (rows.push({ t, ...f }), { id: `r${rows.length}`, ...f, deleted: false }), update: async () => {}, remove: async () => {} };
  const reward = { id: 'rw1', name: 'ชาบู', emoji: '🍲', price: 150, kcal: 1200, cooldown_days: 7, active: true };
  const snapshot = { game: { balance: 200, freeze: { held: false, price: 30 } }, redemptions: [], today: '2026-10-19' };
  const results = await Promise.allSettled([redeemReward(store, { reward, ...snapshot }), redeemReward(store, { reward, ...snapshot })]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 1, `แลกชาบู 150 coin สำเร็จ ${ok} ครั้งจากยอด 200 (cooldown 7 วัน)`);
});

// ---------- 7) ความทนทาน / ประสิทธิภาพ ----------

test('QA ตั้งค่าเพี้ยน (สุ่ม): computeGame ไม่พัง ไม่มี NaN/Infinity และ ledger รวมเท่า earned', () => {
  const r = rng(7);
  const weird = [undefined, null, '', 'x', -5, 0, 0.5, 1, 3, 1e9, Infinity, NaN, '12', [], {}, true];
  const keys = Object.keys(normalizeSettings({}));
  const w = new World();
  for (const d of dateRange('2026-10-01', '2026-10-18')) {
    w.goodFood(d);
    if (r() < 0.6) w.train(d);
    if (r() < 0.3) w.body(d, { weight_kg: 80, steps: 9000 });
  }
  for (let i = 0; i < 300; i++) {
    const settings = {};
    for (const k of keys) if (r() < 0.25) settings[k] = weird[Math.floor(r() * weird.length)];
    const g = w.game('2026-10-19', { settings });
    for (const v of [g.earned, g.spent, g.balance, g.streak.run, g.streak.display, g.streak.multiplier]) assert.ok(Number.isFinite(v), JSON.stringify(settings));
    assert.equal(g.ledger.reduce((a, d) => a + d.total, 0), g.earned);
  }
});

test('QA ข้อมูลเยอะ: 3 ปี (1,095 วัน, ~3,300 เซ็ต) คำนวณเกมไม่เกิน 1.5 วินาที · วันที่เพี้ยนปี 1000 ไม่ทำให้วนยาว', () => {
  const w = new World();
  for (const d of dateRange('2023-10-20', '2026-10-18')) {
    w.goodFood(d);
    const dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (dow < 4) w.train(d, 5, 3, { weight: 40 + (d.charCodeAt(9) % 10) });
    w.body(d, { weight_kg: 80, steps: 9000 });
  }
  w.foodLogs.push({ id: 'ancient', date: '1000-01-01', meal: 'เช้า', kcal: 100, created_at: at('2026-10-01'), deleted: false });
  const t0 = performance.now();
  const g = w.game('2026-10-19');
  const ms = performance.now() - t0;
  assert.ok(g.days.length <= 4000);
  assert.ok(ms < 1500, `ใช้เวลา ${Math.round(ms)} ms`);
});

// ---------- 8) ส่งออก/นำเข้าไฟล์เวอร์ชันเก่า ----------

test('QA ไฟล์สำรองรุ่นก่อนมีเกม (version 1, ไม่มีตาราง game_settings/rewards/redemptions) นำเข้าผ่านตัวตรวจได้ และไม่ถูกสร้างตารางเกมว่างขึ้นเอง', () => {
  const t0 = '2026-10-10T00:00:00.000Z';
  const old = {
    format: DATA_FORMAT,
    version: 1,
    exported_at: t0,
    tables: {
      profile: [{ id: '00000000-0000-4000-8000-000000000001', kcal: 2000, created_at: t0, updated_at: t0, deleted: false }],
      body_logs: [{ id: 'b1', date: '2026-10-09', weight_kg: 80, created_at: t0, updated_at: t0, deleted: false }],
    },
  };
  const out = validateImport(old);
  assert.deepEqual(Object.keys(out).sort(), ['body_logs', 'profile']);
  assert.ok(TABLES.includes('rewards'));
  // ไฟล์ใหม่กว่า (version 3) ถูกปฏิเสธ และไฟล์รุ่นใหม่ที่ rewards ไม่ใช่ array ถูกปฏิเสธ
  assert.throws(() => validateImport({ ...old, version: 3 }), /ใหม่กว่า/);
  assert.throws(() => validateImport({ ...old, version: 2, tables: { rewards: 'x' } }), /array/);
});

test('QA ไฟล์นำเข้าที่มีรางวัลชื่อ/emoji แปลกๆ (XSS, ยาวมาก) ผ่านตัวตรวจเป็นข้อมูลธรรมดา (การแสดงผลใช้ text node)', () => {
  const t0 = '2026-10-10T00:00:00.000Z';
  const evil = '<img src=x onerror=alert(1)>';
  const data = { format: DATA_FORMAT, version: 2, tables: { rewards: [{ id: 'r-x', name: evil, emoji: '"><script>alert(1)</script>', price: 10, kcal: 0, cooldown_days: 0, active: true, created_at: t0, updated_at: t0, deleted: false }] } };
  assert.equal(validateImport(data).rewards[0].name, evil);
});

test('QA ราคารางวัลที่ซิงก์มาเพี้ยน (price หาย/ไม่ใช่ตัวเลข) ไม่ควรแลกได้ฟรี', () => {
  const chk = checkRedeem({ reward: { id: 'x', name: 'พัง', active: true, cooldown_days: 0 }, balance: 0, redemptions: [], today: '2026-10-19' });
  assert.equal(chk.ok, false);
});
