// ทดสอบการแก้ไขรอบที่ 1 หลัง QA: start_date, ราคาผิดปกติ, รีเซ็ต cursor ซิงก์, ฉลองตามที่การ์ดแสดง, ยกเลิกแล้วแลกใหม่ ฯลฯ
// ข้อมูลสมมติทั้งหมด · วันที่ตายตัว (2026-10-12 = จันทร์)
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGame, normalizeSettings, checkRedeem } from '../js/game.js';
import { redeemReward, cancelRedemption } from '../js/game-actions.js';
import { SYNC_TABLES_VERSION } from '../js/constants.js';
import { mergeRows } from '../js/lww.js';
import { createMockSupabase } from './mock-supabase.mjs';
import { createClock, createDevice, makeUser } from './memory-device.mjs';
import { World, coinsOf, dayItems, statusOf } from './qa-game-helpers.mjs';
import { dateRange } from '../js/dates.js';

test('start_date: coin นับเฉพาะวันที่ ≥ start_date ส่วนไฟนับจากประวัติทั้งหมด (รวมโบนัสรายสัปดาห์)', () => {
  const w = new World();
  for (const d of dateRange('2026-10-12', '2026-10-17')) {
    w.goodFood(d);
    w.train(d); // ฝึกทุกวัน จ–ส
  }
  const all = w.game('2026-10-18');
  assert.ok(coinsOf(all, '2026-10-12', 'workout') > 0);
  const g = w.game('2026-10-18', { settings: { start_date: '2026-10-14' } });
  assert.equal(dayItems(g, '2026-10-12').length, 0);
  assert.equal(dayItems(g, '2026-10-13').length, 0);
  assert.equal(coinsOf(g, '2026-10-14', 'workout'), 10);
  // ไฟไม่ถูกตัด: ทั้ง 6 วันผ่าน
  assert.equal(g.streak.run, 6);
  assert.equal(statusOf(g, '2026-10-12'), 'pass');
  // โบนัส 4 ครั้ง: นับเฉพาะวันฝึกตั้งแต่ start_date → ครบ 4 ที่วันที่ 17 (14, 15, 16, 17) ไม่ใช่วันที่ 15
  const bonus = g.ledger.flatMap((d) => d.items.map((i) => ({ date: d.date, ...i }))).filter((i) => i.reason === 'week_bonus');
  assert.deepEqual(bonus.map((b) => b.date), ['2026-10-17']);
  assert.equal(all.ledger.flatMap((d) => d.items).filter((i) => i.reason === 'week_bonus').length, 1);
  // ค่าที่เพี้ยนถูกมองเป็น null (นับทุกวัน)
  for (const bad of ['2026-02-30', 'x', 20261014, '', undefined]) assert.equal(normalizeSettings({ start_date: bad }).start_date, null);
  assert.equal(normalizeSettings({ start_date: '2026-10-14' }).start_date, '2026-10-14');
  // ก่อน start_date ไม่มีรายการ "ยังได้อีก" และบอกว่า coin ยังไม่เริ่ม
  const future = new World().game('2026-10-13', { settings: { start_date: '2026-10-20' } });
  assert.equal(future.today.coinStarted, false);
  assert.deepEqual(future.today.todo, []);
  assert.equal(new World().game('2026-10-20', { settings: { start_date: '2026-10-20' } }).today.coinStarted, true);
});

test('ข้อมูลที่นำเข้า (created_at = วันของมันเอง) ไม่ได้ coin ย้อนหลังถ้า start_date เป็นวันนี้', () => {
  const w = new World();
  for (const d of dateRange('2026-10-05', '2026-10-18')) {
    w.goodFood(d);
    w.train(d);
  } // created_at ตรงวันของมันพอดี (ดูเหมือนจดตรงเวลา)
  assert.ok(w.game('2026-10-19').earned > 0); // ไม่มี start_date: นับ
  const g = w.game('2026-10-19', { settings: { start_date: '2026-10-19' } });
  assert.equal(g.earned, 0);
  assert.equal(g.streak.run, 14); // แต่ไฟนับ
});

test('จดล่วงหน้า (created_at ก่อน date) ไม่ได้ coin แต่ created_at วันเดียวกันได้', () => {
  const w = new World();
  w.food('2026-10-14', 'เช้า', 1000, 70, { created_at: '2026-10-13T16:59:00.000Z' }); // 23:59 ไทยของวันที่ 13 = ก่อนวันของมัน
  w.food('2026-10-14', 'เย็น', 1000, 60, { created_at: '2026-10-13T16:59:00.000Z' });
  assert.equal(w.game('2026-10-16').earned, 0);
  const ok = new World();
  ok.food('2026-10-14', 'เช้า', 1000, 70, { created_at: '2026-10-13T17:00:00.000Z' }); // 00:00 ไทยของวันที่ 14 พอดี
  ok.food('2026-10-14', 'เย็น', 1000, 60, { created_at: '2026-10-13T17:00:00.000Z' });
  assert.equal(ok.game('2026-10-16').earned, 10);
});

test('ราคารางวัลผิดปกติ (0, ทศนิยม, ติดลบ, ข้อความ, หาย) แลกไม่ได้และบอกเหตุผล; จำนวนเต็ม ≥ 1 แลกได้', () => {
  const chk = (price) => checkRedeem({ reward: { id: 'x', price, cooldown_days: 0, active: true }, balance: 1000, redemptions: [], today: '2026-10-19' });
  for (const bad of [0, 0.5, 59.9, -5, '60', null, undefined, NaN, Infinity]) {
    const c = chk(bad);
    assert.equal(c.ok, false, String(bad));
    assert.equal(c.code, 'bad_price', String(bad));
    assert.match(c.text, /ราคารางวัลไม่ถูกต้อง/);
  }
  assert.equal(chk(1).ok, true);
  assert.equal(chk(60).ok, true);
  assert.equal(normalizeSettings({ freeze_price: 0 }).freeze_price, 1); // ไฟสำรองฟรีไม่ได้
});

test('ฉลองตามจำนวนวันที่การ์ดแสดง: displayStart เป็นวันเริ่มของไฟที่แสดง (รวมวันนี้ถ้าผ่านแล้ว)', () => {
  const w = new World();
  for (const d of dateRange('2026-10-12', '2026-10-17')) {
    w.goodFood(d);
    w.train(d);
  }
  // 6 วัน ยังไม่ถึง 7 → วันนี้ (18) จดครบแล้ว การ์ดแสดง 7
  w.goodFood('2026-10-18');
  const g = w.game('2026-10-18');
  assert.equal(g.streak.run, 6);
  assert.equal(g.streak.display, 7);
  assert.equal(g.streak.displayStart, '2026-10-12');
  // ไฟยังไม่เริ่ม (run 0) แต่วันนี้ผ่านแล้ว → เริ่มวันนี้
  const solo = new World();
  solo.goodFood('2026-10-18');
  solo.train('2026-10-18');
  const s = solo.game('2026-10-18');
  assert.equal(s.streak.run, 0);
  assert.equal(s.streak.display, 1);
  assert.equal(s.streak.displayStart, '2026-10-18');
  assert.equal(new World().game('2026-10-18').streak.displayStart, null);
});

test('คำใบ้วันฝึก/วันพักตามแผน: today.trainingDay ตามวันในสัปดาห์และตั้งค่า', () => {
  const w = new World();
  assert.equal(w.game('2026-10-12').today.trainingDay, true); // จันทร์
  assert.equal(w.game('2026-10-14').today.trainingDay, false); // พุธ
  assert.equal(w.game('2026-10-14', { settings: { training_days: [3] } }).today.trainingDay, true);
  assert.equal(w.game('2026-10-14').rest.cap, 3);
});

test('วันได้รับอนุญาตไม่กินโควตาวันพัก: วันพัก 3 วันเต็มแล้ว วันอนุญาตที่ไม่ฝึกยังผ่าน และวันพักถัดไปยังพลาดตามปกติ', () => {
  const w = new World();
  for (const d of dateRange('2026-10-12', '2026-10-18')) w.goodFood(d);
  w.train('2026-10-16'); // พักได้ 3 วัน: จ อ พ  · พฤ พัก 4 พลาด...
  w.food('2026-10-18', 'ว่าง', 1200, 0, { quick: true });
  w.redeem('2026-10-18');
  const g = w.game('2026-10-19');
  assert.deepEqual(g.days.map((d) => d.status), ['pass', 'pass', 'pass', 'miss', 'pass', 'miss', 'allowed']);
});

test('แลกแล้วยกเลิก แล้วแลกใหม่ใน store เดียวกันได้ (ความจำกันแลกซ้ำไม่ค้างรายการที่ยกเลิก)', async () => {
  const rows = [];
  const store = {
    uuid: () => crypto.randomUUID(),
    create: async (t, f) => {
      const r = { id: f.id || crypto.randomUUID(), ...f, deleted: false };
      rows.push(r);
      return r;
    },
    update: async () => {},
    remove: async (t, id) => void (rows.find((r) => r.id === id).deleted = true),
  };
  const reward = { id: 'rw', name: 'ชานม', emoji: '🧋', price: 60, kcal: 0, cooldown_days: 5, active: true };
  const game = { balance: 100, freeze: { held: false, price: 30 } };
  const a = await redeemReward(store, { reward, game, redemptions: [], today: '2026-10-19' });
  await assert.rejects(redeemReward(store, { reward, game, redemptions: [], today: '2026-10-19' }), /cooldown/); // snapshot เก่ายังไม่เห็นรายการแรก
  await cancelRedemption(store, a.redemption, { today: '2026-10-19' });
  const b = await redeemReward(store, { reward, game, redemptions: [], today: '2026-10-19' });
  assert.equal(b.redemption.coins, 60);
  // snapshot ที่โหลดใหม่ (มีรายการแล้ว) ไม่ถูกนับซ้ำ: ยอด 40 หลังหักแล้ว แลกอีกด้วยราคา 30 ได้ (ไม่ถูกหักซ้ำจนติดลบ)
  const cheap = { ...reward, id: 'rw2', price: 30, cooldown_days: 0 };
  const c = await redeemReward(store, { reward: cheap, game: { ...game, balance: 40 }, redemptions: [b.redemption], today: '2026-10-19' });
  assert.equal(c.redemption.coins, 30);
});

// ---------- ซิงก์: cursor ----------

function world() {
  const clock = createClock('2026-10-19T05:00:00.000Z');
  const mock = createMockSupabase({ url: 'https://mock.supabase.test', key: 'sb_publishable_mock', clock: clock.now });
  return { clock, mock, config: { url: 'https://mock.supabase.test', publishableKey: 'sb_publishable_mock' } };
}

test('เครื่องที่ซิงก์มาก่อนมี collection ใหม่ (ไม่มี sync_tables_version): ซิงก์ครั้งแรกด้วยรุ่นนี้ดึงใหม่จาก epoch ได้แถวเกมที่เคยถูกข้าม แล้วบันทึกเวอร์ชัน', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = createDevice({ ...w, name: 'A' });
  const b = createDevice({ ...w, name: 'B' });
  await a.login(user.email, user.password);
  await b.login(user.email, user.password);
  const rd = a.create('redemptions', { date: '2026-10-19', kind: 'reward', reward_id: 'x', name: 'นวด', emoji: '💆', price: 300, coins: 300, kcal: 0, food_log_id: null });
  await a.sync.sync();
  // จำลองเครื่องรุ่นเก่าที่เลื่อน cursor ผ่านแถวนั้นไปแล้ว (ไม่มี sync_tables_version)
  b.meta.set('sync_cursor', '2099-01-01T00:00:00.000Z');
  w.clock.tick(5000);
  await b.sync.sync();
  assert.equal(b.tables.redemptions.has(rd.id), true, 'ต้องได้แถวที่ถูกข้ามไปแล้วกลับมา');
  assert.equal(b.meta.get('sync_tables_version'), SYNC_TABLES_VERSION);
  assert.ok(b.meta.get('sync_cursor') < '2099', 'cursor ถูกตั้งใหม่ตามเซิร์ฟเวอร์');
  // รีเซ็ตครั้งเดียว: เวอร์ชันตรงแล้วไม่ดึงใหม่จากต้นอีก
  const c = createDevice({ ...w, name: 'C' });
  await c.login(user.email, user.password);
  c.meta.set('sync_tables_version', SYNC_TABLES_VERSION);
  c.meta.set('sync_cursor', '2099-01-01T00:00:00.000Z');
  w.clock.tick(5000);
  await c.sync.sync();
  assert.equal(c.tables.redemptions.size, 0, 'เวอร์ชันตรงแล้วไม่รีเซ็ต cursor');
});

test('เจอแถวของ collection ที่ไม่รู้จัก: ไม่เลื่อน cursor ผ่านแถวนั้น (อัปเกรดแล้วได้ข้อมูลครบ) และแจ้งจำนวนใน lastResult', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = createDevice({ ...w, name: 'A' });
  const b = createDevice({ ...w, name: 'B' });
  await a.login(user.email, user.password);
  await b.login(user.email, user.password);
  const KNOWN = ['body_logs'];
  const real = b.store.applyRemote;
  b.store.applyRemote = (rows) =>
    mergeRows(rows, { tables: KNOWN, get: async (t, id) => b.tables[t]?.get(id), put: async (t, rec) => void b.tables[t].set(rec.id, structuredClone(rec)) });
  const rd = a.create('redemptions', { date: '2026-10-19', kind: 'freeze', reward_id: null, name: 'ไฟสำรอง', emoji: '🧊', price: 30, coins: 30, kcal: 0, food_log_id: null });
  w.clock.tick(1000);
  a.create('body_logs', { date: '2026-10-19', weight_kg: 80 });
  await a.sync.sync();
  w.clock.tick(5000);
  const st = await b.sync.sync();
  assert.equal(st.lastResult.unknown, 1);
  // วันถัดไป มีข้อมูลใหม่อีก: cursor ยังไม่ผ่านแถวที่ไม่รู้จัก
  w.clock.tick(86400000);
  a.create('body_logs', { date: '2026-10-20', weight_kg: 79 });
  await a.sync.sync();
  w.clock.tick(5000);
  await b.sync.sync();
  b.store.applyRemote = real;
  w.clock.tick(5000);
  await b.sync.sync();
  assert.equal(b.tables.redemptions.has(rd.id), true);
});
