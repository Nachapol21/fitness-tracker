// เรคคอร์ดสรุป 🔥/🪙 สำหรับแผนที่อาณาจักร (profile/…0004) — ข้อมูลสมมติทั้งหมด ไม่ติดต่อ Supabase จริง (ใช้ mock-supabase)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createMockSupabase } from './mock-supabase.mjs';
import { createClock, createDevice, makeUser } from './memory-device.mjs';
import { World, PROFILE, handScenario } from './qa-game-helpers.mjs';
import { KINGDOM_SUMMARY_ID, PROFILE_ID, GAME_SETTINGS_ID, FOOD_PRESETS_ID, DEFAULT_GAME_SETTINGS, TABLES, DATA_FORMAT, DATA_VERSION } from '../js/constants.js';
import { computeGame } from '../js/game.js';
import { buildKingdomSummary, refreshKingdomSummary, summaryEqual, SUMMARY_KIND } from '../js/kingdom-summary.js';
import { validateImport } from '../js/db.js';

const URL_ = 'https://mock-project.supabase.test';
const KEY = 'sb_publishable_mockkey';
const TODAY = '2026-10-19';
const SETTINGS = { ...DEFAULT_GAME_SETTINGS, start_date: '2026-09-01' };
const FIELDS = ['balance', 'freezes', 'id', 'kind', 'multiplier', 'streak', 'today', 'week', 'computed_at'].sort();
const SYSTEM = new Set(['created_at', 'updated_at', 'deleted']);
const stripSystem = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !SYSTEM.has(k)));
const live = (d, t) => [...d.tables[t].values()].filter((r) => !r.deleted);

// ---------- ตัวช่วย ----------

/** load/getCurrent/save สำหรับ World ล้วน (ไม่มีเครื่อง) */
function worldIO(w, { settings = SETTINGS, profile = PROFILE } = {}) {
  const box = { rec: null, saves: [] };
  return {
    box,
    args: {
      load: async () => ({ data: { food_logs: w.foodLogs, body_logs: w.bodyLogs, sessions: w.sessions, sets: w.sets, cardio: w.cardio, exercises: w.exercises, redemptions: w.redemptions }, profile, settings }),
      getCurrent: async () => box.rec,
      save: async (f) => {
        box.saves.push(f);
        box.rec = { ...f, created_at: 'x', updated_at: 'x', deleted: false };
      },
      asOf: TODAY,
    },
  };
}

/** วันนี้มีมื้อที่มีแคล 1 มื้อ + มื้อที่ยังไม่มีแคล 2 มื้อ (ชื่ออาหารสมมติ) */
function worldWithToday() {
  const w = handScenario();
  w.food(TODAY, 'เช้า', 700, 40, { name: 'ข้าวมันไก่' });
  w.food(TODAY, 'กลางวัน', null, 0, { name: 'ก๋วยเตี๋ยวเรือ', kcal_missing: true });
  w.food(TODAY, 'เย็น', null, 0, { name: 'สุกี้', kcal_missing: true });
  w.body(TODAY, { weight_kg: 81.3, note: 'นอนน้อย กินเค็ม' });
  return w;
}

/** เครื่องจำลองที่ผูกตะขอสรุปเหมือน js/sync-service.js (อ่านจากตารางของเครื่อง) */
function summaryHook(d, clock, calls = []) {
  return () =>
    refreshKingdomSummary({
      load: async () => ({
        data: Object.fromEntries(TABLES.map((t) => [t, live(d, t)])),
        profile: { ...(d.get('profile', PROFILE_ID) || {}) }, // อ่านด้วย id เท่านั้น เหมือน db.getProfile
        settings: d.get('game_settings', GAME_SETTINGS_ID) || SETTINGS,
      }),
      getCurrent: async () => {
        const r = d.get('profile', KINGDOM_SUMMARY_ID);
        return r && !r.deleted ? r : null;
      },
      save: async (f) => {
        calls.push(f);
        const { id, ...rest } = f;
        return d.get('profile', id) ? d.update('profile', id, { ...rest, deleted: false }) : d.create('profile', { ...rest, id });
      },
      asOf: TODAY,
      now: new Date(clock.now()).toISOString(),
    });
}

function world() {
  const clock = createClock('2026-10-19T05:00:00.000Z'); // 12:00 เวลาไทยของวันนี้
  const mock = createMockSupabase({ url: URL_, key: KEY, clock: clock.now });
  const config = { url: URL_, publishableKey: KEY };
  const calls = { A: [], B: [] };
  const mk = (name, withHook = true) => createDevice({ mock, clock, config, name, onSynced: withHook ? (d) => summaryHook(d, clock, calls[name])() : undefined });
  return { clock, mock, config, calls, mk };
}

// ---------- 1) ค่าตรงกับ computeGame ----------

test('สรุป: ทุกฟิลด์ตรงกับ computeGame/การ์ดเกม และมีรูปแบบครบตามที่ตกลง', async () => {
  const w = worldWithToday();
  const io = worldIO(w);
  assert.equal(await refreshKingdomSummary({ ...io.args, now: '2026-10-19T05:00:00.000Z' }), true);
  const rec = io.box.rec;
  const g = computeGame(w.input(TODAY, { settings: SETTINGS }));

  assert.deepEqual(Object.keys(rec).filter((k) => !SYSTEM.has(k)).sort(), FIELDS);
  assert.equal(rec.id, KINGDOM_SUMMARY_ID);
  assert.equal(rec.kind, SUMMARY_KIND);
  assert.equal(rec.kind, 'kingdom_summary');
  assert.equal(rec.balance, g.balance);
  assert.equal(rec.streak.daily, g.streak.display, 'ไฟรายวันใช้ค่าที่การ์ดแสดง (display)');
  assert.equal(rec.streak.weekly, g.streak.weeks);
  assert.deepEqual(Object.keys(rec.streak).sort(), ['daily', 'weekly']);
  assert.equal(rec.multiplier, g.streak.multiplier);
  assert.equal(rec.freezes, g.freeze.held ? 1 : 0);
  assert.deepEqual(rec.week, { sessions: g.streak.weekCount, target: g.streak.weekTarget });
  assert.deepEqual(Object.keys(rec.today).sort(), ['date', 'kcal', 'kcal_missing', 'kcal_target', 'protein', 'protein_min']);
  assert.equal(rec.today.date, TODAY);
  assert.equal(rec.today.kcal, g.today.kcal);
  assert.equal(rec.today.kcal, 700);
  assert.equal(rec.today.protein, g.today.protein);
  assert.equal(rec.today.kcal_target, PROFILE.kcal);
  assert.equal(rec.today.protein_min, PROFILE.protein_min);
  assert.equal(rec.today.kcal_missing, g.today.missingKcalMeals);
  assert.equal(rec.today.kcal_missing, 2);
  assert.equal(rec.computed_at, '2026-10-19T05:00:00.000Z');
  // ตัวเลขทั้งหมดเป็น number จริง (ไม่ใช่สตริง/NaN)
  for (const v of [rec.balance, rec.multiplier, rec.freezes, rec.streak.daily, rec.streak.weekly, rec.week.sessions, rec.week.target, rec.today.kcal, rec.today.protein, rec.today.kcal_missing]) assert.ok(Number.isFinite(v));
});

test('สรุป: ไฟสำรองที่ถืออยู่ = freezes 1 · ไม่มีเป้าในโปรไฟล์ = kcal_target/protein_min เป็น null (ไม่ใช่ 0)', async () => {
  const w = worldWithToday();
  w.freeze('2026-10-18');
  const g = computeGame(w.input(TODAY, { settings: SETTINGS }));
  const io = worldIO(w);
  await refreshKingdomSummary(io.args);
  assert.equal(io.box.rec.freezes, g.freeze.held ? 1 : 0);

  const empty = new World();
  const io2 = worldIO(empty, { profile: {} });
  await refreshKingdomSummary(io2.args);
  assert.equal(io2.box.rec.today.kcal_target, null);
  assert.equal(io2.box.rec.today.protein_min, null);
  assert.equal(io2.box.rec.today.kcal, 0);
  assert.equal(io2.box.rec.balance, 0);
});

// ---------- 2) เขียนเฉพาะเมื่อค่าเปลี่ยน ----------

test('สรุป: ค่าไม่เปลี่ยน = ไม่เขียนซ้ำ (แม้ computed_at ต่าง และแม้เซิร์ฟเวอร์เรียงคีย์ jsonb ใหม่)', async () => {
  const w = worldWithToday();
  const io = worldIO(w);
  assert.equal(await refreshKingdomSummary({ ...io.args, now: '2026-10-19T05:00:00.000Z' }), true);
  assert.equal(await refreshKingdomSummary({ ...io.args, now: '2026-10-19T09:00:00.000Z' }), false);
  assert.equal(await refreshKingdomSummary({ ...io.args, now: '2026-10-19T09:00:01.000Z' }), false);
  assert.equal(io.box.saves.length, 1);

  // คีย์เรียงต่างจากที่เราเขียน (เหมือน jsonb) ก็ยังถือว่าเหมือนเดิม
  const r = io.box.rec;
  io.box.rec = { week: r.week, today: Object.fromEntries(Object.entries(r.today).reverse()), streak: { weekly: r.streak.weekly, daily: r.streak.daily }, freezes: r.freezes, multiplier: r.multiplier, balance: r.balance, kind: r.kind, id: r.id, computed_at: 'เก่า', created_at: 'x', updated_at: 'x', deleted: false };
  assert.equal(await refreshKingdomSummary(io.args), false);
  assert.equal(io.box.saves.length, 1);
});

test('สรุป: แต่ละฟิลด์ที่เปลี่ยนทำให้เขียนใหม่ (และเขียนแค่ครั้งเดียวต่อการเปลี่ยน)', async () => {
  const w = worldWithToday();
  const io = worldIO(w);
  await refreshKingdomSummary(io.args);
  const n0 = io.box.saves.length;

  w.food(TODAY, 'ของว่าง', 100, 5, { name: 'นม' }); // kcal/protein เปลี่ยน
  assert.equal(await refreshKingdomSummary(io.args), true);
  assert.equal(io.box.rec.today.kcal, 800);
  assert.equal(await refreshKingdomSummary(io.args), false);

  w.foodLogs.find((l) => l.name === 'สุกี้').deleted = true; // kcal_missing เปลี่ยน
  assert.equal(await refreshKingdomSummary(io.args), true);
  assert.equal(io.box.rec.today.kcal_missing, 1);

  w.redeem(TODAY, { coins: 7, price: 7, kcal: 0 }); // balance เปลี่ยน
  assert.equal(await refreshKingdomSummary(io.args), true);
  assert.equal(await refreshKingdomSummary(io.args), false);
  assert.equal(io.box.saves.length, n0 + 3);

  // วันเปลี่ยน → today.date เปลี่ยน → เขียนใหม่
  assert.equal(await refreshKingdomSummary({ ...io.args, asOf: '2026-10-20' }), true);
  assert.equal(io.box.rec.today.date, '2026-10-20');
});

test('summaryEqual: ข้ามเฉพาะ computed_at/ฟิลด์ระบบ · null/ถูกลบ = ไม่เท่า', () => {
  const a = buildKingdomSummary({ game: computeGame(worldWithToday().input(TODAY, { settings: SETTINGS })), profile: PROFILE, foodLogs: [], now: 't1' });
  assert.equal(summaryEqual(a, { ...a, computed_at: 't2', updated_at: 'z', created_at: 'y', deleted: false }), true);
  assert.equal(summaryEqual(a, { ...a, balance: a.balance + 1 }), false);
  assert.equal(summaryEqual(a, { ...a, today: { ...a.today, kcal_missing: a.today.kcal_missing + 1 } }), false);
  assert.equal(summaryEqual(a, { ...a, streak: { ...a.streak, daily: a.streak.daily + 1 } }), false);
  assert.equal(summaryEqual(a, null), false);
  assert.equal(summaryEqual(null, a), false);
});

// ---------- 3) ไม่มีข้อมูลอ่อนไหว ----------

test('สรุป: ไม่มีน้ำหนักตัว/ชื่ออาหาร/โน้ต/ข้อมูลโปรไฟล์ส่วนตัวในเรคคอร์ด', async () => {
  const w = worldWithToday();
  const profile = { ...PROFILE, sex: 'male', age: 31, height_cm: 178, calc_weight_kg: 82.4, fat: 60, carb: 200 };
  const io = worldIO(w, { profile });
  await refreshKingdomSummary(io.args);
  const text = JSON.stringify(io.box.rec);
  for (const bad of ['ข้าวมันไก่', 'ก๋วยเตี๋ยวเรือ', 'สุกี้', 'นอนน้อย', 'กินเค็ม', '81.3', '82.4', '178', 'weight', 'waist', 'note', 'name', 'age', 'height', 'sex', 'steps', 'meal']) {
    assert.ok(!text.includes(bad), `เรคคอร์ดสรุปไม่ควรมี "${bad}": ${text}`);
  }
  assert.deepEqual(Object.keys(stripSystem(io.box.rec)).sort(), FIELDS);
  // ฟิลด์ใต้ today/streak/week ก็ครบพอดี ไม่มีส่วนเกิน
  assert.deepEqual(Object.keys(io.box.rec.today).sort(), ['date', 'kcal', 'kcal_missing', 'kcal_target', 'protein', 'protein_min']);
  assert.deepEqual(Object.keys(io.box.rec.week).sort(), ['sessions', 'target']);
});

// ---------- 4) ไม่ล็อกอิน = ไม่สร้าง ----------

test('ไม่ล็อกอิน: ซิงก์ไม่ทำงาน ตะขอไม่ถูกเรียก ไม่มีเรคคอร์ดสรุป (แม้จดข้อมูลเกมแล้ว)', async () => {
  const w = world();
  const a = w.mk('A');
  a.create('food_logs', { date: TODAY, meal: 'เช้า', name: 'ข้าว', kcal: 700, protein: 30 });
  w.clock.tick(6000);
  await a.sync.sync();
  await a.sync.init();
  assert.equal(a.sync.getStatus().state, 'signed_out');
  assert.equal(w.calls.A.length, 0);
  assert.equal(a.tables.profile.has(KINGDOM_SUMMARY_ID), false);
  assert.equal(w.mock.rowsOf('nobody').length, 0);
  assert.equal(w.mock.stats.pushCalls, 0);
});

test('ตะขอไม่ถูกเรียกเมื่อซิงก์ล้มเหลว (ออฟไลน์) และตะขอที่พังไม่ทำให้ซิงก์ล้ม', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = w.mk('A');
  await a.login(user.email, user.password);
  a.create('food_logs', { date: TODAY, meal: 'เช้า', name: 'ข้าว', kcal: 700, protein: 30 });
  a.online = false;
  await a.sync.sync();
  assert.equal(w.calls.A.length, 0, 'ออฟไลน์ไม่ซิงก์สำเร็จ จึงไม่เขียนสรุป');

  const clock = createClock('2026-10-19T05:00:00.000Z');
  const mock = createMockSupabase({ url: URL_, key: KEY, clock: clock.now });
  const u2 = await makeUser(mock, 'b@example.com');
  const boom = createDevice({ mock, clock, config: { url: URL_, publishableKey: KEY }, name: 'boom', onSynced: async () => { throw new Error('พัง'); } });
  await boom.login(u2.email, u2.password);
  boom.create('food_logs', { date: TODAY, meal: 'เช้า', name: 'ข้าว', kcal: 700, protein: 30 });
  const orig = console.warn;
  console.warn = () => {};
  try {
    await boom.sync.sync();
  } finally {
    console.warn = orig;
  }
  assert.equal(boom.sync.getStatus().state, 'idle');
  assert.equal(boom.dirty.size, 0, 'ข้อมูลเดิมยังซิงก์ได้ตามปกติ');
});

// ---------- 5) ซิงก์ผ่าน mock-supabase ----------

test('ซิงก์: แถว profile/…0004 ขึ้นเซิร์ฟเวอร์พร้อมข้อมูลถูกต้อง และเครื่องอื่นได้รับ', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = w.mk('A');
  const b = w.mk('B');
  await a.login(user.email, user.password);
  await b.login(user.email, user.password);
  a.create('profile', { id: PROFILE_ID, ...PROFILE });
  a.create('game_settings', { id: GAME_SETTINGS_ID, ...SETTINGS });
  a.create('food_logs', { date: TODAY, meal: 'เช้า', name: 'ข้าวมันไก่', kcal: 700, protein: 40 });
  a.create('food_logs', { date: TODAY, meal: 'เย็น', name: 'สุกี้', kcal: null, kcal_missing: true, protein: 0 });
  a.create('body_logs', { date: TODAY, weight_kg: 81.3, note: 'ลับ' });

  w.clock.tick(5000);
  await a.sync.sync();
  const uid = a.auth.getSession().user.id;
  const row = w.mock.rowOf(uid, KINGDOM_SUMMARY_ID);
  assert.ok(row, 'แถวสรุปต้องอยู่บนเซิร์ฟเวอร์ในรอบซิงก์เดียวกัน');
  assert.equal(row.collection, 'profile');
  assert.equal(row.id, '00000000-0000-4000-8000-000000000004');
  assert.equal(row.deleted, false);
  assert.equal(row.data.kind, 'kingdom_summary');
  assert.equal(row.data.today.kcal, 700);
  assert.equal(row.data.today.kcal_missing, 1);
  assert.equal(row.data.today.kcal_target, 2000);
  assert.equal(row.data.today.protein_min, 120);
  assert.equal(row.data.today.date, TODAY);
  const sent = JSON.stringify(row.data);
  for (const bad of ['ข้าวมันไก่', 'สุกี้', '81.3', 'ลับ']) assert.ok(!sent.includes(bad), `ข้อมูลสรุปบนเซิร์ฟเวอร์รั่ว "${bad}"`);
  assert.equal(a.dirty.size, 0, 'ส่งครบแล้ว ไม่ค้างคิว');
  // ค่าบนเซิร์ฟเวอร์ตรงกับ computeGame ของข้อมูลชุดเดียวกัน
  const g = computeGame({ asOf: TODAY, profile: PROFILE, settings: SETTINGS, foodLogs: live(a, 'food_logs'), bodyLogs: live(a, 'body_logs'), sessions: [], sets: [], cardio: [], exercises: [], redemptions: [] });
  assert.equal(row.data.balance, g.balance);
  assert.equal(row.data.streak.daily, g.streak.display);

  // เครื่อง B ได้รับแถวนี้ แต่ไม่ถือเป็นโปรไฟล์: โปรไฟล์ของ B (id …0001) ยังเป็นของเดิม
  w.clock.tick(5000);
  await b.sync.sync();
  assert.equal(b.get('profile', KINGDOM_SUMMARY_ID).kind, 'kingdom_summary');
  assert.equal(b.get('profile', PROFILE_ID).kcal, 2000);
  assert.equal(b.get('profile', PROFILE_ID).kind, undefined);
});

test('ซิงก์: ไม่วนไม่รู้จบ — ซิงก์ซ้ำตอนไม่มีอะไรเปลี่ยนไม่ push อะไรเลย และสองเครื่องที่ผูกตะขอไม่ตีกัน', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = w.mk('A');
  const b = w.mk('B');
  await a.login(user.email, user.password);
  await b.login(user.email, user.password);
  a.create('profile', { id: PROFILE_ID, ...PROFILE });
  a.create('food_logs', { date: TODAY, meal: 'เช้า', name: 'ข้าว', kcal: 700, protein: 40 });
  for (let i = 0; i < 3; i++) {
    w.clock.tick(5000);
    await a.sync.sync();
    await b.sync.sync();
  }
  const writesA = w.calls.A.length;
  const writesB = w.calls.B.length;
  assert.ok(writesA >= 1);
  assert.equal(a.dirty.size + b.dirty.size, 0);

  w.mock.resetStats();
  for (let i = 0; i < 4; i++) {
    w.clock.tick(5000);
    await a.sync.sync();
    await b.sync.sync();
  }
  assert.equal(w.calls.A.length, writesA, 'A ไม่เขียนสรุปซ้ำ');
  assert.equal(w.calls.B.length, writesB, 'B ไม่เขียนสรุปซ้ำ');
  assert.equal(w.mock.stats.pushCalls, 0, 'ไม่มีอะไรให้ push');
  assert.deepEqual(a.get('profile', KINGDOM_SUMMARY_ID).today, b.get('profile', KINGDOM_SUMMARY_ID).today);

  // จดข้อมูลเพิ่ม → สรุปเปลี่ยนและขึ้นเซิร์ฟเวอร์ในรอบเดียว (เครื่องที่จด) แล้วนิ่งอีกครั้ง
  w.clock.tick(5000);
  a.create('food_logs', { date: TODAY, meal: 'เย็น', name: 'ข้าวผัด', kcal: 600, protein: 30 });
  await a.sync.sync();
  const uid = a.auth.getSession().user.id;
  assert.equal(w.mock.rowOf(uid, KINGDOM_SUMMARY_ID).data.today.kcal, 1300);
  assert.equal(a.dirty.size, 0);
  const pushed = w.mock.stats.pushCalls;
  w.clock.tick(5000);
  await a.sync.sync();
  await b.sync.sync();
  await a.sync.sync();
  assert.ok(b.get('profile', KINGDOM_SUMMARY_ID).today.kcal === 1300);
  assert.equal(a.dirty.size + b.dirty.size, 0);
  assert.ok(w.mock.stats.pushCalls - pushed <= 1, 'หลังนิ่งแล้วไม่ push เพิ่ม');
});

test('import แบบแทนที่ (ไฟล์ไม่มีเรคคอร์ดสรุป → ถูก soft delete) แล้วสร้างคืนในรอบซิงก์ถัดไป', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = w.mk('A');
  await a.login(user.email, user.password);
  a.create('profile', { id: PROFILE_ID, ...PROFILE });
  a.create('food_logs', { date: TODAY, meal: 'เช้า', name: 'ข้าว', kcal: 700, protein: 40 });
  w.clock.tick(5000);
  await a.sync.sync();
  assert.equal(live(a, 'profile').some((r) => r.id === KINGDOM_SUMMARY_ID), true);

  w.clock.tick(5000);
  a.remove('profile', KINGDOM_SUMMARY_ID); // สิ่งที่ importData(replace) ทำกับแถวที่ไม่อยู่ในไฟล์
  assert.equal(a.get('profile', KINGDOM_SUMMARY_ID).deleted, true);
  w.clock.tick(5000);
  await a.sync.sync();
  const rec = a.get('profile', KINGDOM_SUMMARY_ID);
  assert.equal(rec.deleted, false, 'ถูกสร้างคืน');
  assert.equal(rec.kind, 'kingdom_summary');
  assert.equal(w.mock.rowOf(a.auth.getSession().user.id, KINGDOM_SUMMARY_ID).deleted, false);
  assert.equal(a.dirty.size, 0);
});

// ---------- 6) เรคคอร์ดไม่ใช่โปรไฟล์/ไม่กระทบนำเข้า-ส่งออก + แอปรุ่นเก่า ----------

test('guard: …0004 ต่างจาก id อื่น · ฝั่ง js/ อ่านตาราง profile ด้วย id เท่านั้น (รวมโค้ดสรุปใหม่)', () => {
  assert.equal(KINGDOM_SUMMARY_ID, '00000000-0000-4000-8000-000000000004');
  assert.equal(new Set([PROFILE_ID, GAME_SETTINGS_ID, FOOD_PRESETS_ID, KINGDOM_SUMMARY_ID]).size, 4);
  const dir = new URL('../js/', import.meta.url);
  const files = [];
  const walk = (u) => {
    for (const e of readdirSync(u, { withFileTypes: true })) {
      if (e.isDirectory()) walk(new URL(`${e.name}/`, u));
      else if (e.name.endsWith('.js')) files.push(new URL(e.name, u));
    }
  };
  walk(dir);
  const risky = [/list\(\s*['"]profile['"]/, /listByIndex\(\s*['"]profile['"]/, /\.profile\s*\[/, /(data|all|tables|snap\w*)\.profile(?!_)/, /listDateRange\(\s*['"]profile['"]/];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of risky) assert.ok(!re.test(text), `${f.pathname.split('/js/')[1]} อ่านตาราง profile แบบเสี่ยง: ${re}`);
  }
  const db = readFileSync(new URL('db.js', dir), 'utf8');
  assert.ok(/get\('profile', PROFILE_ID\)/.test(db) && /get\('profile', KINGDOM_SUMMARY_ID\)/.test(db));
  // เขียนสรุปได้จากตะขอหลังซิงก์ที่เดียว (ไม่ถูกเรียกจากหน้าจอ/ตอนไม่ล็อกอิน)
  const users = files.filter((f) => /saveKingdomSummary|refreshKingdomSummary/.test(readFileSync(f, 'utf8'))).map((f) => f.pathname.split('/js/')[1]).sort();
  assert.deepEqual(users, ['db.js', 'kingdom-summary.js', 'sync-service.js']);
});

test('export/import: JSON ที่มีเรคคอร์ดสรุปผ่านการตรวจ (ไม่ปฏิเสธไฟล์) และไม่กระทบเกมที่คำนวณ', async () => {
  const w = worldWithToday();
  const io = worldIO(w);
  await refreshKingdomSummary(io.args);
  const file = { format: DATA_FORMAT, version: DATA_VERSION, exported_at: '2026-10-19T00:00:00.000Z', tables: { profile: [{ id: PROFILE_ID, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', deleted: false, ...PROFILE }, JSON.parse(JSON.stringify(io.box.rec)) ] } };
  file.tables.profile[1].created_at = '2026-10-19T05:00:00.000Z';
  file.tables.profile[1].updated_at = '2026-10-19T05:00:00.000Z';
  const out = validateImport(file);
  assert.equal(out.profile.length, 2);
  assert.equal(out.profile[1].kind, 'kingdom_summary');
  // เกมที่คำนวณไม่ขึ้นกับการมี/ไม่มีเรคคอร์ดสรุป (คำนวณจาก log + โปรไฟล์ id …0001 เท่านั้น)
  const before = computeGame(w.input(TODAY, { settings: SETTINGS }));
  await refreshKingdomSummary({ ...io.args, now: '2030-01-01T00:00:00.000Z' });
  assert.deepEqual(computeGame(w.input(TODAY, { settings: SETTINGS })), before);
});

test('แอปรุ่นเก่าที่ได้รับแถวสรุปจากซิงก์: เก็บลงตาราง profile ได้ ไม่พัง และโปรไฟล์/ค่าปุ่มกะเดิมไม่ถูกแตะ', async () => {
  const w = world();
  const user = await makeUser(w.mock);
  const a = w.mk('A');
  const old = w.mk('OLD', false); // เครื่องที่ไม่รู้จักเรคคอร์ดสรุป (ไม่ผูกตะขอ)
  await a.login(user.email, user.password);
  await old.login(user.email, user.password);
  a.create('profile', { id: PROFILE_ID, ...PROFILE });
  a.create('profile', { id: FOOD_PRESETS_ID, presets: { normal: { kcal: 650, protein: 30, carb: 75, fat: 24 } } });
  a.create('food_logs', { date: TODAY, meal: 'เช้า', name: 'ข้าว', kcal: 700, protein: 40 });
  w.clock.tick(5000);
  await a.sync.sync();
  w.clock.tick(5000);
  await old.sync.sync();
  assert.equal(old.get('profile', KINGDOM_SUMMARY_ID).kind, 'kingdom_summary');
  assert.equal(old.get('profile', PROFILE_ID).kcal, 2000);
  assert.equal(old.get('profile', FOOD_PRESETS_ID).presets.normal.kcal, 650);
  assert.equal(old.dirty.size, 0, 'เครื่องเก่าไม่ต้องส่งอะไรกลับ');
  assert.equal(old.sync.getStatus().state, 'idle');
});
