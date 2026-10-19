// แปลงข้อมูลเดิม (log.md / progress.md / plan.md) เป็นไฟล์ JSON รูปแบบเดียวกับที่แอป export
// แล้วผู้ใช้กด "นำเข้า" ในแอปเอง  ผลลัพธ์เป็นข้อมูลส่วนตัว → เขียนลง private/ ซึ่ง .gitignore กันไว้
//
// รัน:  node tools/build-initial-import.mjs [โฟลเดอร์ที่มี log.md] [ไฟล์ผลลัพธ์]
//   ค่าเริ่มต้น: ../../../../Personal/fitness  →  private/initial-import.json
// สคริปต์นี้ "อ่านอย่างเดียว" จากโฟลเดอร์ต้นทาง และ id ของทุกเรคคอร์ดคำนวณจากเนื้อหา
// จึงรันซ้ำได้ผลเดิม และนำเข้าซ้ำแล้วไม่เกิดรายการซ้ำ (timestamp ตรึงเป็นวันที่ฝึก จึงไม่ทับข้อมูลที่แก้ในแอปภายหลัง)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { DATA_FORMAT, DATA_VERSION, DEFAULT_PROFILE, PROFILE_ID, TABLES } from '../js/constants.js';
import { addDays, diffDays } from '../js/dates.js';
import { seedExercises, seedId } from '../js/seed.js';
import { validateImport } from '../js/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(process.argv[2] || join(here, '..', '..', '..', '..', 'Personal', 'fitness'));
const outFile = resolve(process.argv[3] || join(here, '..', 'private', 'initial-import.json'));
const read = (f) => readFileSync(join(srcDir, f), 'utf8').replace(/\r\n/g, '\n');

const exercises = seedExercises();
const exByName = new Map(exercises.map((e) => [e.name.toLowerCase(), e]));
const ALIAS = {
  'triceps cable': 'Triceps pushdown',
  'bench press': 'Barbell bench press',
  'dumbbell shoulder press': 'DB shoulder press',
  'seated cable row': 'Pulley row',
  'db preacher curl (ทีละข้าง)': 'DB preacher curl',
};
function findExercise(raw) {
  const name = raw.replace(/\s+/g, ' ').trim();
  const key = (ALIAS[name.toLowerCase()] || name).toLowerCase();
  const ex = exByName.get(key);
  if (!ex) throw new Error(`ไม่รู้จักท่า "${raw}" — เพิ่มใน js/seed.js หรือ ALIAS ก่อน`);
  return ex;
}

const stamp = (iso) => ({ created_at: iso, updated_at: iso, deleted: false });

// ---------- log.md ----------
function parseLog(text) {
  const sessions = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^###\s+(.+?)\s+·\s+(.+)$/);
    if (h) {
      cur = { dateText: h[1].trim(), title: h[2].trim(), items: [], cardio: [] };
      sessions.push(cur);
      continue;
    }
    if (!cur || !line.startsWith('- ')) continue;
    const item = line.slice(2).trim();
    if (/^วิ่งลู่/.test(item)) {
      cur.cardio.push({ type: 'วิ่ง', note: `${item} (log เดิมไม่ได้ระบุเวลา/ความเร็ว)` });
      continue;
    }
    const m = item.match(/^(.+?):\s*(.+)$/);
    if (!m) throw new Error(`อ่านบรรทัดไม่ได้: ${line}`);
    const ex = findExercise(m[1]);
    const sets = m[2].split(',').map((s) => {
      const x = s.trim().match(/^([\d.]+)\s*[×x]\s*(\d+)$/);
      if (!x) throw new Error(`อ่านเซ็ตไม่ได้: "${s}" ใน ${line}`);
      return { weight: Number(x[1]), reps: Number(x[2]) };
    });
    cur.items.push({ ex, sets });
  }
  // วันที่ที่ไม่ระบุ: ประมาณเป็นกึ่งกลางระหว่างครั้งที่มีวันที่ก่อนหน้าและถัดไป
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  sessions.forEach((s, i) => {
    s.estimated = !isDate(s.dateText);
    if (!s.estimated) {
      s.date = s.dateText;
      return;
    }
    const prev = [...sessions.slice(0, i)].reverse().find((x) => isDate(x.dateText));
    const next = sessions.slice(i + 1).find((x) => isDate(x.dateText));
    if (!prev && !next) throw new Error('ประมาณวันที่ไม่ได้ (ไม่มีครั้งที่ระบุวันที่เลย)');
    s.date = prev && next ? addDays(prev.dateText, Math.floor(diffDays(prev.dateText, next.dateText) / 2)) : (prev || next).dateText;
  });
  return sessions;
}

// ---------- progress.md ----------
function parseBody(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([\d.]+)\s*\|\s*(.*?)\s*\|/);
    if (m) rows.push({ date: m[1], weight_kg: Number(m[2]), note: m[3] });
  }
  return rows;
}

// ---------- plan.md ----------
const need = (text, re, what) => {
  const m = text.match(re);
  if (!m) throw new Error(`ไม่พบ ${what} ใน plan.md`);
  return m;
};
const toNum = (s) => Number(String(s).replace(/,/g, ''));

function parsePlan(text) {
  const person = need(text, /(ชาย|หญิง)\s+อายุ\s+(\d+)\s*·\s*สูง\s+(\d+)\s*ซม\.\s*·\s*หนัก\s+([\d.]+)/, 'เพศ/อายุ/ส่วนสูง/น้ำหนัก');
  const act = need(text, /ขยับบ้าง\s*×\s*([\d.]+)/, 'ระดับกิจกรรม');
  const kcal = need(text, /แคลอรี่:\s*~?([\d,]+)\s*kcal\*{0,2}\s*\(ช่วงที่ยอมรับได้\s*([\d,]+)[–-]([\d,]+)\)/, 'เป้าแคลอรี่');
  const protein = need(text, /โปรตีน:\s*(\d+)[–-](\d+)\s*ก\./, 'เป้าโปรตีน');
  const fat = need(text, /ไขมัน:\s*~?(\d+)\s*ก\./, 'เป้าไขมัน');
  const carb = need(text, /คาร์บ:\s*~?(\d+)\s*ก\./, 'เป้าคาร์บ');
  const rate = need(text, /ประมาณ\s*([\d.]+)[–-]([\d.]+)\s*กก\.\/สัปดาห์/, 'อัตราน้ำหนักลด');
  const per = need(text, /เพิ่มเป็น\s*(\d+)\s*ครั้ง\/สัปดาห์/, 'เป้าฝึกต่อสัปดาห์');
  const steps = need(text, /([\d,]+)[–-]([\d,]+)\s*ก้าว\/วัน/, 'เป้าก้าวเดิน');
  const profile = {
    ...DEFAULT_PROFILE,
    id: PROFILE_ID,
    sex: person[1] === 'หญิง' ? 'female' : 'male',
    age: Number(person[2]),
    height_cm: Number(person[3]),
    calc_weight_kg: Number(person[4]),
    activity: Number(act[1]),
    goal: 'lose',
    rate_kg_week: Math.round(((Number(rate[1]) + Number(rate[2])) / 2) * 100) / 100,
    kcal: toNum(kcal[1]),
    kcal_tolerance: (toNum(kcal[3]) - toNum(kcal[2])) / 2,
    protein_min: Number(protein[1]),
    protein_max: Number(protein[2]),
    fat: Number(fat[1]),
    carb: Number(carb[1]),
    sessions_per_week: Number(per[1]),
    step_goal: toNum(steps[1]),
    ...stamp('2026-10-18T00:00:00.000Z'),
  };

  // เทมเพลต Upper A / Lower A / Upper B / Lower B
  const templates = [];
  const dayNames = ['Upper A', 'Lower A', 'Upper B', 'Lower B'];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) {
      cur = dayNames.includes(h[1]) ? { name: h[1], items: [] } : null;
      if (cur) templates.push(cur);
      continue;
    }
    if (!cur || !line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2 || cells[0] === 'ท่า' || /^-+$/.test(cells[0])) continue;
    const sr = cells[1].match(/^(\d+)\s*×\s*(\d+)(?:[–-](\d+))?\s*(วิ|\/ข้าง)?/);
    if (!sr) throw new Error(`อ่านเซ็ต×ครั้งไม่ได้: ${line}`);
    for (const part of cells[0].split(/\s\+\s/)) {
      const first = part.split(/\s\/\s/)[0].replace(/\(.*?\)/g, '').trim();
      const ex = findExercise(first);
      cur.items.push({
        exercise_id: ex.id,
        name: ex.name,
        sets: Number(sr[1]),
        rep_min: Number(sr[2]),
        rep_max: Number(sr[3] || sr[2]),
        per_side: sr[4] === '/ข้าง',
        timed: sr[4] === 'วิ',
      });
    }
  }
  if (templates.length !== 4) throw new Error(`คาดว่ามีเทมเพลต 4 วัน แต่พบ ${templates.length}`);
  return { profile, templates };
}

// ---------- ประกอบผลลัพธ์ ----------
const logSessions = parseLog(read('log.md'));
const bodyRows = parseBody(read('progress.md'));
const { profile, templates } = parsePlan(read('plan.md'));

const usedEx = new Set();
const out = Object.fromEntries(TABLES.map((t) => [t, []]));
out.profile.push(profile);

for (const b of bodyRows) {
  out.body_logs.push({ id: seedId('body', b.date), date: b.date, weight_kg: b.weight_kg, waist_cm: null, steps: null, note: b.note, ...stamp(`${b.date}T00:00:00.000Z`) });
}

const perDate = {};
logSessions.forEach((s) => {
  perDate[s.dateText] = (perDate[s.dateText] || 0) + 1;
  const key = `log:${s.dateText}:${perDate[s.dateText]}`;
  const sid = seedId('session', key);
  const t = stamp(`${s.date}T12:00:00.000Z`);
  let order = 0;
  for (const it of s.items) {
    usedEx.add(it.ex.id);
    it.sets.forEach((st, i) => {
      out.sets.push({ id: seedId('set', `${key}/${it.ex.name}/${i}`), session_id: sid, exercise_id: it.ex.id, order: order++, weight_kg: st.weight, reps: st.reps, rir: null, is_warmup: false, note: '', ...t });
    });
  }
  s.cardio.forEach((c, i) => {
    out.cardio.push({ id: seedId('cardio', `${key}/${i}`), session_id: sid, date: s.date, type: c.type, minutes: null, incline_pct: null, speed_kmh: null, distance_km: null, kcal_est: null, note: c.note, ...t });
  });
  out.sessions.push({
    id: sid,
    date: s.date,
    day_name: 'อื่นๆ',
    start_time: null,
    end_time: null,
    rpe: null,
    note: s.estimated ? `${s.title} · log เดิมไม่ระบุวันที่ (${s.dateText}) ใส่วันที่โดยประมาณ` : s.title,
    exercise_ids: s.items.map((it) => it.ex.id),
    date_estimated: s.estimated,
    ...t,
  });
});

for (const tpl of templates) {
  tpl.items.forEach((i) => usedEx.add(i.exercise_id));
  out.templates.push({ id: seedId('template', tpl.name), name: tpl.name, items: tpl.items, note: 'นำเข้าจาก plan.md (ยังไม่มีหน้าจอใช้เทมเพลตในรอบแรก)', ...stamp('2026-10-18T00:00:00.000Z') });
}
out.exercises = exercises.filter((e) => usedEx.has(e.id));

const file = { format: DATA_FORMAT, version: DATA_VERSION, exported_at: new Date().toISOString(), tables: out };
validateImport(file); // ตรวจรูปแบบด้วยตัวตรวจของแอปเอง

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(file, null, 2) + '\n', 'utf8');

console.log(`เขียน ${outFile}`);
for (const t of TABLES) console.log(`  ${t.padEnd(10)} ${out[t].length}`);
const est = logSessions.filter((s) => s.estimated);
if (est.length) console.log(`หมายเหตุ: ${est.length} ครั้งไม่ระบุวันที่ใน log.md ใช้วันที่ประมาณ: ${est.map((s) => s.date).join(', ')}`);
