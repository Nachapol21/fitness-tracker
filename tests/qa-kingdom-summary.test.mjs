// QA (เก็คโค่): ตรวจเพิ่มเรคคอร์ดสรุปของแผนที่อาณาจักร (profile/…0004) — ข้อมูลสมมติ ใช้ mock-supabase ไม่ยิง Supabase จริง
// ข้อที่พบว่าไม่ผ่านติดเป็น { todo: 'BUG-FS-…' }
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockSupabase } from './mock-supabase.mjs';
import { createClock, createDevice, makeUser } from './memory-device.mjs';
import { KINGDOM_SUMMARY_ID, PROFILE_ID, GAME_SETTINGS_ID, DEFAULT_GAME_SETTINGS, TABLES } from '../js/constants.js';
import { refreshKingdomSummary } from '../js/kingdom-summary.js';

const URL_ = 'https://mock-project.supabase.test';
const KEY = 'sb_publishable_mockkey';
const SETTINGS = { ...DEFAULT_GAME_SETTINGS, start_date: '2026-09-01' };
const live = (d, t) => [...d.tables[t].values()].filter((r) => !r.deleted);

function hookFor(d, clock, state) {
  return () =>
    refreshKingdomSummary({
      load: async () => ({ data: Object.fromEntries(TABLES.map((t) => [t, live(d, t)])), profile: { ...(d.get('profile', PROFILE_ID) || {}) }, settings: d.get('game_settings', GAME_SETTINGS_ID) || SETTINGS }),
      getCurrent: async () => {
        const r = d.get('profile', KINGDOM_SUMMARY_ID);
        return r && !r.deleted ? r : null;
      },
      save: async (f) => {
        state.writes++;
        const { id, ...rest } = f;
        return d.get('profile', id) ? d.update('profile', id, { ...rest, deleted: false }) : d.create('profile', { ...rest, id });
      },
      asOf: state.asOf,
      now: new Date(clock.now()).toISOString(),
    });
}
function world(asOfs = { A: '2026-10-19', B: '2026-10-19' }) {
  const clock = createClock('2026-10-19T05:00:00.000Z');
  const mock = createMockSupabase({ url: URL_, key: KEY, clock: clock.now });
  const config = { url: URL_, publishableKey: KEY };
  const st = { A: { writes: 0, asOf: asOfs.A }, B: { writes: 0, asOf: asOfs.B } };
  const mk = (n) => createDevice({ mock, clock, config, name: n, onSynced: (d) => hookFor(d, clock, st[n])() });
  return { clock, mock, config, st, mk };
}
async function seeded(w) {
  const user = await makeUser(w.mock);
  const a = w.mk('A');
  const b = w.mk('B');
  await a.login(user.email, user.password);
  await b.login(user.email, user.password);
  a.create('profile', { id: PROFILE_ID, kcal: 2000, protein_min: 120 });
  a.create('food_logs', { date: '2026-10-19', meal: 'เช้า', name: 'ข้าว', kcal: 700, protein: 40 });
  return { user, a, b };
}

test('hook ที่คืน true ทุกครั้ง (เขียนไม่หยุด) ถูกจำกัดรอบ: ไม่เกิน 3 รอบต่อการเรียก sync() และไม่ทำให้ sync ล้ม', async () => {
  const clock = createClock();
  const mock = createMockSupabase({ url: URL_, key: KEY, clock: clock.now });
  const user = await makeUser(mock);
  let calls = 0;
  const d = createDevice({ mock, clock, config: { url: URL_, publishableKey: KEY }, name: 'loop', onSynced: async () => (++calls, true) });
  await d.login(user.email, user.password);
  d.create('food_logs', { date: '2026-10-19', meal: 'เช้า', kcal: 1 });
  calls = 0;
  await d.sync.sync();
  assert.ok(calls >= 1 && calls <= 3, `onSynced ถูกเรียก ${calls} ครั้ง`);
  assert.equal(d.sync.getStatus().state, 'idle');
  // เรียกพร้อมกันหลายครั้งก็ไม่ทำให้วนเกินสัดส่วน
  calls = 0;
  await Promise.all([d.sync.sync(), d.sync.sync(), d.sync.sync()]);
  assert.ok(calls <= 6, `พร้อมกัน 3 ครั้ง onSynced ${calls} ครั้ง`);
});

test('เซิร์ฟเวอร์ปฏิเสธแถวสรุป (400) ถาวร: ไม่เขียน/ไม่ push ซ้ำทุกรอบ และไม่ขวางข้อมูลอื่น', async () => {
  const w = world();
  const { a } = await seeded(w);
  w.mock.inject(/POST .*sync_records/, 400, { message: 'bad row' }, 1); // ชุดแรกที่ push ถูกปฏิเสธ (แยกครึ่งหาแถวเสีย)
  await a.sync.sync();
  const writes1 = w.st.A.writes;
  for (let i = 0; i < 4; i++) {
    w.clock.tick(5000);
    await a.sync.sync();
  }
  assert.ok(w.st.A.writes - writes1 <= 1, `เขียนสรุปซ้ำ ${w.st.A.writes - writes1} ครั้งหลังถูกปฏิเสธ`);
  assert.equal(a.sync.getStatus().state, 'idle');
});

test('ไม่มีข้อมูลส่วนตัวหลุดเข้าแถวสรุป: ใส่ข้อความ/ตัวเลขลับในทุกตาราง แล้วสแกนแถวที่ขึ้นเซิร์ฟเวอร์', async () => {
  const w = world();
  const { user, a } = await seeded(w);
  a.create('profile', { id: PROFILE_ID, kcal: 2000, protein_min: 120, calc_weight_kg: 77.77, height_cm: 181.55, age: 33, sex: 'male' });
  a.create('body_logs', { date: '2026-10-19', weight_kg: 77.77, note: 'SECRET-BODY-NOTE', waist_cm: 88.88 });
  a.create('food_logs', { date: '2026-10-19', meal: 'กลางวัน', name: 'SECRET-FOOD-NAME', kcal: 500, protein: 30, note: 'SECRET-FOOD-NOTE' });
  a.create('exercises', { name: 'SECRET-EXERCISE', muscle: 'x' });
  a.create('redemptions', { date: '2026-10-19', reward_name: 'SECRET-REWARD', cost: 5, note: 'SECRET-REDEEM-NOTE' });
  a.create('water_logs', { date: '2026-10-19', ml: 777 });
  w.clock.tick(5000);
  await a.sync.sync();
  const row = w.mock.rowOf(a.auth.getSession().user.id, KINGDOM_SUMMARY_ID);
  assert.ok(row, 'ต้องมีแถวสรุปบนเซิร์ฟเวอร์');
  const raw = JSON.stringify(row);
  for (const s of ['SECRET', '77.77', '181.55', '88.88', 'waist', 'male', '"age"', 'weight', 'note', 'name', '777']) assert.ok(!raw.includes(s), `พบ "${s}" ในแถวสรุป: ${raw}`);
  assert.deepEqual(Object.keys(row.data).filter((k) => !['id', 'created_at', 'updated_at', 'deleted'].includes(k)).sort(), ['balance', 'computed_at', 'freezes', 'kind', 'multiplier', 'streak', 'today', 'week']);
  assert.deepEqual(Object.keys(row.data.today).sort(), ['date', 'kcal', 'kcal_missing', 'kcal_target', 'protein', 'protein_min']);
  void user;
});

test('แถวสรุปที่ถูกลบบนเซิร์ฟเวอร์ (deleted) ถูกสร้างคืนโดยเครื่องที่ผูกตะขอ และไม่วน', async () => {
  const w = world();
  const { a, b } = await seeded(w);
  await a.sync.sync();
  await b.sync.sync();
  w.clock.tick(5000);
  b.remove('profile', KINGDOM_SUMMARY_ID); // เหมือน import แบบแทนที่บนเครื่อง B
  await b.sync.sync();
  const uid = b.auth.getSession().user.id;
  assert.equal(w.mock.rowOf(uid, KINGDOM_SUMMARY_ID).deleted, false, 'ถูกสร้างคืนในรอบเดียวกัน');
  w.clock.tick(5000);
  await a.sync.sync();
  await b.sync.sync();
  await a.sync.sync();
  assert.equal(a.dirty.size + b.dirty.size, 0);
  assert.ok(!a.get('profile', KINGDOM_SUMMARY_ID).deleted && !b.get('profile', KINGDOM_SUMMARY_ID).deleted);
});

test('สองเครื่องที่ "วันนี้" ไม่ตรงกัน (ข้ามเที่ยงคืน/คนละไทม์โซน) ไม่ควรเขียนสลับกันไม่รู้จบ', async () => {
  const w = world({ A: '2026-10-20', B: '2026-10-19' });
  const { a, b } = await seeded(w);
  for (let i = 0; i < 3; i++) {
    w.clock.tick(5000);
    await a.sync.sync();
    await b.sync.sync();
  }
  const base = w.st.A.writes + w.st.B.writes;
  for (let i = 0; i < 6; i++) {
    w.clock.tick(5000);
    await a.sync.sync();
    await b.sync.sync();
  }
  assert.equal(w.st.A.writes + w.st.B.writes, base, `เขียนสลับกัน ${w.st.A.writes + w.st.B.writes - base} ครั้งใน 6 รอบโดยไม่มีข้อมูลเปลี่ยน`);
});

test('ข้ามวัน (ไม่มีข้อมูลเปลี่ยน): แค่ today.date เปลี่ยน = เขียนใหม่ 1 ครั้งแล้วนิ่ง', async () => {
  const w = world();
  const { a } = await seeded(w);
  await a.sync.sync();
  const w0 = w.st.A.writes;
  w.st.A.asOf = '2026-10-20';
  w.clock.tick(86400000);
  await a.sync.sync();
  await a.sync.sync();
  await a.sync.sync();
  assert.equal(w.st.A.writes - w0, 1);
  assert.equal(a.get('profile', KINGDOM_SUMMARY_ID).today.date, '2026-10-20');
  assert.equal(a.dirty.size, 0);
});
