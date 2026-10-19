// QA อิสระ: ส่งออก/นำเข้า, CSV, ความเป็นส่วนตัวของไฟล์ที่จะขึ้น GitHub (ข้อมูลสมมติ)
// เทสต์ที่ติด { todo } คือบั๊กที่ยังไม่แก้ (รายงานแยก) — ไม่ทำให้ node --test ล้ม
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCSV, BOM } from '../js/csv.js';
import { validateImport, ImportError } from '../js/db.js';
import { DATA_FORMAT, DATA_VERSION, TABLES } from '../js/constants.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const good = (tables = {}) => ({ format: DATA_FORMAT, version: DATA_VERSION, exported_at: '2026-10-18T00:00:00.000Z', tables });
const row = (o = {}) => ({ id: 'a1', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted: false, ...o });

// ---------- CSV ----------

test('QA CSV: ตัวขึ้นต้นสูตรทุกแบบถูกกัน (= + - @ TAB CR) ทั้งในข้อมูลและหัวคอลัมน์ แต่ตัวเลขติดลบจริงไม่ถูกแก้', () => {
  const payloads = ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '=HYPERLINK("http://evil","x")', '=cmd|\' /C calc\'!A0'];
  const csv = toCSV(payloads.map((p) => ({ name: p, kcal: -5, ok: true })));
  const table = parseCSV(csv);
  assert.deepEqual(table[0], ['name', 'kcal', 'ok']);
  assert.equal(table.length, payloads.length + 1);
  for (let i = 0; i < payloads.length; i++) {
    const [name, kcal] = table[i + 1];
    assert.ok(!/^[=+\-@\t\r]/.test(name), 'เซลล์ยังขึ้นต้นด้วยตัวอักษรสูตร: ' + JSON.stringify(name));
    assert.equal(name, "'" + payloads[i], 'ควรนำด้วย \' และคงข้อความเดิมครบ');
    assert.equal(kcal, '-5', 'ตัวเลขติดลบจริงต้องไม่ถูกแก้');
  }
  // หัวคอลัมน์ที่มาจากคีย์ในไฟล์นำเข้าก็ต้องปลอดภัย
  const hdr = toCSV([{ '=evil()': 1 }]).slice(BOM.length).split('\r\n')[0];
  assert.equal(hdr, "'=evil()");
});

test('QA CSV: เครื่องหมายคำพูด/จุลภาค/ขึ้นบรรทัดใหม่/ภาษาไทย/อาร์เรย์/ค่าว่าง และแถวที่มีคอลัมน์ไม่เท่ากัน', () => {
  const csv = toCSV([
    { a: 'ไข่ "ต้ม", 2 ฟอง', b: 'บรรทัด1\nบรรทัด2', c: ['x', 'y'] },
    { a: null, d: 0 },
  ]);
  assert.ok(csv.startsWith(BOM));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'a,b,c,d');
  assert.equal(lines[1], '"ไข่ ""ต้ม"", 2 ฟอง","บรรทัด1\nบรรทัด2","[""x"",""y""]",');
  assert.equal(lines[2], ',,,0');
  assert.equal(toCSV([]), BOM + '\r\n');
});

// ---------- ตรวจไฟล์นำเข้า ----------

test('QA นำเข้า: ไฟล์ผิดรูปแบบทุกแบบต้องถูกปฏิเสธด้วย ImportError (ไม่ใช่ TypeError ที่อ่านไม่ออก) ก่อนแตะข้อมูลเดิม', () => {
  const bad = [
    null, undefined, 42, 'text', [], {},
    { format: 'other', version: 1, tables: {} },
    { format: DATA_FORMAT, tables: {} },
    { format: DATA_FORMAT, version: '1', tables: {} },
    { format: DATA_FORMAT, version: DATA_VERSION + 1, tables: {} },
    { format: DATA_FORMAT, version: DATA_VERSION },
    { format: DATA_FORMAT, version: DATA_VERSION, tables: 'x' },
    good({ foods: {} }),
    good({ foods: 'x' }),
    good({ foods: [null] }),
    good({ foods: [42] }),
    good({ foods: [{ name: 'ไม่มี id' }] }),
    good({ foods: [{ id: 123 }] }),
    good({ foods: [{ id: '' }] }),
    good({ sets: [row(), { id: undefined }] }),
  ];
  for (const b of bad) assert.throws(() => validateImport(b), ImportError, JSON.stringify(b)?.slice(0, 60));
});

test('QA นำเข้า: ไฟล์ว่าง/ตารางที่ไม่รู้จัก/ฟิลด์ขาด ผ่านได้และเติมค่ามาตรฐานให้ ไม่ทำให้ตารางอื่นหาย', () => {
  assert.deepEqual(validateImport(good({})), {});
  const out = validateImport(good({ unknown_table: [row()], foods: [{ id: 'f1', name: 'ข้าว' }], profile: [] }));
  assert.deepEqual(Object.keys(out).sort(), ['foods', 'profile']);
  const f = out.foods[0];
  assert.equal(f.deleted, false);
  assert.ok(f.created_at && f.updated_at);
  assert.equal(f.name, 'ข้าว');
});

test('QA นำเข้า: แถวที่ฟิลด์วันที่/เวลาเพี้ยนต้องถูกปฏิเสธหรือข้าม ไม่ปล่อยเข้าฐานข้อมูลจนหน้าวิเคราะห์/ซิงก์ล้ม', () => {
  const cases = [
    good({ body_logs: [row({ date: 20261018, weight_kg: 80 })] }),
    good({ body_logs: [row({ date: 'พรุ่งนี้', weight_kg: 80 })] }),
    good({ foods: [row({ updated_at: 'not-a-time' })] }),
    good({ foods: [row({ id: 'not a uuid' })] }),
  ];
  for (const c of cases) assert.throws(() => validateImport(c), ImportError, JSON.stringify(c.tables).slice(0, 80));
});

// ---------- ความเป็นส่วนตัวของโค้ดที่จะขึ้น GitHub ----------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(root, p).split(sep).join('/');
    if (rel === 'private' || rel === 'node_modules' || rel.startsWith('.git')) continue; // .gitignore กันไว้
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(rel);
  }
  return out;
}

test('QA ความเป็นส่วนตัว: .gitignore กัน private/ และไฟล์สำรอง export · ไฟล์ที่เหลือไม่มีข้อมูลสุขภาพจริงจาก private/', () => {
  const gi = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(gi.includes('private/'));
  assert.ok(gi.some((l) => l.startsWith('fitness-tracker-backup')));
  assert.ok(gi.some((l) => l.startsWith('fitness-') && l.endsWith('.csv')));

  const priv = join(root, 'private', 'initial-import.json');
  if (!existsSync(priv)) return; // บนเครื่องที่ไม่มีไฟล์ส่วนตัว (เช่น GitHub) ข้ามส่วนนี้
  const d = JSON.parse(readFileSync(priv, 'utf8'));
  // ค่าที่เป็นข้อมูลส่วนตัว: น้ำหนักตัวที่ชั่ง, อายุ/ส่วนสูง/น้ำหนักในโปรไฟล์ และข้อความหมายเหตุของ session
  const secrets = new Set();
  for (const b of d.tables.body_logs) if (b.weight_kg) secrets.add(String(b.weight_kg));
  const p = d.tables.profile[0];
  const needles = [...secrets].map((s) => ({ what: `น้ำหนัก ${s}`, re: new RegExp(`(?<![\\d.])${s.replace('.', '\\.')}(?![\\d])`) }));
  needles.push({ what: `ส่วนสูง+อายุ ${p.height_cm}/${p.age}`, re: new RegExp(`height_cm['"]?\\s*[:=]\\s*${p.height_cm}\\b`) });
  const skipSelf = new Set(['tests/qa-data.test.mjs']);
  const hits = [];
  for (const f of walk(root)) {
    if (skipSelf.has(f) || /\.(png|ico)$/.test(f)) continue;
    const text = readFileSync(join(root, f), 'utf8');
    // ตัวเลขน้ำหนักทั่วไปอาจบังเอิญซ้ำ (เช่นในเทสต์สมมติ) จึงตรวจเฉพาะ README/โค้ดแอป/เครื่องมือ ไม่รวม tests/
    for (const n of needles) if (!f.startsWith('tests/') && n.re.test(text)) hits.push(`${f}: ${n.what}`);
  }
  assert.deepEqual(hits, [], 'พบข้อมูลที่ตรงกับ private/ ในไฟล์ที่จะขึ้น GitHub');
});

test('QA ความเป็นส่วนตัว/ความปลอดภัย: ไม่มี secret, ไม่มี eval/document.write, innerHTML ใช้กับข้อความที่ escape แล้วหรือค่าคงที่เท่านั้น', () => {
  const files = walk(root).filter((f) => /\.(js|mjs|html|webmanifest|json|md)$/.test(f));
  const secretRe = [/sb_secret_[A-Za-z0-9_]+/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/];
  for (const f of files) {
    if (f === 'tests/qa-data.test.mjs' || f === 'tests/data.test.mjs') continue;
    const t = readFileSync(join(root, f), 'utf8');
    for (const re of secretRe) assert.ok(!re.test(t), `${f} ตรงกับ ${re}`);
    if (f.startsWith('js/')) {
      assert.ok(!/\beval\s*\(|new Function\s*\(|document\.write\s*\(/.test(t), `${f} ใช้ eval/document.write`);
    }
  }
  // publishable key เท่านั้นที่อยู่ใน config.js
  const cfg = readFileSync(join(root, 'js/config.js'), 'utf8');
  const keys = cfg.match(/sb_[a-z]+_[A-Za-z0-9_]+/g) || [];
  assert.ok(keys.length === 1 && keys[0].startsWith('sb_publishable_'), `config.js มีคีย์: ${keys}`);
  // innerHTML/html: ใช้กับอะไรบ้าง — ต้องไม่ใช่ตัวแปรที่รับข้อความผู้ใช้ตรงๆ
  const uses = [];
  for (const f of files.filter((x) => x.startsWith('js/'))) {
    readFileSync(join(root, f), 'utf8').split('\n').forEach((l, i) => {
      if (/innerHTML|\bhtml\s*:|insertAdjacentHTML|outerHTML/.test(l)) uses.push(`${f}:${i + 1}`);
    });
  }
  const filesWithHtml = [...new Set(uses.map((u) => u.split(':')[0]))].sort();
  assert.deepEqual(filesWithHtml, ['js/charts.js', 'js/ui.js'], 'มีไฟล์ใหม่ใช้ innerHTML ต้องตรวจ XSS: ' + uses.join(', '));
});

/** ตัวอ่าน CSV เล็กๆ (รองรับเครื่องหมายคำพูดและขึ้นบรรทัดใหม่ในเซลล์) สำหรับตรวจผลของ toCSV */
function parseCSV(text) {
  const t = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && t[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
