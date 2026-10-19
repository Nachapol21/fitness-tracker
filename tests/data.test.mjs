// ทดสอบ CSV, seed, ตัวตรวจไฟล์นำเข้า และการแคชของ service worker  รัน: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { toCSV, BOM } from '../js/csv.js';
import { seedExercises, seedFoods, seedId } from '../js/seed.js';
import { validateImport, ImportError } from '../js/db.js';
import { DATA_FORMAT, DATA_VERSION, MUSCLES, CATEGORIES, EQUIPMENT, TABLES } from '../js/constants.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('CSV: ใส่ BOM, escape เครื่องหมายคำพูด/ขึ้นบรรทัดใหม่, กัน formula injection', () => {
  const csv = toCSV([
    { id: 'a', name: 'ไข่ต้ม, ใหญ่', note: 'พูดว่า "ดี"\nบรรทัดสอง', kcal: 75, ok: true, none: null },
    { id: 'b', name: '=SUM(A1)', extra: [1, 2] },
  ]);
  assert.ok(csv.startsWith(BOM));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'id,name,note,kcal,ok,none,extra');
  assert.equal(lines[1], 'a,"ไข่ต้ม, ใหญ่","พูดว่า ""ดี""\nบรรทัดสอง",75,true,,');
  assert.equal(lines[2], "b,'=SUM(A1),,,,,\"[1,2]\"");
  assert.equal(toCSV([]), BOM + '\r\n');
});

test('seed: จำนวน, ค่าครบ, UUID คงที่และไม่ซ้ำ', () => {
  const ex = seedExercises();
  const foods = seedFoods();
  assert.ok(foods.length >= 30 && foods.length <= 40, `อาหารตั้งต้น ${foods.length} รายการ`);
  assert.ok(ex.length >= 25);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const r of [...ex, ...foods]) {
    assert.match(r.id, uuidRe);
    assert.equal(r.deleted, false);
    assert.ok(r.created_at && r.updated_at);
  }
  assert.equal(new Set([...ex, ...foods].map((r) => r.id)).size, ex.length + foods.length);
  for (const e of ex) {
    assert.ok(MUSCLES.includes(e.muscle), e.name);
    assert.ok(CATEGORIES.includes(e.category), e.name);
    assert.ok(EQUIPMENT.includes(e.equipment), e.name);
  }
  for (const f of foods) {
    assert.ok(f.kcal >= 0 && f.protein >= 0 && f.carb >= 0 && f.fat >= 0, f.name);
    assert.equal(f.estimated, true);
    // ตรวจคร่าวๆ ว่า kcal สอดคล้องกับสารอาหาร (4/4/9) ไม่เพี้ยนเกินครึ่งหนึ่ง
    const calc = f.protein * 4 + f.carb * 4 + f.fat * 9;
    if (f.kcal > 50) assert.ok(Math.abs(calc - f.kcal) / f.kcal < 0.5, `${f.name}: kcal ${f.kcal} vs คำนวณ ${calc}`);
  }
  assert.ok(foods.some((f) => f.favorite));
  assert.equal(seedId('exercise', 'Lat pulldown'), seedId('exercise', 'Lat pulldown'));
  assert.notEqual(seedId('exercise', 'Lat pulldown'), seedId('food', 'Lat pulldown'));
});

test('ตรวจไฟล์นำเข้า: รูปแบบผิดต้องถูกปฏิเสธด้วยข้อความที่อ่านเข้าใจ', () => {
  const ok = { format: DATA_FORMAT, version: DATA_VERSION, tables: { foods: [{ id: 'x', name: 'a' }] } };
  const v = validateImport(ok);
  assert.equal(v.foods[0].deleted, false);
  assert.ok(v.foods[0].created_at && v.foods[0].updated_at);
  assert.throws(() => validateImport(null), ImportError);
  assert.throws(() => validateImport({ ...ok, format: 'อื่น' }), /ไม่ใช่ไฟล์สำรอง/);
  assert.throws(() => validateImport({ ...ok, version: DATA_VERSION + 1 }), /ใหม่กว่า/);
  assert.throws(() => validateImport({ ...ok, tables: { foods: [{ name: 'ไม่มี id' }] } }), /ไม่มี id/);
  assert.throws(() => validateImport({ ...ok, tables: { foods: {} } }), /array/);
  assert.deepEqual(Object.keys(validateImport({ ...ok, tables: { unknown_table: [] } })), []); // ตารางแปลกถูกข้าม
});

test('service worker: FILES ครบทุกไฟล์ของแอปและทุกไฟล์มีอยู่จริง', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const block = sw.match(/const FILES = \[([\s\S]*?)\];/)[1];
  const files = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((f) => f !== './');
  for (const f of files) assert.ok(existsSync(join(root, f)), `sw.js อ้างถึงไฟล์ที่ไม่มี: ${f}`);
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const appFiles = [...walk(join(root, 'js')), ...walk(join(root, 'css')), ...walk(join(root, 'icons'))].map((p) => relative(root, p).replace(/\\/g, '/'));
  for (const f of [...appFiles, 'index.html', 'manifest.webmanifest']) assert.ok(files.includes(f), `ไฟล์ ${f} ยังไม่อยู่ใน FILES ของ sw.js`);
  // ห้ามแคชข้อมูลส่วนตัว
  assert.ok(!files.some((f) => f.includes('private')));
});

test('manifest และ index.html: ฟิลด์ที่ PWA/iOS ต้องมี', () => {
  const m = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(existsSync(join(root, i.src)), i.src);
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  for (const needle of ['rel="manifest"', 'apple-mobile-web-app-capable', 'rel="apple-touch-icon"', 'viewport-fit=cover', 'lang="th"']) assert.ok(html.includes(needle), needle);
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'ห้ามโหลดไฟล์จากภายนอก (CDN)');
});

test('ไม่มี CDN/URL ภายนอก และไม่มี key/secret ในโค้ด (ยกเว้นเฉพาะ URL Supabase + publishable key ใน config.js)', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const SUPABASE_URL = /https:\/\/[a-z0-9]{10,30}\.supabase\.co/g;
  const PUBLISHABLE_KEY = /sb_publishable_[A-Za-z0-9_-]+/g;
  for (const p of [...walk(join(root, 'js')), join(root, 'sw.js'), join(root, 'css', 'style.css')]) {
    const rel = relative(root, p).replaceAll('\\', '/');
    let src = readFileSync(p, 'utf8');
    if (rel === 'js/config.js') {
      // ข้อยกเว้นเดียว: URL โปรเจกต์ Supabase ของเราเอง และ publishable key (ออกแบบให้อยู่ฝั่งเว็บได้ ความปลอดภัยมาจาก RLS)
      assert.equal(src.match(SUPABASE_URL)?.length, 1, 'config.js ต้องมี URL Supabase 1 ตัวเท่านั้น');
      assert.equal(src.match(PUBLISHABLE_KEY)?.length, 1, 'config.js ต้องมี publishable key 1 ตัวเท่านั้น');
      src = src.replace(SUPABASE_URL, '').replace(PUBLISHABLE_KEY, '');
    }
    assert.ok(!/https?:\/\//.test(src.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), `${rel} มี URL ภายนอก`);
    assert.ok(!/(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]+/i.test(src), `${rel} น่าจะมี secret`);
    // service_role / secret key / JWT ห้ามอยู่ในโค้ดที่ส่งให้เบราว์เซอร์ (ตัดคอมเมนต์บรรทัดออกก่อน เพราะอธิบายคำเตือนได้)
    const code = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/service_role|sb_secret_|eyJ[A-Za-z0-9_-]{20,}/.test(code), `${rel} มี service_role/secret key/JWT`);
  }
});

test('ไฟล์นำเข้าข้อมูลเดิม (ถ้ามีในเครื่องนี้): ผ่านตัวตรวจ, id ไม่ซ้ำ, ความสัมพันธ์ครบ', { skip: !existsSync(join(root, 'private', 'initial-import.json')) }, () => {
  const data = JSON.parse(readFileSync(join(root, 'private', 'initial-import.json'), 'utf8'));
  const validated = validateImport(data);
  // ไฟล์ที่สร้างก่อนมีเกม coin ไม่มีตาราง game_settings/rewards/redemptions — ถือว่าว่าง (นำเข้าได้ปกติ)
  const t = Object.fromEntries(TABLES.map((tb) => [tb, validated[tb] ?? []]));
  for (const tb of TABLES) assert.ok(Array.isArray(t[tb]), tb);
  const ids = TABLES.flatMap((tb) => t[tb].map((r) => r.id));
  assert.equal(new Set(ids).size, ids.length, 'id ซ้ำ');
  const sessionIds = new Set(t.sessions.map((s) => s.id));
  const exIds = new Set(t.exercises.map((e) => e.id));
  for (const s of t.sets) {
    assert.ok(sessionIds.has(s.session_id), 'เซ็ตชี้ไปครั้งที่ฝึกที่ไม่มี');
    assert.ok(exIds.has(s.exercise_id), 'เซ็ตชี้ไปท่าที่ไม่มี');
    assert.ok(s.reps > 0 && s.weight_kg > 0);
  }
  for (const c of t.cardio) assert.ok(sessionIds.has(c.session_id));
  for (const tpl of t.templates) for (const i of tpl.items) assert.ok(exIds.has(i.exercise_id));
});

test('ไฟล์ JS ของแอปทุกไฟล์ผ่านการตรวจ syntax (รวมไฟล์ที่เทสต์ Node ไม่ได้ import เช่น views/*.js, app.js, sw.js)', async () => {
  const { execFileSync } = await import('node:child_process');
  const walkJs = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walkJs(join(dir, n)) : n.endsWith('.js') ? [join(dir, n)] : []));
  for (const f of [...walkJs(join(root, 'js')), join(root, 'sw.js')]) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      assert.fail(`${relative(root, f)}: ${String(e.stderr).split('\n').slice(0, 4).join(' | ')}`);
    }
  }
});
