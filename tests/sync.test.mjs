// ทดสอบซิงก์ระหว่างเครื่อง ด้วย Supabase จำลอง (tests/mock-supabase.mjs) ไม่ติดต่อเซิร์ฟเวอร์จริง  รัน: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockSupabase } from './mock-supabase.mjs';
import { createClock, createDevice, makeUser, memStorage } from './memory-device.mjs';
import { createAuth, describeAuthError, SESSION_KEY } from '../js/auth.js';
import { mergeRows, recordToRow, rowToRecord, shouldApplyRemote, toMs } from '../js/lww.js';
import { PULL_LIMIT, PUSH_BATCH } from '../js/sync.js';
import { TABLES } from '../js/constants.js';

const URL_ = 'https://mock-project.supabase.test';
const KEY = 'sb_publishable_mockkey';
const HOUR = 3600 * 1000;

function world(opts = {}) {
  const clock = createClock();
  const mock = createMockSupabase({ url: URL_, key: KEY, clock: clock.now, ...opts });
  const config = { url: URL_, publishableKey: KEY };
  const mkDevice = (name, extra = {}) => createDevice({ mock, clock, config, name, ...extra });
  return { clock, mock, config, mkDevice };
}

async function loggedIn(w, name, user) {
  const d = w.mkDevice(name);
  await d.login(user.email, user.password);
  return d;
}

const refreshCalls = (mock) => mock.calls.filter((c) => c.path === '/auth/v1/token' && c.search.includes('refresh_token'));

// ---------- พื้นฐาน ----------

test('push/pull พื้นฐาน: ส่งขึ้นเซิร์ฟเวอร์ครบฟิลด์ แล้วอีกเครื่องดึงไปได้ครบ', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const food = a.create('foods', { name: 'ไข่ต้ม', kcal: 75 });
  w.clock.tick();
  const log = a.create('body_logs', { date: '2026-10-18', weight_kg: 80 });
  assert.equal(a.dirty.size, 2);

  const st = await a.sync.sync();
  assert.equal(st.state, 'idle');
  assert.equal(st.pending, 0);
  assert.equal(a.dirty.size, 0);
  assert.equal(st.lastResult.pushed, 2);

  const userId = a.auth.getSession().user.id;
  const rows = w.mock.rowsOf(userId);
  assert.equal(rows.length, 2);
  const row = rows.find((r) => r.id === food.id);
  assert.equal(row.collection, 'foods');
  assert.equal(row.user_id, userId);
  assert.equal(row.deleted, false);
  assert.equal(row.data.name, 'ไข่ต้ม');
  assert.equal(toMs(row.client_updated_at), toMs(food.updated_at));

  const b = await loggedIn(w, 'B', user);
  await b.sync.sync();
  assert.deepEqual(b.get('foods', food.id), food);
  assert.deepEqual(b.get('body_logs', log.id), log);
  assert.equal(b.dirty.size, 0);
});

test('รูปแบบ request: ทุก request ใส่ apikey, REST ใส่ Bearer, push ใช้ on_conflict=user_id,id + Prefer, pull ใช้ gte/order/limit และไม่ไปที่อื่นนอก Supabase', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  a.create('foods', { name: 'x' });
  await a.sync.sync();
  await a.sync.sync();
  assert.ok(w.mock.calls.length > 4);
  for (const c of w.mock.calls) {
    assert.ok(c.raw.startsWith(URL_ + '/'), `ไปที่ ${c.raw}`);
    assert.equal(c.headers.apikey, KEY);
    if (c.path.startsWith('/rest/')) assert.match(c.headers.authorization, /^Bearer at-\d+$/);
  }
  const push = w.mock.calls.find((c) => c.method === 'POST' && c.path === '/rest/v1/sync_records');
  assert.equal(new URLSearchParams(push.search).get('on_conflict'), 'user_id,id');
  assert.equal(push.headers.prefer, 'resolution=merge-duplicates,return=minimal');
  const pulls = w.mock.calls.filter((c) => c.method === 'GET' && c.path === '/rest/v1/sync_records');
  assert.ok(pulls.length >= 2);
  const q = new URLSearchParams(pulls[0].search);
  assert.equal(q.get('select'), '*');
  assert.match(q.get('server_updated_at'), /^gte\./);
  assert.match(q.get('order'), /^server_updated_at\.asc/);
  assert.equal(q.get('limit'), '1000');
  // ไม่มี DELETE เลย และไม่ส่ง server_updated_at ขึ้นไป
  assert.ok(!w.mock.calls.some((c) => c.method === 'DELETE'));
  assert.ok(!push.body.includes('"server_updated_at"'));
});

test('ครั้งที่สองไม่มีอะไรเปลี่ยน: ไม่ push อะไรอีก และมีการดึงแค่รอบเดียว', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  a.create('foods', { name: 'x' });
  await a.sync.sync();
  assert.ok(a.meta.get('sync_cursor'));
  w.mock.resetStats();
  w.clock.tick(60_000);
  await a.sync.sync();
  assert.equal(w.mock.stats.pushCalls, 0);
  assert.equal(w.mock.stats.pullCalls, 1);
});

// ---------- ขัดแย้ง ----------

test('สองเครื่องแก้เรคคอร์ดเดียวกัน: ฝั่งที่แก้ทีหลังชนะทั้งสองเครื่อง (ลำดับซิงก์แบบไหนก็ได้)', async () => {
  for (const order of ['earlier-first', 'later-first']) {
    const w = world();
    const user = await makeUser(w.mock);
    const a = await loggedIn(w, 'A', user);
    const b = await loggedIn(w, 'B', user);
    const rec = a.create('body_logs', { date: '2026-10-18', weight_kg: 80 });
    await a.sync.sync();
    await b.sync.sync();
    w.clock.tick(10_000);

    a.update('body_logs', rec.id, { weight_kg: 79 }); // แก้ก่อน
    w.clock.tick(10_000);
    b.update('body_logs', rec.id, { weight_kg: 78 }); // แก้ทีหลัง ต้องชนะ

    if (order === 'earlier-first') {
      await a.sync.sync();
      await b.sync.sync();
    } else {
      await b.sync.sync();
      await a.sync.sync(); // push ของ A เก่ากว่า เซิร์ฟเวอร์ข้ามเงียบๆ แล้ว A ดึงของ B มาแทน
    }
    await a.sync.sync();
    await b.sync.sync();
    assert.equal(a.get('body_logs', rec.id).weight_kg, 78, order);
    assert.equal(b.get('body_logs', rec.id).weight_kg, 78, order);
    assert.equal(w.mock.rowOf(a.auth.getSession().user.id, rec.id).data.weight_kg, 78, order);
    assert.equal(a.dirty.size + b.dirty.size, 0, order);
  }
});

test('แก้คนละเรคคอร์ดพร้อมกัน: ได้ครบทั้งคู่ ไม่ทับกัน', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const b = await loggedIn(w, 'B', user);
  const x = a.create('foods', { name: 'x', kcal: 1 });
  const y = a.create('foods', { name: 'y', kcal: 1 });
  await a.sync.sync();
  await b.sync.sync();
  w.clock.tick(5000);
  a.update('foods', x.id, { kcal: 100 });
  b.update('foods', y.id, { kcal: 200 });
  await a.sync.sync();
  await b.sync.sync();
  await a.sync.sync();
  for (const d of [a, b]) {
    assert.equal(d.get('foods', x.id).kcal, 100);
    assert.equal(d.get('foods', y.id).kcal, 200);
  }
});

test('soft delete ซิงก์ไปอีกเครื่อง (เรคคอร์ดยังอยู่ แต่ deleted=true) และลบที่ใหม่กว่าชนะการแก้ที่เก่ากว่า', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const b = await loggedIn(w, 'B', user);
  const r1 = a.create('water_logs', { date: '2026-10-18', ml: 250 });
  const r2 = a.create('water_logs', { date: '2026-10-18', ml: 500 });
  await a.sync.sync();
  await b.sync.sync();
  assert.equal(b.get('water_logs', r1.id).deleted, false);

  w.clock.tick(5000);
  a.remove('water_logs', r1.id);
  await a.sync.sync();
  await b.sync.sync();
  assert.equal(b.get('water_logs', r1.id).deleted, true);
  assert.equal(w.mock.rowOf(a.auth.getSession().user.id, r1.id).deleted, true);
  assert.equal(b.get('water_logs', r2.id).deleted, false);

  // r2: B แก้ก่อน แล้ว A ลบทีหลัง ลบ (ใหม่กว่า) ชนะ
  w.clock.tick(5000);
  b.update('water_logs', r2.id, { ml: 600 });
  w.clock.tick(5000);
  a.remove('water_logs', r2.id);
  await b.sync.sync();
  await a.sync.sync();
  await b.sync.sync();
  assert.equal(a.get('water_logs', r2.id).deleted, true);
  assert.equal(b.get('water_logs', r2.id).deleted, true);
});

test('ครั้งแรกที่ล็อกอินบนเครื่องที่มีข้อมูลอยู่แล้ว: รวมสองทาง ใหม่กว่าชนะรายเรคคอร์ด', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const b = w.mkDevice('B'); // มีข้อมูลก่อนล็อกอิน
  const X = crypto.randomUUID();
  const Y = crypto.randomUUID();

  // X: B มีฉบับเก่ากว่า A (สร้างก่อน)
  b.create('foods', { id: X, name: 'X-จาก-B-เก่า', kcal: 2 });
  w.clock.tick(10_000);
  a.create('foods', { id: X, name: 'X-จาก-A', kcal: 1 });
  a.create('foods', { id: Y, name: 'Y-จาก-A', kcal: 1 });
  const W = a.create('foods', { name: 'W-จาก-A', kcal: 1 });
  w.clock.tick(10_000);
  // Y: B มีฉบับใหม่กว่า A
  b.create('foods', { id: Y, name: 'Y-จาก-B', kcal: 2 });
  const Z = b.create('foods', { name: 'Z-จาก-B', kcal: 2 });
  await a.sync.sync();

  assert.equal(b.sync.getStatus().state, 'signed_out');
  await b.login(user.email, user.password);
  await b.sync.sync();
  await a.sync.sync();

  for (const d of [a, b]) {
    assert.equal(d.get('foods', X).name, 'X-จาก-A', `${d.name} X`);
    assert.equal(d.get('foods', Y).name, 'Y-จาก-B', `${d.name} Y`);
    assert.equal(d.get('foods', W.id).name, 'W-จาก-A');
    assert.equal(d.get('foods', Z.id).name, 'Z-จาก-B');
    assert.equal(d.dirty.size, 0);
  }
  assert.equal(b.meta.get('sync_owner'), a.auth.getSession().user.id);
});

test('ข้อมูลในเครื่องเป็นของบัญชีอื่น: ไม่ซิงก์ ไม่ส่งอะไรขึ้นไป และบอกเหตุผลเป็นภาษาไทย', async () => {
  const w = world();
  const u1 = await makeUser(w.mock, 'one@example.com');
  const u2 = await makeUser(w.mock, 'two@example.com');
  const a = await loggedIn(w, 'A', u1);
  a.create('foods', { name: 'ของบัญชี 1' });
  await a.sync.sync();
  await a.auth.signOut(); // ออกแบบเก็บข้อมูลในเครื่อง
  await a.login(u2.email, u2.password);
  w.mock.resetStats();
  const st = await a.sync.sync();
  assert.equal(st.state, 'error');
  assert.equal(st.errorCode, 'owner_mismatch');
  assert.match(st.error, /บัญชีอื่น/);
  assert.equal(w.mock.stats.pushCalls, 0);
});

// ---------- ออฟไลน์ ----------

test('ออฟไลน์: จดได้ตามปกติ เก็บเป็นรอส่ง ไม่ยิง request แล้วกลับมาออนไลน์ส่งครบ', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const b = await loggedIn(w, 'B', user);
  await a.sync.sync();

  a.online = false;
  w.mock.resetStats();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(a.create('food_logs', { date: '2026-10-18', name: `มื้อ ${i}`, kcal: 100 * i }).id);
    w.clock.tick();
  }
  let st = await a.sync.sync();
  assert.equal(st.state, 'offline');
  assert.equal(st.pending, 3);
  assert.equal(w.mock.calls.length, 0);

  // เครือข่ายล่ม (navigator.onLine ยังเป็น true แต่ fetch ล้มเหลว): ไม่ใช่ error ที่ต้องตกใจ
  a.online = true;
  w.mock.setOffline(true);
  st = await a.sync.sync();
  assert.equal(st.state, 'offline');
  assert.equal(st.error, null);
  assert.equal(st.pending, 3);

  w.mock.setOffline(false);
  st = await a.sync.sync();
  assert.equal(st.state, 'idle');
  assert.equal(st.pending, 0);
  assert.equal(st.lastSyncAt, new Date(w.clock.now()).toISOString());
  await b.sync.sync();
  for (const id of ids) assert.ok(b.get('food_logs', id));
});

test('ระหว่างที่กำลัง push มีการแก้ซ้ำ: ฉบับใหม่ไม่หายและไม่ถูกเคลียร์ทิ้ง', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  let rec = null;
  let fired = false;
  const a = w.mkDevice('A', {
    fetchWrap: (mockFetch, device) => async (input, init = {}) => {
      if (!fired && (init.method || 'GET') === 'POST' && String(input).includes('/rest/v1/sync_records')) {
        fired = true;
        w.clock.tick(5000);
        device.update('foods', rec.id, { kcal: 999 }); // แก้ตอนฉบับเก่ากำลังเดินทาง
      }
      return mockFetch(input, init);
    },
  });
  await a.login(user.email, user.password);
  rec = a.create('foods', { name: 'x', kcal: 1 });
  const st = await a.sync.sync();
  assert.equal(st.pending, 0);
  assert.equal(w.mock.rowOf(a.auth.getSession().user.id, rec.id).data.kcal, 999);
  assert.equal(a.get('foods', rec.id).kcal, 999);
});

// ---------- token ----------

test('token ใกล้หมดอายุ: ต่ออายุให้อัตโนมัติก่อนส่ง request แล้วซิงก์ต่อได้', async () => {
  const w = world({ ttlSec: 3600 });
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const firstToken = a.auth.getSession().access_token;
  a.create('foods', { name: 'x' });
  w.clock.tick(HOUR - 30_000); // เหลือ 30 วินาที น้อยกว่า 60 วินาทีที่ต่อล่วงหน้า
  const st = await a.sync.sync();
  assert.equal(st.state, 'idle');
  assert.equal(refreshCalls(w.mock).length, 1);
  assert.notEqual(a.auth.getSession().access_token, firstToken);
  assert.equal(a.dirty.size, 0);
  assert.equal(w.mock.rowsOf(a.auth.getSession().user.id).length, 1);
});

test('token หมดอายุไปแล้วนานๆ (เปิดแอปวันถัดไป): ต่ออายุแล้วซิงก์ได้', async () => {
  const w = world({ ttlSec: 3600 });
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  a.create('foods', { name: 'x' });
  w.clock.tick(30 * HOUR);
  const st = await a.sync.sync();
  assert.equal(st.state, 'idle');
  assert.equal(st.pending, 0);
});

test('เซิร์ฟเวอร์ตอบ 401 (ฝั่งเครื่องยังไม่รู้ว่าหมดอายุ): ต่ออายุแล้วลองใหม่ครั้งเดียวและสำเร็จ', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  a.create('foods', { name: 'x' });
  w.mock.expireAccessTokens();
  const st = await a.sync.sync();
  assert.equal(st.state, 'idle');
  assert.equal(st.pending, 0);
  assert.equal(refreshCalls(w.mock).length, 1);
  const pushes = w.mock.calls.filter((c) => c.method === 'POST' && c.path === '/rest/v1/sync_records');
  assert.deepEqual(pushes.map((c) => c.status), [401, 201]);
});

test('ต่ออายุพร้อมกันหลายที่: ยิงต่ออายุครั้งเดียว (refresh token ใช้ได้ครั้งเดียว)', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const [s1, s2, s3] = await Promise.all([a.auth.refresh(true), a.auth.refresh(true), a.auth.refresh(true)]);
  assert.equal(refreshCalls(w.mock).length, 1);
  assert.equal(s1.access_token, s2.access_token);
  assert.equal(s2.access_token, s3.access_token);
});

test('refresh token ใช้ไม่ได้แล้ว: กลับเป็นสถานะยังไม่ล็อกอิน บอกให้ล็อกอินใหม่ และข้อมูลที่รอส่งไม่หาย', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  a.create('foods', { name: 'x' });
  w.mock.expireAccessTokens();
  w.mock.revokeRefreshTokens();
  const st = await a.sync.sync();
  assert.equal(st.state, 'signed_out');
  assert.equal(st.errorCode, 'session_expired');
  assert.match(st.error, /ล็อกอินใหม่/);
  assert.equal(a.auth.getSession(), null);
  assert.equal(a.dirty.size, 1);
  // ล็อกอินใหม่แล้วส่งต่อได้
  await a.login(user.email, user.password);
  const st2 = await a.sync.sync();
  assert.equal(st2.state, 'idle');
  assert.equal(st2.pending, 0);
});

test('เซิร์ฟเวอร์ล่ม (5xx) ระหว่างต่ออายุ: คง session ไว้ แล้วลองใหม่ได้', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  a.create('foods', { name: 'x' });
  w.clock.tick(2 * HOUR);
  w.mock.inject(/^POST \/auth\/v1\/token\?grant_type=refresh_token/, 503, { message: 'down' });
  let st = await a.sync.sync();
  assert.equal(st.state, 'error');
  assert.ok(a.auth.getSession(), 'session ต้องไม่ถูกล้าง');
  st = await a.sync.sync();
  assert.equal(st.state, 'idle');
  assert.equal(st.pending, 0);
});

// ---------- ไม่วนซ้ำ ----------

test('รวมข้อมูลที่ดึงมาแล้วไม่เป็น dirty ไม่เปลี่ยน updated_at และไม่ส่งกลับขึ้นไป (ไม่วนซ้ำ)', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const b = await loggedIn(w, 'B', user);
  const recs = [];
  for (let i = 0; i < 5; i++) {
    recs.push(a.create('exercises', { name: `ท่า ${i}` }));
    w.clock.tick();
  }
  await a.sync.sync();
  w.mock.resetStats();
  for (let i = 0; i < 4; i++) {
    await b.sync.sync(); // ดึงด้วย gte ซ้ำหลายรอบ
    assert.equal(b.dirty.size, 0, `รอบ ${i}`);
  }
  assert.equal(w.mock.stats.pushCalls, 0);
  for (const r of recs) {
    assert.equal(b.get('exercises', r.id).updated_at, r.updated_at);
    assert.deepEqual(b.get('exercises', r.id), r);
  }
  const before = w.mock.records.size;
  await a.sync.sync();
  assert.equal(w.mock.stats.pushCalls, 0);
  assert.equal(w.mock.records.size, before);
});

test('schedule: ไม่ล็อกอินไม่ตั้งเวลา, เขียนติดๆ กันรวมเป็นรอบเดียว (debounce 5 วินาที) แล้วซิงก์ตอนเวลาครบ', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = w.mkDevice('A');
  a.create('foods', { name: 'ก่อนล็อกอิน' });
  assert.equal(a.timers.length, 0);

  await a.login(user.email, user.password);
  a.create('foods', { name: '1' });
  a.create('foods', { name: '2' });
  a.create('foods', { name: '3' });
  const live = a.timers.filter((t) => !t.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 5000);
  assert.equal(a.timers.length, 3);

  live[0].fn();
  await a.sync.sync(); // รอรอบที่ timer เริ่มไว้จบ
  assert.equal(a.dirty.size, 0);
  assert.equal(w.mock.rowsOf(a.auth.getSession().user.id).length, 4); // รวมที่จดก่อนล็อกอิน (ส่งตอนรวมสองทางครั้งแรก)
});

// ---------- ชุดละ 500 / หลายหน้า ----------

test('push เป็นชุดละไม่เกิน 500 แถว และ pull วนหลายหน้าจนครบ (limit 1000)', async () => {
  assert.equal(PUSH_BATCH, 500);
  assert.equal(PULL_LIMIT, 1000);
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const N = 2503;
  const tables = ['sets', 'food_logs', 'water_logs'];
  const ids = new Set();
  for (let i = 0; i < N; i++) ids.add(a.create(tables[i % 3], { n: i }).id);
  assert.equal(a.dirty.size, N);

  w.mock.resetStats();
  const st = await a.sync.sync();
  assert.equal(st.state, 'idle');
  assert.equal(st.lastResult.pushed, N);
  assert.deepEqual(w.mock.stats.pushBatches, [500, 500, 500, 500, 500, 3]);
  assert.ok(w.mock.stats.maxBatch <= 500);
  assert.equal(a.dirty.size, 0);

  const b = await loggedIn(w, 'B', user);
  w.mock.resetStats();
  await b.sync.sync();
  assert.deepEqual(w.mock.stats.pullPages, [
    { keyset: false, offset: 0, count: 1000 },
    { keyset: true, offset: 0, count: 1000 },
    { keyset: true, offset: 0, count: 503 },
  ]);
  const got = new Set(TABLES.flatMap((t) => [...b.tables[t].keys()]));
  assert.equal(got.size, N);
  for (const id of ids) assert.ok(got.has(id));
  assert.equal(b.dirty.size, 0);
});

test('จำนวนแถวพอดี 1000 ต้องดึงหน้าถัดไปอีกหน้าเพื่อยืนยันว่าหมดแล้ว', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  for (let i = 0; i < 1000; i++) a.create('water_logs', { ml: i });
  await a.sync.sync();
  const b = await loggedIn(w, 'B', user);
  w.mock.resetStats();
  await b.sync.sync();
  assert.deepEqual(w.mock.stats.pullPages, [
    { keyset: false, offset: 0, count: 1000 },
    { keyset: true, offset: 0, count: 0 },
  ]);
  assert.equal(b.tables.water_logs.size, 1000);
});

// ---------- สมัคร/ล็อกอิน ----------

test('สมัครแล้วต้องยืนยันอีเมลก่อน: ล็อกอินก่อนยืนยันได้ข้อความภาษาไทย, ไม่เก็บรหัสผ่านไว้ใน storage', async () => {
  const w = world();
  const storage = memStorage();
  const auth = createAuth({ config: w.config, fetchFn: w.mock.fetch, storage, now: w.clock.now });
  const r = await auth.signUp('new@example.com', 'my-secret-pw');
  assert.equal(r.needsConfirmation, true);
  assert.equal(auth.getSession(), null);
  await assert.rejects(() => auth.signIn('new@example.com', 'my-secret-pw'), (e) => e.code === 'email_not_confirmed' && /ยืนยันอีเมล/.test(e.message));
  w.mock.confirmEmail('new@example.com');
  await auth.signIn('new@example.com', 'my-secret-pw');
  assert.ok(auth.getSession().access_token);
  const stored = [...storage._m.values()].join('\n');
  assert.ok(stored.includes('access_token'));
  assert.ok(!stored.includes('my-secret-pw'), 'ห้ามเก็บรหัสผ่าน');
  assert.ok(storage._m.has(SESSION_KEY));
  await assert.rejects(() => auth.signIn('new@example.com', 'ผิด-ผิด'), (e) => e.code === 'invalid_credentials' && /ไม่ถูกต้อง/.test(e.message));
});

test('ปิดรับสมัคร/รหัสผ่านสั้น/อีเมลผิดรูปแบบ: ข้อความภาษาไทย', async () => {
  const w = world({ signupsDisabled: true });
  const auth = createAuth({ config: w.config, fetchFn: w.mock.fetch, storage: memStorage() });
  await assert.rejects(() => auth.signUp('a@example.com', 'secret12'), (e) => e.code === 'signup_disabled' && /ปิดรับสมัคร/.test(e.message));
  const w2 = world();
  const auth2 = createAuth({ config: w2.config, fetchFn: w2.mock.fetch, storage: memStorage() });
  await assert.rejects(() => auth2.signUp('a@example.com', '123'), (e) => e.code === 'weak_password');
  await assert.rejects(() => auth2.signUp('ไม่ใช่อีเมล', 'secret12'), (e) => e.code === 'invalid_email');
  assert.equal(describeAuthError(429, {})[0], 'rate_limit');
  assert.equal(describeAuthError(500, {})[0], 'server');
});

test('ออกจากระบบ: เรียก logout, ล้าง session, ข้อมูลในเครื่องยังอยู่ และหลังนั้นซิงก์ไม่ส่งอะไร', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  a.create('foods', { name: 'x' });
  await a.sync.sync();
  await a.auth.signOut();
  assert.equal(a.auth.getSession(), null);
  assert.ok(w.mock.calls.some((c) => c.path === '/auth/v1/logout'));
  assert.equal(a.sync.getStatus().state, 'signed_out');
  assert.equal(a.tables.foods.size, 1);
  w.mock.resetStats();
  const st = await a.sync.sync();
  assert.equal(st.state, 'signed_out');
  assert.equal(w.mock.calls.length, 0);
});

test('ออกจากระบบตอนออฟไลน์ก็ล้าง session ในเครื่องได้', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  w.mock.setOffline(true);
  await a.auth.signOut();
  assert.equal(a.auth.getSession(), null);
});

// ---------- lww.js ----------

test('lww: อ่านเวลาแบบ Postgres (ไมโครวินาที, +00) และเทียบ ISO ของเครื่องได้ถูก', () => {
  const iso = '2026-10-18T10:00:00.123Z';
  assert.equal(toMs('2026-10-18 10:00:00.123456+00'), toMs(iso));
  assert.equal(toMs('2026-10-18T10:00:00.123456+00:00'), toMs(iso));
  assert.equal(toMs('2026-10-18T17:00:00.123+07:00'), toMs(iso));
  assert.equal(toMs(null), 0);
  assert.equal(toMs('ไม่ใช่เวลา'), 0);
  assert.equal(shouldApplyRemote(null, { client_updated_at: iso }), true);
  assert.equal(shouldApplyRemote({ updated_at: iso }, { client_updated_at: iso.replace('Z', '+00:00') }), false); // เท่ากัน = คงของเดิม
  assert.equal(shouldApplyRemote({ updated_at: iso }, { client_updated_at: '2026-10-18T10:00:00.124Z' }), true);
  assert.equal(shouldApplyRemote({ updated_at: '2026-10-18T10:00:00.124Z' }, { client_updated_at: iso }), false);
});

test('lww: mergeRows idempotent, ข้ามตารางที่ไม่รู้จัก, rowToRecord คง updated_at เดิม, recordToRow ไม่ส่ง server_updated_at', async () => {
  const store = new Map();
  const io = { tables: TABLES, get: async (t, id) => store.get(`${t}:${id}`), put: async (t, r) => void store.set(`${t}:${r.id}`, r) };
  const rows = [
    { id: 'a', collection: 'foods', data: { id: 'a', name: 'x', created_at: '2026-10-18T09:00:00.000Z', updated_at: '2026-10-18T10:00:00.000Z', deleted: false }, deleted: false, client_updated_at: '2026-10-18 10:00:00.000000+00' },
    { id: 'b', collection: 'ตารางแปลก', data: {}, deleted: false, client_updated_at: '2026-10-18T10:00:00.000Z' },
    { id: 'c', collection: 'foods', data: { name: 'y' }, deleted: true, client_updated_at: '2026-10-18T11:00:00.000Z' },
  ];
  const r1 = await mergeRows(rows, io);
  assert.deepEqual(r1, { applied: 2, skipped: 1 });
  const snapshot = JSON.stringify([...store]);
  const r2 = await mergeRows(rows, io);
  assert.deepEqual(r2, { applied: 0, skipped: 3 });
  assert.equal(JSON.stringify([...store]), snapshot);
  assert.equal(store.get('foods:a').updated_at, '2026-10-18T10:00:00.000Z');
  assert.equal(store.get('foods:c').deleted, true);
  assert.equal(store.get('foods:c').updated_at, '2026-10-18T11:00:00.000Z'); // ข้อมูลเก่าไม่มี updated_at ใช้เวลาของแถวแทน
  const out = recordToRow('foods', store.get('foods:a'), 'uid');
  assert.deepEqual(Object.keys(out).sort(), ['client_updated_at', 'collection', 'data', 'deleted', 'id', 'user_id']);
  assert.equal(out.client_updated_at, '2026-10-18T10:00:00.000Z');
  assert.equal(rowToRecord(rows[0]).deleted, false);
});

// ---------- รอบแก้ 1: แถวเสีย (poison pill) ----------

test('แถวที่เซิร์ฟเวอร์ปฏิเสธถาวร (4xx): แบ่งครึ่งหาแถวเสีย กันออกจากคิว แจ้งจำนวนในสถานะ แล้วแถวอื่นส่งได้และ pull ทำงานต่อ', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  let rejecting = true;
  let badId = null;
  const a = w.mkDevice('A', {
    fetchWrap: (f) => async (input, init = {}) => {
      if (rejecting && (init.method || 'GET') === 'POST' && badId && String(init.body || '').includes(badId)) {
        return new Response(JSON.stringify({ code: '22P02', message: 'invalid input' }), { status: 400 });
      }
      return f(input, init);
    },
  });
  await a.login(user.email, user.password);
  const ids = [];
  for (let i = 0; i < 40; i++) ids.push(a.create('water_logs', { ml: i }).id);
  badId = ids[17];
  w.mock.resetStats();
  const st = await a.sync.sync();
  assert.equal(st.state, 'idle');
  assert.equal(st.rejected, 1);
  assert.equal(st.pending, 0);
  assert.equal(st.lastResult.pushed, 39);
  const sent = w.mock.rowsOf(a.auth.getSession().user.id).map((r) => r.id);
  assert.equal(sent.length, 39);
  assert.ok(!sent.includes(badId));
  assert.ok(w.mock.stats.pullCalls >= 1, 'ต้อง pull ต่อหลังกันแถวเสียออก');
  const list = await a.sync.getRejected();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, badId);
  // รอบถัดไปไม่ส่งแถวเสียซ้ำ
  w.mock.resetStats();
  await a.sync.sync();
  assert.equal(w.mock.stats.pushCalls, 0);
  // แก้รายการนั้นแล้วเซิร์ฟเวอร์รับได้ → หลุดจากรายการ "ส่งไม่ได้"
  rejecting = false;
  w.clock.tick(5000);
  a.update('water_logs', badId, { ml: 999 });
  const st2 = await a.sync.sync();
  assert.equal(st2.rejected, 0);
  assert.equal((await a.sync.getRejected()).length, 0);
  assert.equal(w.mock.rowOf(a.auth.getSession().user.id, badId).data.ml, 999);
});

test('4xx ที่ไม่ใช่ความผิดของแถว (403/401/429) ไม่แบ่งครึ่งและไม่กันแถวใดออกจากคิว', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  for (let i = 0; i < 10; i++) a.create('water_logs', { ml: i });
  w.mock.inject(/^POST \/rest\/v1\/sync_records/, 403, { message: 'denied' }, 1);
  w.mock.resetStats();
  const st = await a.sync.sync();
  assert.equal(st.state, 'error');
  assert.equal(w.mock.calls.filter((c) => c.method === 'POST' && c.path === '/rest/v1/sync_records').length, 1);
  assert.equal(a.dirty.size, 10);
  assert.equal(st.rejected, 0);
});

test('pull แบบ keyset: ไม่ส่ง offset, ใช้ค่า server_updated_at เต็ม (ไมโครวินาที) ของแถวสุดท้ายต่อหน้า', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  for (let i = 0; i < 1200; i++) a.create('water_logs', { ml: i });
  await a.sync.sync();
  const b = await loggedIn(w, 'B', user);
  w.mock.resetStats();
  await b.sync.sync();
  const gets = w.mock.calls.filter((c) => c.method === 'GET' && c.path === '/rest/v1/sync_records');
  assert.equal(gets.length, 2);
  for (const g of gets) assert.ok(!g.search.includes('offset='));
  assert.match(decodeURIComponent(gets[1].search), /or=\(server_updated_at\.gt\.\d{4}-\d\d-\d\dT[\d:]+\.\d{6}\+00:00,and\(server_updated_at\.eq\./);
});

test('คนละบัญชีมีแถว id เดียวกันได้ (PK = user_id, id) และไม่เห็นของกัน', async () => {
  const w = world();
  const u1 = await makeUser(w.mock, 'one@example.com');
  const u2 = await makeUser(w.mock, 'two@example.com');
  const a = await loggedIn(w, 'A', u1);
  const b = await loggedIn(w, 'B', u2);
  const shared = crypto.randomUUID();
  a.create('foods', { id: shared, name: 'ของ A' });
  b.create('foods', { id: shared, name: 'ของ B' });
  assert.equal((await a.sync.sync()).state, 'idle');
  assert.equal((await b.sync.sync()).state, 'idle');
  assert.equal(w.mock.rowOf(a.auth.getSession().user.id, shared).data.name, 'ของ A');
  assert.equal(w.mock.rowOf(b.auth.getSession().user.id, shared).data.name, 'ของ B');
  assert.equal(a.get('foods', shared).name, 'ของ A');
});
