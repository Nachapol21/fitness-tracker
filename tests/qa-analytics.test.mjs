// QA อิสระ: ตรวจตัวเลขใน js/analytics.js และ js/dates.js ด้วยค่าที่คิดมือเอง (ข้อมูลสมมติทั้งหมด ไม่มีข้อมูลส่วนตัว)
// เทสต์ที่ติด { todo } คือบั๊กที่ยังไม่แก้ (รายงานแยก) — จะไม่ทำให้ node --test ล้ม และจะเปลี่ยนเป็นผ่านเมื่อแก้แล้ว
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  bmrMifflin, tdeeFromBmr, suggestTargets, epley, cleanWeights, movingAverage, weeklyWeightAverages,
  weightTrend, weightAssessment, dailyIntake, estimateTDEE, buildHistories, detectStall,
  overloadSuggestion, setsPerMuscle, categoryRatio, weekSessionCount, weeklyConsistency, weeklySummary,
  KCAL_PER_KG,
} from '../js/analytics.js';
import { addDays, weekStart, weekday, diffDays, dateRange } from '../js/dates.js';

const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} คาด ${b} ±${tol} ได้ ${a}`);
let n = 0;
const T = '2026-01-01T00:00:00.000Z';
const rec = (o) => ({ id: `q${++n}`, created_at: T, updated_at: T, deleted: false, ...o });

// ---------- วันที่ ----------

test('QA วันที่: สัปดาห์จันทร์–อาทิตย์ ครบทั้ง 7 วัน ข้ามปี และวันอธิกวาร', () => {
  // 2026-10-12 เป็นวันจันทร์ (ตรวจกับปฏิทินจริง: 18 ต.ค. 2026 = อาทิตย์)
  const week = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
  assert.deepEqual(week.map(weekday), [1, 2, 3, 4, 5, 6, 0]);
  for (const d of week) assert.equal(weekStart(d), '2026-10-12', d);
  assert.equal(weekStart('2026-10-19'), '2026-10-19'); // จันทร์ถัดไปเริ่มสัปดาห์ใหม่
  assert.equal(weekStart('2026-01-01'), '2025-12-29'); // ข้ามปี (พฤหัส → จันทร์ก่อนหน้า)
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(diffDays('2026-12-31', '2027-01-01'), 1);
  assert.equal(dateRange('2026-03-28', '2026-03-30').join(), '2026-03-28,2026-03-29,2026-03-30'); // ช่วง DST ของยุโรป/สหรัฐ ต้องไม่หายวัน
  assert.equal(dateRange('2026-11-01', '2026-11-02').length, 2);
});

test('QA เขตเวลา: ฟังก์ชันคำนวณวันที่ให้ผลเหมือนกันทุก timezone และ toDateStr ใช้วันท้องถิ่นของเครื่อง (ไทย UTC+7 ไม่เลื่อนวัน)', () => {
  const src = `
    import { toDateStr, weekStart, addDays, diffDays } from ${JSON.stringify(new URL('../js/dates.js', import.meta.url).href)};
    const out = {
      // 17 ต.ค. 20:30 UTC = 18 ต.ค. 03:30 เวลาไทย
      local: toDateStr(new Date('2026-10-17T20:30:00Z')),
      localEarly: toDateStr(new Date('2026-10-18T00:30:00+07:00')), // เที่ยงคืนครึ่งของไทย
      ws: weekStart('2026-10-18'), add: addDays('2026-03-08', 1), diff: diffDays('2026-03-01', '2026-04-01'),
    };
    console.log(JSON.stringify(out));`;
  const run = (tz) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const bkk = run('Asia/Bangkok');
  assert.equal(bkk.local, '2026-10-18', 'เวลาไทยตี 3 ครึ่งต้องนับเป็นวันที่ 18 ไม่ใช่วันที่ 17 (UTC)');
  assert.equal(bkk.localEarly, '2026-10-18');
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
    const o = run(tz);
    assert.equal(o.ws, bkk.ws, tz);
    assert.equal(o.add, bkk.add, tz);
    assert.equal(o.diff, bkk.diff, tz);
  }
  // บันทึกเฉพาะ: ในเครื่องที่ตั้งเขตเวลาอื่น toDateStr จะตามเขตเวลาของเครื่องนั้น (ออกแบบไว้ตามนั้น)
  assert.equal(run('America/Los_Angeles').local, '2026-10-17');
});

// ---------- BMR / TDEE / เป้า ----------

test('QA BMR/TDEE (Mifflin-St Jeor) คิดมือ: ชาย 40 ปี 180 ซม. 90 กก. = 1830', () => {
  // 10×90 + 6.25×180 − 5×40 + 5 = 900 + 1125 − 200 + 5 = 1830
  near(bmrMifflin({ sex: 'male', weight_kg: 90, height_cm: 180, age: 40 }), 1830, 1e-9);
  near(bmrMifflin({ sex: 'female', weight_kg: 90, height_cm: 180, age: 40 }), 1664, 1e-9); // −161
  near(tdeeFromBmr(1830, 1.2), 2196, 1e-9);
  near(tdeeFromBmr(1830, 1.55), 2836.5, 1e-9);
  assert.equal(bmrMifflin({ sex: 'male', weight_kg: 0, height_cm: 180, age: 40 }), null);
  assert.equal(bmrMifflin({ sex: 'male', weight_kg: '90', height_cm: '180', age: '40' }), 1830); // ค่าจาก JSON เป็นสตริงก็ใช้ได้
  assert.equal(tdeeFromBmr(null, 1.5), null);
  assert.equal(tdeeFromBmr(1830, 0), null);
});

test('QA suggestTargets คิดมือ: ลด 0.5 กก./สัปดาห์ = TDEE − 550 ใช้ 7700 kcal/กก.', () => {
  assert.equal(KCAL_PER_KG, 7700);
  const t = suggestTargets({ weight_kg: 90, bmr: 1830, tdee: 2836.5, goal: 'lose', rate_kg_week: 0.5 });
  // 0.5×7700/7 = 550 → 2286.5 → ปัด 50 = 2300 · โปรตีน 153→155, 180 · ไขมัน 72→70 · คาร์บ (2300−167.5×4−70×9)/4 = 250
  assert.deepEqual(t, { kcal: 2300, protein_min: 155, protein_max: 180, fat: 70, carb: 250, clamped: false });
  // คงน้ำหนัก = TDEE (ไม่หัก) · เพิ่ม = บวก
  assert.equal(suggestTargets({ weight_kg: 90, bmr: 1830, tdee: 2836.5, goal: 'maintain', rate_kg_week: 0.5 }).kcal, 2850);
  assert.equal(suggestTargets({ weight_kg: 90, bmr: 1830, tdee: 2836.5, goal: 'gain', rate_kg_week: 0.25 }).kcal, 3100); // +275 → 3111.5 → 3100
  // อัตรา 1.5 → หัก 1650 = 1186 < BMR → ดันกลับมาที่ BMR (ปัด 50 → 1850)
  const c = suggestTargets({ weight_kg: 90, bmr: 1830, tdee: 2836.5, goal: 'lose', rate_kg_week: 1.5 });
  assert.equal(c.clamped, true);
  assert.equal(c.kcal, 1850);
  // อัตราติดลบถูกตีความเป็นค่าสัมบูรณ์ ไม่กลายเป็นการเพิ่มน้ำหนักตอนเลือกลด
  assert.equal(suggestTargets({ weight_kg: 90, bmr: 1830, tdee: 2836.5, goal: 'lose', rate_kg_week: -0.5 }).kcal, 2300);
});

test('QA Epley 1RM: w×(1+r/30)', () => {
  near(epley(100, 5), 116.6667, 1e-3);
  near(epley(60, 10), 80, 1e-9);
  near(epley(50, 8), 63.3333, 1e-3);
  assert.equal(epley('60', '10'), 80);
  assert.equal(epley(null, 5), 0);
  assert.equal(epley(60, -3), 0);
});

// ---------- น้ำหนัก ----------

test('QA น้ำหนักเฉลี่ย 7 วัน: หน้าต่าง 7 วันรวมวันนั้น นับเฉพาะวันที่มีค่าชั่ง', () => {
  const pts = cleanWeights([
    rec({ date: '2026-10-01', weight_kg: 80 }),
    rec({ date: '2026-10-02', weight_kg: 81 }),
    rec({ date: '2026-10-04', weight_kg: 79 }),
    rec({ date: '2026-10-09', weight_kg: 78 }),
    rec({ date: '2026-10-09', weight_kg: 70, deleted: true }), // ลบแล้วไม่นับ
    rec({ date: '2026-10-10', weight_kg: 'abc' }), // ค่าเสียถูกข้าม
    rec({ date: '2026-10-11', weight_kg: -5 }),
  ]);
  assert.equal(pts.length, 4);
  const ma = movingAverage(pts);
  near(ma[0].value, 80, 1e-9); // 1 ต.ค.
  near(ma[1].value, 80.5, 1e-9); // (80+81)/2
  near(ma[2].value, 80, 1e-9); // (80+81+79)/3
  // 9 ต.ค.: ย้อน 7 วัน = 3..9 → มีแค่ 4 ต.ค.(79) กับ 9 ต.ค.(78); 2 ต.ค. อยู่ห่าง 7 วันพอดี → ไม่นับ
  near(ma[3].value, 78.5, 1e-9);
  assert.equal(ma[3].n, 2);
});

test('QA น้ำหนักรายสัปดาห์: อาทิตย์อยู่สัปดาห์เดิม จันทร์เริ่มสัปดาห์ใหม่', () => {
  const pts = [
    { date: '2026-10-12', weight: 80 }, // จันทร์
    { date: '2026-10-18', weight: 82 }, // อาทิตย์ (สัปดาห์เดียวกัน)
    { date: '2026-10-19', weight: 90 }, // จันทร์ถัดไป
  ];
  const w = weeklyWeightAverages(pts);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { weekStart: '2026-10-12', avg: 81, n: 2 });
  assert.deepEqual(w[1], { weekStart: '2026-10-19', avg: 90, n: 1 });
});

test('QA แนวโน้มน้ำหนัก/คำเตือน: ลดเร็วเกิน 1 กก./สัปดาห์, นิ่ง ≥ 2 สัปดาห์, ข้อมูลไม่พอ', () => {
  const asOf = '2026-10-20';
  const series = (f, days = 21, step = 1) => Array.from({ length: Math.ceil(days / step) }, (_, i) => ({ date: addDays(addDays(asOf, -(days - 1)), i * step), weight: f(i * step) }));
  // ลด 0.2 กก./วัน = 1.4 กก./สัปดาห์
  let tr = weightTrend(series((d) => 90 - 0.2 * d), { asOf });
  near(tr.slopePerWeek, -1.4, 1e-6);
  let a = weightAssessment(series((d) => 90 - 0.2 * d), { goal: 'lose', rate_kg_week: 0.5 }, asOf);
  assert.equal(a[0].code, 'too_fast');
  // ลดพอดี 0.5 กก./สัปดาห์
  a = weightAssessment(series((d) => 90 - (0.5 / 7) * d), { goal: 'lose', rate_kg_week: 0.5 }, asOf);
  assert.equal(a[0].code, 'on_track');
  // คงที่ 21 วัน → ไม่ลดเลย
  a = weightAssessment(series(() => 90), { goal: 'lose', rate_kg_week: 0.5 }, asOf);
  assert.equal(a[0].code, 'stalled');
  // นิ่งแค่ 10 วัน → ยังไม่ถึง 2 สัปดาห์ ไม่เตือน
  a = weightAssessment(series(() => 90, 10), { goal: 'lose', rate_kg_week: 0.5 }, asOf);
  assert.equal(a[0].code, 'watch');
  // ชั่งแค่ 2 ครั้ง → ข้อมูลไม่พอ
  a = weightAssessment([{ date: '2026-10-01', weight: 90 }, { date: '2026-10-20', weight: 89 }], { goal: 'lose' }, asOf);
  assert.equal(a[0].code, 'insufficient');
  // ชั่งครบ 3 ครั้งแต่อยู่ในช่วง < 7 วัน → ข้อมูลไม่พอ
  a = weightAssessment([{ date: '2026-10-17', weight: 90 }, { date: '2026-10-18', weight: 89 }, { date: '2026-10-20', weight: 88 }], { goal: 'lose' }, asOf);
  assert.equal(a[0].code, 'insufficient');
});

// ---------- ประมาณ TDEE จริง ----------

function tdeeScenario({ days = 28, intake = 2400, slopePerDay = -0.05, startW = 80, weighEvery = 2, logged = days, kcalOf }) {
  const asOf = '2026-10-28';
  const from = addDays(asOf, -(days - 1));
  const foodLogs = [];
  for (let i = 0; i < logged; i++) foodLogs.push(rec({ date: addDays(from, i), kcal: kcalOf ? kcalOf(i) : intake }));
  const bodyLogs = [];
  for (let i = 0; i < days; i += weighEvery) bodyLogs.push(rec({ date: addDays(from, i), weight_kg: startW + slopePerDay * i }));
  return { asOf, daily: dailyIntake(foodLogs), pts: cleanWeights(bodyLogs) };
}

test('QA ประมาณ TDEE จริง: กิน 2400 น้ำหนักลด 0.05 กก./วัน → TDEE = 2400 + 0.05×7700 = 2785', () => {
  const s = tdeeScenario({});
  const r = estimateTDEE(s.pts, s.daily, { goal: 'lose', rate_kg_week: 0.5 }, { asOf: s.asOf });
  assert.equal(r.ok, true);
  assert.equal(r.tdee, 2785);
  near(r.slopePerWeek, -0.35, 1e-9);
  assert.equal(r.avgIntake, 2400);
  assert.equal(r.suggestedKcal, 2250); // 2785 − 550 = 2235 → ปัด 50
  assert.equal(r.confidence, 'สูง');
});

test('QA ประมาณ TDEE จริง: น้ำหนักเพิ่ม → TDEE ต่ำกว่าที่กิน · น้ำหนักนิ่ง → TDEE = ที่กิน', () => {
  let s = tdeeScenario({ intake: 3000, slopePerDay: 0.1 });
  let r = estimateTDEE(s.pts, s.daily, { goal: 'gain', rate_kg_week: 0.25 }, { asOf: s.asOf });
  assert.equal(r.tdee, 3000 - 770);
  s = tdeeScenario({ intake: 2200, slopePerDay: 0 });
  r = estimateTDEE(s.pts, s.daily, { goal: 'maintain' }, { asOf: s.asOf });
  assert.equal(r.tdee, 2200);
  assert.equal(r.suggestedKcal, 2200);
});

test('QA ประมาณ TDEE จริง: ข้อมูลไม่พอต้องไม่ให้ตัวเลข (จด < 14 วัน / ชั่ง < 4 ครั้ง / ช่วงชั่งสั้น / วันที่กิน < 800 ไม่นับ)', () => {
  let s = tdeeScenario({ logged: 13 });
  let r = estimateTDEE(s.pts, s.daily, {}, { asOf: s.asOf });
  assert.equal(r.ok, false);
  assert.equal(r.loggedDays, 13);
  // จดครบ 28 วัน แต่วันละ 700 kcal ไม่นับว่าจดครบ
  s = tdeeScenario({ intake: 700 });
  r = estimateTDEE(s.pts, s.daily, {}, { asOf: s.asOf });
  assert.equal(r.ok, false);
  assert.equal(r.loggedDays, 0);
  // ชั่งทุก 9 วัน → 4 ครั้ง ห่างกัน 27 วัน = ผ่าน; ชั่งทุก 14 วัน → 2 ครั้ง = ไม่ผ่าน
  s = tdeeScenario({ weighEvery: 14 });
  r = estimateTDEE(s.pts, s.daily, {}, { asOf: s.asOf });
  assert.equal(r.ok, false);
  assert.equal(r.weighIns, 2);
  // ชั่ง 4 ครั้งแต่รวมกันห่างแค่ 9 วัน (< 12) ไม่ผ่าน
  const asOf = '2026-10-28';
  const daily = dailyIntake(Array.from({ length: 28 }, (_, i) => rec({ date: addDays('2026-10-01', i), kcal: 2400 })));
  const pts = [20, 22, 24, 28].map((d, i) => ({ date: `2026-10-${d}`, weight: 80 - i * 0.1 }));
  r = estimateTDEE(pts, daily, {}, { asOf });
  assert.equal(r.ok, false);
  assert.equal(r.weighSpan, 8);
});

test('QA ประมาณ TDEE จริง: วันที่จดไม่ครบ (< 800) ถูกตัดออกจากค่าเฉลี่ย ไม่ถูกนับเป็น 0', () => {
  // 28 วัน: วันคู่กิน 2500 วันคี่จด 300 (จดไม่ครบ) → ใช้เฉพาะวันคู่ ค่าเฉลี่ยต้อง 2500 ไม่ใช่ 1400
  const s = tdeeScenario({ slopePerDay: 0, kcalOf: (i) => (i % 2 === 0 ? 2500 : 300) });
  const r = estimateTDEE(s.pts, s.daily, {}, { asOf: s.asOf });
  assert.equal(r.ok, true);
  assert.equal(r.avgIntake, 2500);
});

// ---------- ประวัติท่า / ไม่ขึ้น / เพิ่มน้ำหนัก ----------

const EX = (o) => rec({ name: 'ท่า', muscle: 'อก', category: 'ดัน', equipment: 'บาร์', rep_min: 6, rep_max: 8, timed: false, per_side: false, ...o });
function world(exs, plan) {
  // plan: [[exIndex, date, [[w,r,{warm}]...]]...] → { exercises, sessions, sets }
  const exercises = exs.map((e) => EX(e));
  const sessions = [];
  const sets = [];
  for (const [ei, date, ss] of plan) {
    const s = rec({ date, day_name: 'Upper A', exercise_ids: [] });
    sessions.push(s);
    ss.forEach(([w, r, o = {}], order) => sets.push(rec({ session_id: s.id, exercise_id: exercises[ei].id, order, weight_kg: w, reps: r, rir: null, is_warmup: false, ...o })));
  }
  return { exercises, sessions, sets };
}

test('QA ประวัติท่า: เซ็ตดีที่สุดตาม 1RM, ปริมาณ, วอร์มอัพ/ลบแล้ว/เซ็ตไม่มีครั้งไม่นับ', () => {
  const w = world([{ name: 'Bench' }], [[0, '2026-09-01', [[40, 10], [60, 5], [30, 20, { is_warmup: true }], [50, 8, { deleted: true }], [70, 0]]]]);
  const h = buildHistories(w.exercises, w.sessions, w.sets).get(w.exercises[0].id);
  assert.equal(h.length, 1);
  // 40×10 → 53.33 ; 60×5 → 70 → เซ็ตดีที่สุดคือ 60×5
  assert.deepEqual([h[0].best.weight, h[0].best.reps], [60, 5]);
  near(h[0].e1rm, 70, 1e-9);
  assert.equal(h[0].volume, 40 * 10 + 60 * 5);
  assert.equal(h[0].sets.length, 2);
  assert.equal(h[0].topWeight, 60);
});

test('QA ท่าตัวเลขไม่ขึ้น: นิยามตรงกับ README (ต้องมีประวัติ ≥ 4 ครั้ง · ไม่มีครั้งไหนใน 3 ครั้งล่าสุดทำลายสถิติเดิม · ไม่ไต่ขึ้น)', () => {
  const hist = (scores) => scores.map((s, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, score: s }));
  assert.equal(detectStall(hist([50, 50, 50])).stalled, false, 'มีแค่ 3 ครั้ง ยังไม่พอ');
  assert.equal(detectStall(hist([50, 50, 50, 50])).stalled, true);
  assert.equal(detectStall(hist([60, 55, 54, 53])).stalled, true, 'ตกลงเรื่อยๆ ก็ไม่ขึ้น');
  assert.equal(detectStall(hist([50, 55, 50, 50])).stalled, false, 'ครั้งใดครั้งหนึ่งใน 3 ล่าสุดทำสถิติใหม่ → ไม่ใช่ stall');
  assert.equal(detectStall(hist([60, 55, 56, 57])).stalled, false, 'ไต่ขึ้นเรื่อยๆ แม้ยังไม่ถึงสถิติเดิม → ไม่เตือน');
  assert.equal(detectStall(hist([50, 52, 54, 56, 56, 55, 54])).stalled, true);
  assert.equal(detectStall(hist([50, 50, 50, 51])).stalled, false, 'ครั้งล่าสุดทำสถิติใหม่');
});

test('QA แนะนำเพิ่มน้ำหนัก: ต้องครบเลขบนทุกเซ็ตทำงาน · ท่าขา +2.5–5 · ท่าบน +1–2.5 · เซ็ตวอร์มอัพไม่ทำให้ตก', () => {
  const upper = EX({ rep_min: 6, rep_max: 8 });
  const mk = (sets) => ({ sets: sets.map(([weight, reps]) => ({ weight, reps })), topWeight: Math.max(...sets.map((s) => s[0])), date: '2026-09-01' });
  let o = overloadSuggestion(upper, [mk([[50, 8], [50, 8], [50, 8]])]);
  assert.deepEqual([o.low, o.high], [51, 52.5]);
  assert.equal(overloadSuggestion(upper, [mk([[50, 8], [50, 8], [50, 7]])]), null);
  assert.equal(overloadSuggestion(upper, [mk([[50, 9], [50, 8]])]).low, 51, 'เกินเลขบนก็ถือว่าครบ');
  const leg = EX({ category: 'ขา', rep_min: 8, rep_max: 10, name: 'Squat' });
  o = overloadSuggestion(leg, [mk([[100, 10], [100, 10]])]);
  assert.deepEqual([o.low, o.high], [102.5, 105]);
  // วอร์มอัพ (เบา ครั้งน้อย) ไม่ถูกนับเข้าประวัติ จึงไม่ทำให้เงื่อนไข "ทุกเซ็ต" ตก
  const w = world([{ name: 'Press', rep_max: 8 }], [[0, '2026-09-01', [[20, 3, { is_warmup: true }], [50, 8], [50, 8]]]]);
  const h = buildHistories(w.exercises, w.sessions, w.sets).get(w.exercises[0].id);
  assert.ok(overloadSuggestion(w.exercises[0], h));
  // ท่าวัดเวลาและท่าไม่มีน้ำหนักไม่แนะนำ
  assert.equal(overloadSuggestion(EX({ timed: true, rep_max: 45 }), [mk([[0, 45]])]), null);
  assert.equal(overloadSuggestion(EX({ rep_max: 10 }), [mk([[0, 12], [0, 12]])]), null);
});

test('QA ท่าน้ำหนักตัว (น้ำหนัก 0): ใช้จำนวนครั้งเป็นคะแนน ไม่เป็น NaN', () => {
  const w = world([{ name: 'Pull-up', equipment: 'น้ำหนักตัว', rep_max: 10 }], [
    [0, '2026-09-01', [[null, 6], [null, 5]]],
    [0, '2026-09-08', [[null, 8]]],
  ]);
  const h = buildHistories(w.exercises, w.sessions, w.sets).get(w.exercises[0].id);
  assert.equal(h[0].score, 6);
  assert.equal(h[1].score, 8);
  assert.ok(Number.isFinite(h[0].volume));
});

// ---------- เซ็ตต่อกลุ่มกล้าม / สัดส่วน / สัปดาห์ ----------

test('QA เซ็ตต่อกลุ่มกล้ามและสัปดาห์: อาทิตย์เป็นสัปดาห์เก่า จันทร์เป็นสัปดาห์ใหม่ วอร์มอัพและเซ็ตที่ลบไม่นับ', () => {
  const w = world([{ name: 'Bench', muscle: 'อก', category: 'ดัน' }, { name: 'Row', muscle: 'หลัง', category: 'ดึง' }, { name: 'Squat', muscle: 'ขา', category: 'ขา' }], [
    [0, '2026-10-11', [[50, 8]]], // อาทิตย์ก่อนหน้า (สัปดาห์ 5 ต.ค.)
    [0, '2026-10-12', [[50, 8], [50, 8], [20, 10, { is_warmup: true }]]], // จันทร์
    [1, '2026-10-18', [[40, 10], [40, 10], [40, 10, { deleted: true }]]], // อาทิตย์
    [2, '2026-10-19', [[100, 5]]], // จันทร์ถัดไป
  ]);
  const ws = '2026-10-12';
  assert.deepEqual(setsPerMuscle(w.sessions, w.sets, w.exercises, ws), { อก: 2, หลัง: 2 });
  assert.deepEqual(setsPerMuscle(w.sessions, w.sets, w.exercises, '2026-10-19'), { ขา: 1 });
  assert.deepEqual(setsPerMuscle(w.sessions, w.sets, w.exercises, '2026-10-05'), { อก: 1 });
  // สัดส่วน: ช่วงรวมปลายทั้งสองวัน
  const r = categoryRatio(w.sessions, w.sets, w.exercises, '2026-10-12', '2026-10-18');
  assert.deepEqual([r.ดัน, r.ดึง, r.ขา, r.total], [2, 2, 0, 4]);
  const r2 = categoryRatio(w.sessions, w.sets, w.exercises, '2026-10-12', '2026-10-19');
  assert.deepEqual([r2.ดัน, r2.ดึง, r2.ขา, r2.total], [2, 2, 1, 5]);
  assert.equal(weekSessionCount(w.sessions, w.sets, [], ws), 2);
  const cons = weeklyConsistency(w.sessions, w.sets, [], '2026-10-19', 3);
  assert.deepEqual(cons.map((c) => [c.weekStart, c.count]), [['2026-10-05', 1], ['2026-10-12', 2], ['2026-10-19', 1]]);
});

test('QA สรุปรายสัปดาห์กลางสัปดาห์: นับวันที่กินเฉพาะถึงวันนี้ น้ำหนักเฉลี่ยเฉพาะสัปดาห์นั้น', () => {
  const asOf = '2026-10-14'; // พุธ
  const ws = weekStart(asOf);
  const bodyLogs = [rec({ date: '2026-10-12', weight_kg: 80 }), rec({ date: '2026-10-14', weight_kg: 81 }), rec({ date: '2026-10-08', weight_kg: 70 })];
  const foodLogs = ['2026-10-12', '2026-10-13', '2026-10-14'].map((d) => rec({ date: d, kcal: 2000, protein: 150 }));
  const s = weeklySummary({ ws, asOf, bodyLogs, foodLogs, sessions: [], sets: [], cardio: [], exercises: [], profile: { kcal: 2000, kcal_tolerance: 100, protein_min: 140, sessions_per_week: 4, goal: 'lose' } });
  assert.equal(s.weekDone, false);
  assert.equal(s.avgWeight, 80.5);
  assert.equal(s.prevAvgWeight, 70);
  assert.equal(s.intake.totalDays, 3);
  assert.equal(s.intake.loggedDays, 3);
  assert.equal(s.intake.kcalOkDays, 3);
  assert.equal(s.intake.proteinOkDays, 3);
  // สัปดาห์ที่ผ่านไปแล้วนับครบ 7 วัน
  const past = weeklySummary({ ws: '2026-10-05', asOf, bodyLogs, foodLogs, sessions: [], sets: [], cardio: [], exercises: [], profile: {} });
  assert.equal(past.weekDone, true);
  assert.equal(past.intake.totalDays, 7);
});

// ---------- ความทนทานต่อข้อมูลเพี้ยน ----------

test('QA ข้อมูลเพี้ยนจากไฟล์นำเข้า: วิเคราะห์ต้องไม่ล้ม (อย่างน้อยข้ามแถวเสีย)', () => {
  const bad = [rec({ date: 20261018, weight_kg: 80 }), rec({ date: '2026-10-19', weight_kg: 81 }), rec({ date: '2026-10-20', weight_kg: 82 })];
  assert.doesNotThrow(() => movingAverage(cleanWeights(bad)));
  assert.doesNotThrow(() => weeklyWeightAverages(cleanWeights(bad)));
});
