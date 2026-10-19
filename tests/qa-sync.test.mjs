// QA อิสระ: กรณีซิงก์ที่เทสต์เดิมยังไม่ครอบคลุม ใช้ Supabase จำลอง (ไม่ติดต่อเซิร์ฟเวอร์จริง)
// เทสต์ที่ติด { todo } คือบั๊กที่ยังไม่แก้ (รายงานแยก) — ไม่ทำให้ node --test ล้ม และจะกลายเป็นผ่านเมื่อแก้แล้ว
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockSupabase } from './mock-supabase.mjs';
import { createClock, createDevice, makeUser } from './memory-device.mjs';
import { seedExercises } from '../js/seed.js';
import { PROFILE_ID } from '../js/constants.js';

const URL_ = 'https://mock-project.supabase.test';
const KEY = 'sb_publishable_mockkey';

function world(opts = {}) {
  const clock = createClock();
  const mock = createMockSupabase({ url: URL_, key: KEY, clock: clock.now, ...opts });
  const config = { url: URL_, publishableKey: KEY };
  const mkDevice = (name, extra = {}) => createDevice({ mock, clock, config, name, ...extra });
  return { clock, mock, config, mkDevice };
}
async function loggedIn(w, name, user, extra) {
  const d = w.mkDevice(name, extra);
  await d.login(user.email, user.password);
  return d;
}
/** ใส่ท่าตั้งต้น (id คงที่เหมือนกันทุกเครื่อง/ทุกบัญชี) ลงเครื่องจำลอง เหมือน db.ensureSeed() ทำ */
function seedDevice(d, n = 3) {
  for (const e of seedExercises().slice(0, n)) {
    d.tables.exercises.set(e.id, structuredClone(e));
    d.dirty.set(`exercises:${e.id}`, { key: `exercises:${e.id}`, table: 'exercises', id: e.id, tok: Math.random() });
  }
}

// ---------- บัญชีหลายบัญชี ----------

test('QA ซิงก์: ท่าตั้งต้น/โปรไฟล์ที่ id คงที่เหมือนกันทุกคน ต้องไม่ทำให้บัญชีที่สองซิงก์ค้าง', async () => {
  const w = world();
  const u1 = await makeUser(w.mock, 'one@example.com');
  const u2 = await makeUser(w.mock, 'two@example.com');
  const a = await loggedIn(w, 'A', u1);
  seedDevice(a);
  a.tables.profile.set(PROFILE_ID, { id: PROFILE_ID, created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z', deleted: false, kcal: 2000 });
  a.dirty.set(`profile:${PROFILE_ID}`, { key: `profile:${PROFILE_ID}`, table: 'profile', id: PROFILE_ID, tok: 1 });
  assert.equal((await a.sync.sync()).state, 'idle');

  const b = await loggedIn(w, 'B', u2);
  seedDevice(b);
  const own = b.create('foods', { name: 'ของบัญชี 2' });
  const st = await b.sync.sync();
  assert.equal(st.state, 'idle', `บัญชีที่สองซิงก์ไม่ได้: ${st.error}`);
  assert.ok(w.mock.rowsOf(b.auth.getSession().user.id).some((r) => r.id === own.id));
});

test('QA ซิงก์: เปลี่ยนบัญชีบนเครื่องเดิมแล้วไม่มีข้อมูลบัญชีเก่ารั่วไปบัญชีใหม่ (ทั้งส่งขึ้นและดึงลง)', async () => {
  const w = world();
  const u1 = await makeUser(w.mock, 'one@example.com');
  const u2 = await makeUser(w.mock, 'two@example.com');
  const a = await loggedIn(w, 'A', u1);
  const secret = a.create('body_logs', { date: '2026-10-18', weight_kg: 77.7, note: 'ส่วนตัว' });
  await a.sync.sync();
  const bOnServer = await loggedIn(w, 'B-other-device', u2);
  const bRec = bOnServer.create('foods', { name: 'ของบัญชี 2' });
  await bOnServer.sync.sync();

  // เครื่อง A ออกจากระบบแบบเก็บข้อมูล แล้วล็อกอินบัญชี 2 (ผู้ใช้ที่เปิดเครื่องต่อ)
  await a.auth.signOut();
  await a.login(u2.email, u2.password);
  w.mock.resetStats();
  const st = await a.sync.sync();
  assert.equal(st.errorCode, 'owner_mismatch');
  assert.equal(w.mock.stats.pushCalls, 0, 'ห้ามส่งข้อมูลบัญชีเก่าขึ้นบัญชีใหม่');
  assert.equal(w.mock.stats.pullCalls, 0, 'ห้ามดึงข้อมูลบัญชีใหม่มาปนในเครื่อง');
  assert.equal(a.get('foods', bRec.id), undefined);
  assert.ok(!w.mock.rowsOf(bOnServer.auth.getSession().user.id).some((r) => r.id === secret.id));
  // แก้ข้อมูลระหว่างอยู่ในสถานะนี้ก็ยังไม่รั่ว
  a.update('body_logs', secret.id, { weight_kg: 80 });
  await a.sync.sync();
  assert.equal(w.mock.stats.pushCalls, 0);
});

// ---------- ความทนทานตอนเซิร์ฟเวอร์ผิดพลาด ----------

test('QA ซิงก์: push ชุดแรกสำเร็จ ชุดที่สอง 500 → ชุดแรกไม่ถูกส่งซ้ำ ชุดที่สองยังค้างอยู่ แล้วรอบถัดไปส่งครบ ไม่ซ้ำไม่หาย', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  let posts = 0;
  const a = await loggedIn(w, 'A', user, {
    fetchWrap: (f) => async (input, init = {}) => {
      if ((init.method || 'GET') === 'POST' && String(input).includes('/rest/v1/sync_records') && ++posts === 2) {
        return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
      }
      return f(input, init);
    },
  });
  for (let i = 0; i < 700; i++) a.create('water_logs', { ml: i });
  let st = await a.sync.sync();
  assert.equal(st.state, 'error');
  assert.equal(st.errorCode, 'server');
  assert.equal(a.dirty.size, 200, 'ชุดที่ล้มเหลวต้องยังอยู่ในคิว');
  w.mock.resetStats();
  st = await a.sync.sync();
  assert.equal(st.state, 'idle');
  assert.deepEqual(w.mock.stats.pushBatches, [200]);
  assert.equal(w.mock.rowsOf(a.auth.getSession().user.id).filter((r) => r.collection === 'water_logs').length, 700);
});

test('QA ซิงก์: pull หน้าที่สองล้ม → ยังไม่ขยับ cursor แล้วรอบถัดไปได้ข้อมูลครบ', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  for (let i = 0; i < 1500; i++) a.create('water_logs', { ml: i });
  await a.sync.sync();
  let gets = 0;
  const b = await loggedIn(w, 'B', user, {
    fetchWrap: (f) => async (input, init = {}) => {
      if ((init.method || 'GET') === 'GET' && String(input).includes('/rest/v1/sync_records') && ++gets === 2) {
        return new Response(JSON.stringify({ message: 'boom' }), { status: 503 });
      }
      return f(input, init);
    },
  });
  let st = await b.sync.sync();
  assert.equal(st.state, 'error');
  assert.equal(await b.store.getMeta('sync_cursor'), null);
  st = await b.sync.sync();
  assert.equal(st.state, 'idle');
  assert.equal(b.tables.water_logs.size, 1500);
});

test('QA ซิงก์: แถวที่เซิร์ฟเวอร์ปฏิเสธถาวร (เช่น เวลาในไฟล์นำเข้าเสีย) ต้องไม่ทำให้ข้อมูลอื่นทั้งหมดส่งไม่ได้และดึงไม่ได้', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const other = await loggedIn(w, 'Other', user);
  const theirs = other.create('foods', { name: 'จากอีกเครื่อง' });
  await other.sync.sync();

  // จำลอง Postgres: ชุดที่มีแถว updated_at อ่านเป็น timestamptz ไม่ได้ ถูกปฏิเสธทั้งชุด (400 / 22007)
  const a = await loggedIn(w, 'A', user, {
    fetchWrap: (f) => async (input, init = {}) => {
      if ((init.method || 'GET') === 'POST' && String(init.body || '').includes('"client_updated_at":"not-a-time"')) {
        return new Response(JSON.stringify({ code: '22007', message: 'invalid input syntax for type timestamp with time zone: "not-a-time"' }), { status: 400 });
      }
      return f(input, init);
    },
  });
  const good = a.create('foods', { name: 'ปกติ' });
  // validateImport ยอมรับ updated_at เป็นสตริงอะไรก็ได้ จึงมีแถวแบบนี้เข้าคิวได้
  a.tables.foods.set('bad-1', { id: 'bad-1', created_at: 'x', updated_at: 'not-a-time', deleted: false, name: 'เสีย' });
  a.dirty.set('foods:bad-1', { key: 'foods:bad-1', table: 'foods', id: 'bad-1', tok: 1 });
  const st = await a.sync.sync();
  assert.ok(w.mock.rowsOf(a.auth.getSession().user.id).some((r) => r.id === good.id), 'รายการปกติควรขึ้นเซิร์ฟเวอร์ได้');
  assert.ok(a.get('foods', theirs.id), 'ควรดึงของอีกเครื่องมาได้');
  assert.notEqual(st.state, 'error');
});

// ---------- การแบ่งหน้าตอนข้อมูลเปลี่ยนระหว่างดึง ----------

test('QA ซิงก์: ระหว่างดึงหลายหน้า อีกเครื่องแก้แถวที่อยู่หน้าแรก → ต้องไม่ทำให้แถวอื่นถูกข้ามไปถาวร', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const ids = [];
  for (let batch = 0; batch < 4; batch++) {
    for (let i = 0; i < 500; i++) ids.push(a.create('water_logs', { ml: batch * 500 + i }).id);
    await a.sync.sync(); // แต่ละชุดได้เวลาเซิร์ฟเวอร์ต่างกัน
    w.clock.tick(60_000);
  }
  const editor = await loggedIn(w, 'Editor', user);
  await editor.sync.sync();

  let page = 0;
  const reader = await loggedIn(w, 'Reader', user, {
    fetchWrap: (f) => async (input, init = {}) => {
      const res = await f(input, init);
      if ((init.method || 'GET') === 'GET' && String(input).includes('/rest/v1/sync_records') && ++page === 1) {
        // หลังหน้าแรกถูกส่งกลับ อีกเครื่องแก้แถวแรกสุด → server_updated_at ของมันขยับไปท้ายแถว
        w.clock.tick(60_000);
        editor.update('water_logs', ids[5], { ml: 12345 });
        await editor.sync.sync();
      }
      return res;
    },
  });
  await reader.sync.sync();
  await reader.sync.sync();
  const missing = ids.filter((id) => !reader.tables.water_logs.has(id));
  assert.equal(missing.length, 0, `ขาด ${missing.length} แถว`);
});

// ---------- ลำดับเวลา / token ----------

test('QA ซิงก์: นาฬิกาเครื่องหนึ่งช้ากว่า → การแก้ทีหลัง (ตามเวลาจริง) แพ้ เป็นข้อจำกัดของ last-write-wins ตามที่ README เขียนไว้', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  const rec = a.create('foods', { name: 'ต้นฉบับ', kcal: 100 });
  await a.sync.sync();
  const b = await loggedIn(w, 'B', user);
  await b.sync.sync();
  w.clock.tick(10 * 60_000);
  a.update('foods', rec.id, { kcal: 200 }); // แก้ก่อนตามเวลาจริง
  await a.sync.sync();
  // เครื่อง B นาฬิกาช้า 1 ชม. แต่แก้ทีหลังจริง
  w.clock.set(w.clock.now() - 3600_000 + 60_000);
  b.update('foods', rec.id, { kcal: 300 });
  await b.sync.sync();
  await a.sync.sync();
  assert.equal(a.get('foods', rec.id).kcal, 200);
  assert.equal(b.get('foods', rec.id).kcal, 200, 'การแก้ทีหลังจริงหายไปเงียบๆ (ยอมรับได้ตาม LWW แต่ควรบอกผู้ใช้ให้ตั้งเวลาอัตโนมัติ)');
});

test('QA ซิงก์: ต่ออายุ token ล้มเพราะเครือข่ายหลุด (ไม่ใช่ token เสีย) ต้องไม่ถูกเด้งออกจากระบบ', async () => {
  const w = world({ ttlSec: 120 });
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  a.create('foods', { name: 'x' });
  w.clock.tick(3600_000); // token หมดอายุไปแล้ว
  w.mock.setOffline(true);
  const st = await a.sync.sync();
  assert.equal(st.state, 'offline');
  assert.ok(a.auth.getSession(), 'session ต้องยังอยู่');
  w.mock.setOffline(false);
  assert.equal((await a.sync.sync()).state, 'idle');
  assert.equal(a.dirty.size, 0);
});

test('QA ซิงก์: เซิร์ฟเวอร์ตอบ 429 → รายงานเป็นข้อความรอแล้วลองใหม่ได้ ไม่ทำข้อมูลหาย', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = await loggedIn(w, 'A', user);
  a.create('foods', { name: 'x' });
  w.mock.inject(/^POST \/rest\/v1\/sync_records/, 429, { message: 'too many' }, 1);
  let st = await a.sync.sync();
  assert.equal(st.state, 'error');
  assert.equal(st.errorCode, 'rate_limit');
  assert.equal(a.dirty.size, 1);
  st = await a.sync.sync();
  assert.equal(st.state, 'idle');
  assert.equal(a.dirty.size, 0);
});
