// QA อิสระ (เก็คโค่ 🦎): ซิงก์ตารางเกม 3 ตัว (game_settings, rewards, redemptions) ผ่าน Supabase จำลอง (ไม่ติดต่อเซิร์ฟเวอร์จริง)
// ข้อมูลสมมติทั้งหมด · เทสต์ที่ติด { todo } คือบั๊กที่ยังไม่แก้ (รายงานแยก)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockSupabase } from './mock-supabase.mjs';
import { createClock, createDevice, makeUser } from './memory-device.mjs';
import { mergeRows } from '../js/lww.js';
import { TABLES, PROFILE_ID, GAME_SETTINGS_ID, DEFAULT_GAME_SETTINGS } from '../js/constants.js';
import { seedRewards, SEED_TIME } from '../js/seed.js';
import { computeGame, checkRedeem } from '../js/game.js';
import { PROFILE } from './qa-game-helpers.mjs';

const URL_ = 'https://mock-project.supabase.test';
const KEY = 'sb_publishable_mockkey';
const GAME_TABLES = ['game_settings', 'rewards', 'redemptions'];

function world() {
  const clock = createClock('2026-10-19T05:00:00.000Z');
  const mock = createMockSupabase({ url: URL_, key: KEY, clock: clock.now });
  const config = { url: URL_, publishableKey: KEY };
  return { clock, mock, config, mk: (name) => createDevice({ mock, clock, config, name }) };
}
async function twoDevices() {
  const w = world();
  const user = await makeUser(w.mock, 'qa@example.com');
  const a = w.mk('A');
  const b = w.mk('B');
  await a.login(user.email, user.password);
  await b.login(user.email, user.password);
  const settle = async (n = 2) => {
    for (let i = 0; i < n; i++) {
      w.clock.tick(5000);
      await a.sync.sync();
      await b.sync.sync();
    }
  };
  return { w, user, a, b, settle };
}
/** เหมือน db.ensureSeed(): ใส่รางวัลตั้งต้น (ไม่ dirty) ถ้ายังไม่มี id นั้น */
function seed(d) {
  for (const r of seedRewards()) if (!d.tables.rewards.has(r.id)) d.tables.rewards.set(r.id, structuredClone(r));
}
const liveRows = (d, t) => [...d.tables[t].values()].filter((r) => !r.deleted);
const gameOf = (d, asOf = '2026-10-19') =>
  computeGame({ asOf, profile: PROFILE, settings: liveRows(d, 'game_settings')[0], foodLogs: liveRows(d, 'food_logs'), bodyLogs: [], sessions: [], sets: [], cardio: [], exercises: [], redemptions: liveRows(d, 'redemptions') });

test('QA ซิงก์: ทั้ง 3 collection ขึ้น/ลงเซิร์ฟเวอร์ครบ พร้อมค่าฟิลด์ (รวม training_days ที่เป็น array)', async () => {
  const { w, a, b, settle } = await twoDevices();
  const gs = a.create('game_settings', { id: GAME_SETTINGS_ID, ...DEFAULT_GAME_SETTINGS, coin_workout: 12, training_days: [1, 3, 5] });
  const rw = a.create('rewards', { name: 'นวด', emoji: '💆', price: 300, kcal: 0, cooldown_days: 14, active: true });
  const rd = a.create('redemptions', { date: '2026-10-19', kind: 'reward', reward_id: rw.id, name: 'นวด', emoji: '💆', price: 300, coins: 300, kcal: 0, food_log_id: null });
  await settle();
  assert.deepEqual(b.get('game_settings', GAME_SETTINGS_ID), gs);
  assert.deepEqual(b.get('rewards', rw.id), rw);
  assert.deepEqual(b.get('redemptions', rd.id), rd);
  const rows = w.mock.rowsOf(a.auth.getSession().user.id);
  for (const t of GAME_TABLES) assert.ok(rows.some((r) => r.collection === t), `collection ${t} ต้องอยู่บนเซิร์ฟเวอร์`);
  assert.equal(a.dirty.size + b.dirty.size, 0);
});

test('QA ซิงก์ LWW ของรางวัล: เครื่องที่แก้ทีหลังชนะทั้งเรคคอร์ด, soft delete ที่ใหม่กว่าชนะ และไม่ฟื้นคืนชีพเมื่อซิงก์ซ้ำ', async () => {
  const { w, a, b, settle } = await twoDevices();
  const rw = a.create('rewards', { name: 'ชานม', emoji: '🧋', price: 60, kcal: 450, cooldown_days: 3, active: true });
  await settle();
  // ออฟไลน์ทั้งคู่: A แก้ราคา (เวลาก่อน) · B แก้ราคาอีกค่า (เวลาหลัง)
  a.online = false;
  b.online = false;
  w.clock.tick(1000);
  a.update('rewards', rw.id, { price: 80 });
  w.clock.tick(1000);
  b.update('rewards', rw.id, { price: 90 });
  a.online = true;
  b.online = true;
  await settle(3);
  assert.equal(a.get('rewards', rw.id).price, 90);
  assert.equal(b.get('rewards', rw.id).price, 90);
  // A ลบ (ใหม่กว่า) → B เห็นว่าลบ และ B ซิงก์ซ้ำก็ไม่ฟื้น
  w.clock.tick(1000);
  a.remove('rewards', rw.id);
  await settle(3);
  assert.equal(b.get('rewards', rw.id).deleted, true);
  assert.equal(a.get('rewards', rw.id).deleted, true);
  // B แก้รางวัลที่ถูกลบโดยใช้ข้อมูลเก่า (ออฟไลน์ ก่อนเห็นการลบ) — เวลาแก้เก่ากว่า → ลบยังชนะ
  const stale = structuredClone(b.get('rewards', rw.id));
  assert.equal(stale.deleted, true);
});

test('QA ซิงก์: รางวัลตั้งต้น id คงที่ — สองเครื่องที่ seed เองทั้งคู่แล้วซิงก์ ต้องไม่ซ้ำ และการแก้/ลบของเครื่องหนึ่งไม่ถูก seed ของอีกเครื่องทับ', async () => {
  const { w, a, b, settle } = await twoDevices();
  seed(a);
  seed(b);
  assert.equal(a.tables.rewards.size, 5);
  // A ลบ "ชาบู" และแก้ราคา "ชานม" ก่อนซิงก์ครั้งแรก
  const [milkTea, , shabu] = seedRewards();
  w.clock.tick(1000);
  a.update('rewards', milkTea.id, { price: 55 });
  a.remove('rewards', shabu.id);
  await settle(3);
  for (const d of [a, b]) {
    assert.equal(d.tables.rewards.size, 5, 'ต้องไม่มีรางวัลซ้ำ');
    assert.equal(d.get('rewards', milkTea.id).price, 55);
    assert.equal(d.get('rewards', shabu.id).deleted, true);
  }
  // เครื่องที่สาม (ใหม่) seed แล้วล็อกอิน: markAllDirty ส่งรางวัลตั้งต้น (เวลา SEED_TIME) ขึ้นไป — ต้องไม่ทับของที่แก้/ลบไปแล้ว
  const c = w.mk('C');
  await c.login('qa@example.com', 'secret12');
  seed(c);
  await settle(1);
  await c.sync.sync();
  await a.sync.sync();
  await b.sync.sync();
  for (const d of [a, b, c]) {
    assert.equal(d.tables.rewards.size, 5, d.name);
    assert.equal(d.get('rewards', milkTea.id).price, 55, d.name);
    assert.equal(d.get('rewards', shabu.id).deleted, true, d.name);
  }
  assert.equal(SEED_TIME < '2026-10-19', true);
});

test('QA ซิงก์: สองเครื่องแลกรางวัลเดียวกันพร้อมกันตอนออฟไลน์ → ออนไลน์แล้วหักทั้งคู่ ยอดติดลบได้แต่แลกเพิ่มไม่ได้ และ cooldown นับต่อ', async () => {
  const { w, a, b, settle } = await twoDevices();
  a.create('profile', { id: PROFILE_ID, ...PROFILE });
  // ได้ coin 16 วัน × 10 = 160
  for (let d = 3; d <= 18; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    a.create('food_logs', { date, meal: 'เช้า', kcal: 700, protein: 50, quick: false, created_at: `${date}T05:00:00.000Z` });
    a.create('food_logs', { date, meal: 'เย็น', kcal: 1300, protein: 80, quick: false });
  }
  const shabu = a.create('rewards', { name: 'ชาบู', emoji: '🍲', price: 150, kcal: 1200, cooldown_days: 7, active: true });
  // ล็อก created_at ของ food_logs ให้เป็นวันเดียวกับ date (ให้เหมือนจดตรงเวลา) แล้วค่อยซิงก์
  for (const f of a.tables.food_logs.values()) f.created_at = `${f.date}T05:00:00.000Z`;
  await settle(3);
  const base = gameOf(a);
  assert.ok(base.balance >= 150, `coin พอแลก 1 ครั้ง (มี ${base.balance})`);
  assert.ok(base.balance < 300, 'แต่ไม่พอแลก 2 ครั้ง');

  a.online = false;
  b.online = false;
  const redeem = (d) => d.create('redemptions', { date: '2026-10-19', kind: 'reward', reward_id: shabu.id, name: 'ชาบู', emoji: '🍲', price: 150, coins: 150, kcal: 1200, food_log_id: null });
  // ตรวจเงื่อนไขในเครื่องของตัวเองก่อน (เหมือน UI) — ทั้งคู่ผ่านเพราะยังไม่เห็นของกัน
  for (const d of [a, b]) assert.equal(checkRedeem({ reward: shabu, balance: gameOf(d).balance, redemptions: liveRows(d, 'redemptions'), today: '2026-10-19' }).ok, true);
  redeem(a);
  redeem(b);
  a.online = true;
  b.online = true;
  await settle(3);
  for (const d of [a, b]) {
    assert.equal(liveRows(d, 'redemptions').length, 2);
    const g = gameOf(d);
    assert.equal(g.spent, 300);
    assert.equal(g.balance, base.earned - 300);
    assert.ok(g.balance < 0, 'ยอดติดลบ (ตามดีไซน์)');
    const chk = checkRedeem({ reward: shabu, balance: g.balance, redemptions: liveRows(d, 'redemptions'), today: '2026-10-19' });
    assert.equal(chk.ok, false);
    assert.equal(chk.reasons.some((r) => r.code === 'negative'), true);
    assert.equal(chk.reasons.some((r) => r.code === 'cooldown'), true);
  }
  // ยกเลิกรายการหนึ่ง (soft delete) → ยอดกลับเป็นบวก ทั้งสองเครื่องเห็นตรงกัน
  w.clock.tick(1000);
  a.remove('redemptions', liveRows(a, 'redemptions')[0].id);
  await settle(3);
  assert.deepEqual(gameOf(a), gameOf(b));
  assert.equal(gameOf(b).spent, 150);
});

test('QA ซิงก์: สองเครื่องซื้อไฟสำรองตอนออฟไลน์ → หัก 60 แต่ถือได้ 1 อัน (ตีความข้อ 6) และไฟสำรองที่สองไม่ใช้กับวันพลาดครั้งถัดไป', async () => {
  const { a, b, settle } = await twoDevices();
  a.online = false;
  b.online = false;
  a.create('profile', { id: PROFILE_ID, ...PROFILE });
  const buy = (d, date) => d.create('redemptions', { date, kind: 'freeze', reward_id: null, name: 'ไฟสำรอง', emoji: '🧊', price: 30, coins: 30, kcal: 0, food_log_id: null });
  buy(a, '2026-10-18');
  buy(b, '2026-10-18'); // อีกเครื่องซื้อวันเดียวกันตอนออฟไลน์ (ยังไม่เห็นของกัน)
  a.online = true;
  b.online = true;
  await settle(3);
  for (const d of ['2026-10-18']) {
    a.create('food_logs', { date: d, meal: 'เช้า', kcal: 700, protein: 50, quick: false });
    a.create('food_logs', { date: d, meal: 'เย็น', kcal: 1300, protein: 80, quick: false });
  }
  await settle(3);
  for (const f of a.tables.food_logs.values()) f.created_at = `${f.date}T05:00:00.000Z`;
  const g = gameOf(a, '2026-10-19');
  assert.equal(g.spent, 60, 'หัก 30 สองครั้ง');
  assert.equal(g.freeze.held, true);
  // 19 พลาด → ใช้ไฟสำรอง 1 อัน · 20 พลาดอีก → ไฟดับ (อันที่สองที่จ่ายไปไม่เหลือให้ใช้)
  const g2 = gameOf(a, '2026-10-21');
  assert.deepEqual(g2.days.filter((d) => d.date >= '2026-10-19').map((d) => d.status), ['freeze', 'miss']);
  assert.deepEqual(gameOf(b, '2026-10-21'), g2);
});

// ผลตรวจ: เครื่องที่ยังเป็นแอปรุ่นเก่า (ยังไม่รู้จัก 3 collection ใหม่) ดึงข้อมูลแล้วข้ามแถวเกมไป แต่ยังเลื่อน sync_cursor ผ่านแถวเหล่านั้น
// พออัปเกรดแล้วดึงต่อจาก cursor เดิม → ไม่ได้ข้อมูลเกมที่มีอยู่แล้วบนเซิร์ฟเวอร์ (ยอด coin เพี้ยน ไม่ติด cooldown) จนกว่าแถวนั้นจะถูกแก้อีก
test('QA อัปเกรดทีละเครื่อง: เครื่องรุ่นเก่าซิงก์ผ่านแถวเกมไปก่อน อัปเกรดทีหลังแล้วต้องได้ข้อมูลเกมครบ', async () => {
  const { w, a, b, settle } = await twoDevices();
  // B = แอปรุ่นเก่า: ไม่รู้จัก collection เกม
  const oldTables = TABLES.filter((t) => !GAME_TABLES.includes(t));
  const newApply = b.store.applyRemote;
  b.store.applyRemote = (rows) =>
    mergeRows(rows, {
      tables: oldTables,
      get: async (t, id) => b.tables[t].get(id),
      put: async (t, rec) => {
        b.tables[t].set(rec.id, structuredClone(rec));
        b.dirty.delete(`${t}:${rec.id}`);
      },
    });
  // A (รุ่นใหม่) สร้างข้อมูลเกม + ข้อมูลอื่น แล้วซิงก์; B (รุ่นเก่า) ซิงก์ตามปกติ
  a.create('rewards', { name: 'นวด', emoji: '💆', price: 300, kcal: 0, cooldown_days: 14, active: true });
  const rd = a.create('redemptions', { date: '2026-10-19', kind: 'reward', reward_id: 'x', name: 'นวด', emoji: '💆', price: 300, coins: 300, kcal: 0, food_log_id: null });
  a.create('body_logs', { date: '2026-10-19', weight_kg: 80 });
  await settle(2);
  assert.equal(b.tables.body_logs.size, 1, 'รุ่นเก่ายังซิงก์ข้อมูลเดิมได้');
  assert.equal(b.tables.redemptions.size, 0, 'รุ่นเก่าไม่รู้จัก redemptions');
  // วันต่อมา A จดข้อมูลปกติเพิ่ม → B (ยังเป็นรุ่นเก่า) ซิงก์อีกรอบ: cursor เลื่อนพ้นแถวเกมเดิมไป (เกินช่วงเผื่อ 3 วินาที)
  w.clock.tick(86400000);
  a.create('body_logs', { date: '2026-10-20', weight_kg: 79.8 });
  await settle(2);
  assert.equal(b.tables.body_logs.size, 2);
  // B อัปเกรดเป็นรุ่นใหม่ (ใช้ applyRemote เต็ม) แล้วซิงก์
  b.store.applyRemote = newApply;
  w.clock.tick(60000);
  await b.sync.sync();
  await b.sync.sync();
  assert.equal(b.tables.redemptions.has(rd.id), true, 'เครื่องที่อัปเกรดแล้วต้องได้การแลกที่มีอยู่บนเซิร์ฟเวอร์');
});

test('QA ซิงก์: การตั้งค่าเกมแก้พร้อมกันสองเครื่อง (LWW) ยอด coin ในอดีตคำนวณใหม่เท่ากันทั้งสองเครื่อง', async () => {
  const { w, a, b, settle } = await twoDevices();
  a.create('profile', { id: PROFILE_ID, ...PROFILE });
  const gs = a.create('game_settings', { id: GAME_SETTINGS_ID, ...DEFAULT_GAME_SETTINGS });
  a.create('food_logs', { date: '2026-10-18', meal: 'เช้า', kcal: 700, protein: 50 });
  a.create('food_logs', { date: '2026-10-18', meal: 'เย็น', kcal: 1300, protein: 80 });
  await settle(2);
  for (const d of [a, b]) for (const f of d.tables.food_logs.values()) f.created_at = `${f.date}T05:00:00.000Z`;
  a.online = false;
  b.online = false;
  w.clock.tick(1000);
  a.update('game_settings', gs.id, { coin_protein: 7 });
  w.clock.tick(1000);
  b.update('game_settings', gs.id, { coin_kcal: 9 });
  a.online = true;
  b.online = true;
  await settle(3);
  assert.deepEqual(gameOf(a), gameOf(b));
  // เรคคอร์ดเดียวทั้งก้อน: ฝั่งที่แก้ทีหลัง (B) ชนะ → coin_protein กลับเป็นค่าเดิม 5, coin_kcal = 9
  assert.equal(gameOf(a).ledger[0].items.find((i) => i.reason === 'kcal').coins, 9);
  assert.equal(gameOf(a).ledger[0].items.find((i) => i.reason === 'protein').coins, 5);
});
