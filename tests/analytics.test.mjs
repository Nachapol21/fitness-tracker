// ทดสอบสูตรใน js/analytics.js (ข้อมูลสมมติทั้งหมด ไม่ใช้ข้อมูลส่วนตัว)  รัน: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bmrMifflin, tdeeFromBmr, suggestTargets, epley, cleanWeights, movingAverage, weeklyWeightAverages,
  weightTrend, weightAssessment, dailyIntake, intakeSummary, estimateTDEE, buildHistories, detectStall,
  overloadSuggestion, previousEntry, setsPerMuscle, categoryRatio, weeklyConsistency, weekPRs, weeklySummary,
  estimateCardioKcal, linearRegression,
} from '../js/analytics.js';
import { addDays, weekStart, diffDays, dateRange, fmtShort } from '../js/dates.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} คาด ${b} ±${tol} ได้ ${a}`);
let n = 0;
const id = () => `id${++n}`;
const T = '2026-01-01T00:00:00Z';
const rec = (o) => ({ id: id(), created_at: T, updated_at: T, deleted: false, ...o });

test('วันที่: weekStart เป็นวันจันทร์, diffDays, dateRange', () => {
  assert.equal(weekStart('2026-10-18'), '2026-10-12'); // อาทิตย์ → จันทร์ก่อนหน้า
  assert.equal(weekStart('2026-10-12'), '2026-10-12');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(diffDays('2026-01-05', '2026-03-02'), 56);
  assert.equal(dateRange('2026-02-27', '2026-03-02').length, 4);
  assert.equal(fmtShort('2026-03-14'), '14 มี.ค.');
});

test('BMR/TDEE Mifflin-St Jeor', () => {
  const bmr = bmrMifflin({ sex: 'male', weight_kg: 80, height_cm: 175, age: 25 });
  near(bmr, 1773.75, 0.01, 'BMR ชาย'); // 10×80 + 6.25×175 − 5×25 + 5
  near(tdeeFromBmr(bmr, 1.375), 2439.0, 0.1, 'TDEE');
  near(bmrMifflin({ sex: 'female', weight_kg: 60, height_cm: 165, age: 30 }), 1320.25, 0.01, 'BMR หญิง');
  assert.equal(bmrMifflin({ sex: 'male', weight_kg: null, height_cm: 170, age: 20 }), null);
});

test('แนะนำเป้า: ลดน้ำหนัก, ไม่ต่ำกว่า BMR', () => {
  const bmr = bmrMifflin({ sex: 'male', weight_kg: 80, height_cm: 175, age: 25 });
  const tdee = tdeeFromBmr(bmr, 1.375);
  const t = suggestTargets({ weight_kg: 80, bmr, tdee, goal: 'lose', rate_kg_week: 0.5 });
  assert.equal(t.kcal, 1900); // 2439 − 550 = 1889 → ปัดเป็น 50
  assert.equal(t.protein_min, 135); // 1.7 ก./กก.
  assert.equal(t.protein_max, 160); // 2.0 ก./กก.
  assert.equal(t.fat, 65); // 0.8 ก./กก.
  assert.ok(t.carb > 150 && t.carb < 260);
  const harsh = suggestTargets({ weight_kg: 80, bmr, tdee, goal: 'lose', rate_kg_week: 1.5 });
  assert.equal(harsh.clamped, true);
  assert.equal(harsh.kcal, 1750); // ไม่ต่ำกว่า BMR (ปัดเป็น 50)
  const gain = suggestTargets({ weight_kg: 70, bmr: 1700, tdee: 2400, goal: 'gain', rate_kg_week: 0.25 });
  assert.ok(gain.kcal > 2400);
});

test('Epley 1RM', () => {
  near(epley(50, 8), 63.333, 0.001);
  assert.equal(epley(0, 8), 0);
  assert.equal(epley(50, 0), 0);
});

test('linearRegression', () => {
  const r = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
  near(r.slope, 2, 1e-9);
  near(r.r2, 1, 1e-9);
  assert.equal(linearRegression([1], [1]), null);
});

function weightLogs(start, perWeek, days, step = 2, from = '2026-09-01') {
  const out = [];
  for (let d = 0; d < days; d += step) out.push(rec({ date: addDays(from, d), weight_kg: Math.round((start + (perWeek * d) / 7) * 100) / 100 }));
  return out;
}

test('น้ำหนัก: cleanWeights กรองค่าผิด/ลบ/ซ้ำวัน และ movingAverage 7 วัน', () => {
  const logs = [
    rec({ date: '2026-09-02', weight_kg: 80 }),
    rec({ date: '2026-09-01', weight_kg: 81 }),
    rec({ date: '2026-09-01', weight_kg: 81.4, updated_at: '2027-01-01T00:00:00Z' }),
    rec({ date: '2026-09-03', weight_kg: null }),
    rec({ date: '2026-09-04', weight_kg: 70, deleted: true }),
  ];
  const w = cleanWeights(logs);
  assert.deepEqual(w, [{ date: '2026-09-01', weight: 81.4 }, { date: '2026-09-02', weight: 80 }]);
  const ma = movingAverage([...w, { date: '2026-09-20', weight: 79 }]);
  near(ma[1].value, 80.7, 1e-9);
  assert.equal(ma[2].n, 1); // วันที่ 20 ไม่รวมค่าเก่ากว่า 7 วัน
  assert.equal(weeklyWeightAverages(w).length, 1);
});

test('น้ำหนัก: แนวโน้มและคำเตือน', () => {
  const asOf = '2026-09-21';
  const prof = { goal: 'lose', rate_kg_week: 0.5 };
  const mk = (perWeek) => cleanWeights(weightLogs(82, perWeek, 21));
  const tr = weightTrend(mk(-0.5), { asOf });
  near(tr.slopePerWeek, -0.5, 0.01);
  assert.equal(weightAssessment(mk(-0.5), prof, asOf)[0].code, 'on_track');
  assert.equal(weightAssessment(mk(0), prof, asOf)[0].code, 'stalled');
  assert.equal(weightAssessment(mk(0.3), prof, asOf)[0].code, 'stalled');
  assert.equal(weightAssessment(mk(-1.5), prof, asOf)[0].code, 'too_fast');
  assert.equal(weightAssessment(cleanWeights(weightLogs(82, -0.5, 5, 2, '2026-09-18')), prof, asOf)[0].code, 'insufficient');
  assert.equal(weightAssessment([], prof, asOf)[0].code, 'insufficient');
});

function foodLogsFor(dates, kcal, protein = 120) {
  return dates.map((date) => rec({ date, meal: 'กลางวัน', name: 'x', kcal, protein, carb: 0, fat: 0 }));
}

test('การกิน: รวมรายวัน เทียบเป้า', () => {
  const logs = [...foodLogsFor(['2026-10-01'], 1000, 60), ...foodLogsFor(['2026-10-01'], 950, 70), ...foodLogsFor(['2026-10-02'], 2500, 100), ...foodLogsFor(['2026-10-04'], 1500, 150)];
  const d = dailyIntake(logs);
  assert.equal(d['2026-10-01'].kcal, 1950);
  assert.equal(d['2026-10-01'].entries, 2);
  const prof = { kcal: 2000, kcal_tolerance: 100, protein_min: 140, protein_max: 160 };
  const s = intakeSummary(d, prof, dateRange('2026-10-01', '2026-10-04'));
  assert.equal(s.loggedDays, 3);
  assert.equal(s.kcalOkDays, 1); // 1950 อยู่ในช่วง 1900–2100
  assert.equal(s.proteinOkDays, 1);
  near(s.avgKcal, (1950 + 2500 + 1500) / 3, 1e-9);
});

test('ประมาณ TDEE จริง: ข้อมูลไม่พอ → บอกว่าไม่พอ, ข้อมูลพอ → ได้ค่า', () => {
  const asOf = '2026-09-28';
  const from = '2026-09-01';
  const prof = { goal: 'lose', rate_kg_week: 0.5 };
  // ข้อมูลน้อยกว่า 14 วัน
  const short = estimateTDEE(cleanWeights(weightLogs(82, -0.5, 10)), dailyIntake(foodLogsFor(dateRange('2026-09-18', asOf), 2000)), prof, { asOf });
  assert.equal(short.ok, false);
  assert.equal(short.loggedDays, 11);
  // ครบ 28 วัน: กิน 2000 น้ำหนักลด 0.5 กก./สัปดาห์ → TDEE ≈ 2000 + 0.5×7700/7 = 2550
  const full = estimateTDEE(cleanWeights(weightLogs(82, -0.5, 28, 2, from)), dailyIntake(foodLogsFor(dateRange(from, asOf), 2000)), prof, { asOf });
  assert.equal(full.ok, true);
  near(full.tdee, 2550, 15, 'TDEE');
  assert.equal(full.suggestedKcal, 2000);
  // จดอาหารครบ แต่ชั่งน้ำหนักน้อย
  const fewWeigh = estimateTDEE(cleanWeights(weightLogs(82, -0.5, 28, 14, from)), dailyIntake(foodLogsFor(dateRange(from, asOf), 2000)), prof, { asOf });
  assert.equal(fewWeigh.ok, false);
  // วันที่จดไม่ถึง 800 kcal ไม่นับ (จดไม่ครบ)
  const partial = estimateTDEE(cleanWeights(weightLogs(82, -0.5, 28, 2, from)), dailyIntake(foodLogsFor(dateRange(from, asOf), 500)), prof, { asOf });
  assert.equal(partial.ok, false);
});

// ----- การฝึก -----
const bench = rec({ id: 'bench', name: 'Bench', muscle: 'อก', category: 'ดัน', rep_min: 6, rep_max: 8 });
const squat = rec({ id: 'squat', name: 'Squat', muscle: 'ขา', category: 'ขา', rep_min: 6, rep_max: 8 });
const row = rec({ id: 'row', name: 'Row', muscle: 'หลัง', category: 'ดึง', rep_min: 8, rep_max: 10 });
const plank = rec({ id: 'plank', name: 'Plank', muscle: 'ท้อง', category: 'core', timed: true });
const exs = [bench, squat, row, plank];

function session(date, items) {
  const s = rec({ id: `s-${date}`, date, day_name: 'Upper A' });
  const sets = [];
  let o = 0;
  for (const [ex, list] of items) for (const [w, r, extra] of list) sets.push(rec({ session_id: s.id, exercise_id: ex.id, order: o++, weight_kg: w, reps: r, is_warmup: false, ...(extra || {}) }));
  return { s, sets };
}
function build(defs) {
  const ss = defs.map((d) => session(...d));
  return { sessions: ss.map((x) => x.s), sets: ss.flatMap((x) => x.sets) };
}

test('ประวัติท่า: เซ็ตที่ดีที่สุด, 1RM, ปริมาณ และไม่นับวอร์มอัพ', () => {
  const { sessions, sets } = build([['2026-10-05', [[bench, [[40, 12, { is_warmup: true }], [50, 8], [50, 6], [45, 10]]]]]]);
  const e = buildHistories(exs, sessions, sets).get('bench')[0];
  assert.equal(e.sets.length, 3);
  assert.deepEqual({ w: e.best.weight, r: e.best.reps }, { w: 50, r: 8 }); // 63.3 > 45×10 = 60
  near(e.e1rm, 63.333, 0.001);
  assert.equal(e.volume, 50 * 8 + 50 * 6 + 45 * 10);
  assert.equal(e.topWeight, 50);
});

test('ท่าที่วัดเป็นเวลา (Plank) ไม่คำนวณ 1RM', () => {
  const { sessions, sets } = build([['2026-10-05', [[plank, [[0, 40], [0, 35]]]]]]);
  const e = buildHistories(exs, sessions, sets).get('plank')[0];
  assert.equal(e.e1rm, 0);
  assert.equal(e.best.reps, 40);
  assert.equal(e.volume, 75);
  assert.equal(e.score, 40);
});

test('แนะนำเพิ่มน้ำหนัก: ครบเลขบนทุกเซ็ต → ท่าบน +1–2.5, ท่าขา +2.5–5', () => {
  const { sessions, sets } = build([
    ['2026-10-05', [[bench, [[50, 8], [50, 8]]], [squat, [[60, 8], [60, 8]]], [row, [[30, 10], [30, 9]]]]],
  ]);
  const h = buildHistories(exs, sessions, sets);
  const b = overloadSuggestion(bench, h.get('bench'));
  assert.deepEqual({ low: b.low, high: b.high }, { low: 51, high: 52.5 });
  const s = overloadSuggestion(squat, h.get('squat'));
  assert.deepEqual({ low: s.low, high: s.high }, { low: 62.5, high: 65 });
  assert.equal(overloadSuggestion(row, h.get('row')), null); // เซ็ตที่สองทำได้แค่ 9
  assert.equal(overloadSuggestion(bench, []), null);
});

test('เตือนท่าที่ตัวเลขไม่ขึ้น 3 ครั้งติด', () => {
  const mk = (rows) => buildHistories(exs, ...Object.values(build(rows.map(([d, w, r]) => [d, [[bench, [[w, r]]]]])))).get('bench');
  // สถิติที่ครั้งแรก แล้ว 3 ครั้งถัดมาไม่ทำลายสถิติ
  assert.equal(detectStall(mk([['2026-10-01', 60, 8], ['2026-10-05', 55, 8], ['2026-10-09', 55, 8], ['2026-10-13', 55, 7]])).stalled, true);
  // ครั้งที่ 3 ทำลายสถิติ → ไม่เตือน
  assert.equal(detectStall(mk([['2026-10-01', 60, 8], ['2026-10-05', 55, 8], ['2026-10-09', 55, 8], ['2026-10-13', 62.5, 8]])).stalled, false);
  // มีไม่ถึง 4 ครั้ง → ไม่เตือน
  assert.equal(detectStall(mk([['2026-10-01', 60, 8], ['2026-10-05', 55, 8], ['2026-10-09', 55, 8]])).stalled, false);
  // กำลังไต่ขึ้นเรื่อยๆ (แม้ยังต่ำกว่าสถิติเดิม) → ไม่เตือน
  assert.equal(detectStall(mk([['2026-10-01', 80, 8], ['2026-10-05', 50, 8], ['2026-10-09', 52.5, 8], ['2026-10-13', 55, 8]])).stalled, false);
});

test('previousEntry: ข้ามครั้งปัจจุบัน และไม่เอาครั้งที่อยู่หลังวันที่', () => {
  const { sessions, sets } = build([
    ['2026-10-01', [[bench, [[50, 8]]]]],
    ['2026-10-05', [[bench, [[52.5, 8]]]]],
    ['2026-10-09', [[bench, [[55, 8]]]]],
  ]);
  const h = buildHistories(exs, sessions, sets).get('bench');
  assert.equal(previousEntry(h, 's-2026-10-05', '2026-10-05').date, '2026-10-01');
  assert.equal(previousEntry(h, 's-2026-10-01', '2026-10-01'), null);
});

test('เซ็ตต่อกลุ่มกล้าม / สัดส่วน ดัน:ดึง:ขา / ความสม่ำเสมอ', () => {
  const { sessions, sets } = build([
    ['2026-10-12', [[bench, [[50, 8], [50, 8], [50, 8]]], [row, [[30, 10], [30, 10]]]]], // จันทร์
    ['2026-10-15', [[squat, [[60, 8], [60, 8]]], [bench, [[40, 5, { is_warmup: true }]]]]],
    ['2026-10-05', [[bench, [[50, 8]]]]], // สัปดาห์ก่อน
  ]);
  const m = setsPerMuscle(sessions, sets, exs, '2026-10-12');
  assert.deepEqual(m, { อก: 3, หลัง: 2, ขา: 2 }); // วอร์มอัพไม่นับ
  const r = categoryRatio(sessions, sets, exs, '2026-10-12', '2026-10-18');
  assert.deepEqual({ d: r.ดัน, p: r.ดึง, l: r.ขา, t: r.total }, { d: 3, p: 2, l: 2, t: 7 });
  const c = weeklyConsistency(sessions, sets, [], '2026-10-12', 2);
  assert.deepEqual(c.map((x) => x.count), [1, 2]);
});

test('PR รายสัปดาห์: ต้องเคยเล่นมาก่อนและดีกว่าเดิมจริง', () => {
  const { sessions, sets } = build([
    ['2026-10-05', [[bench, [[50, 8]]], [row, [[30, 10]]]]],
    ['2026-10-13', [[bench, [[52.5, 8]]], [row, [[30, 8]]], [squat, [[60, 8]]]]],
  ]);
  const h = buildHistories(exs, sessions, sets);
  const prs = weekPRs(h, exs, '2026-10-12');
  assert.deepEqual(prs.map((p) => p.name), ['Bench']); // Row แย่ลง, Squat ไม่เคยเล่นมาก่อน
});

test('สรุปรายสัปดาห์: ค่าเฉลี่ย จำนวนครั้งฝึก PR และคำแนะนำ', () => {
  const { sessions, sets } = build([
    ['2026-10-05', [[bench, [[50, 8], [50, 8]]]]],
    ['2026-10-13', [[bench, [[52.5, 8], [52.5, 8]]]]],
  ]);
  const profile = { goal: 'lose', rate_kg_week: 0.5, kcal: 2000, kcal_tolerance: 100, protein_min: 140, protein_max: 160, sessions_per_week: 4 };
  const bodyLogs = [rec({ date: '2026-10-06', weight_kg: 82 }), rec({ date: '2026-10-13', weight_kg: 81.4 }), rec({ date: '2026-10-15', weight_kg: 81 })];
  const foodLogs = foodLogsFor(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'], 2000, 100);
  const s = weeklySummary({ ws: '2026-10-12', asOf: '2026-10-19', bodyLogs, foodLogs, sessions, sets, cardio: [], exercises: exs, profile });
  near(s.avgWeight, 81.2, 1e-9);
  near(s.weightDelta, 81.2 - 82, 1e-9);
  assert.equal(s.sessionCount, 1);
  assert.equal(s.prs.length, 1);
  assert.equal(s.intake.loggedDays, 4);
  near(s.intake.avgProtein, 100, 1e-9);
  assert.ok(s.advice.some((a) => a.includes('โปรตีน')), 'ควรเตือนโปรตีนต่ำกว่าเป้า');
  assert.ok(s.advice.some((a) => a.includes('ฝึกได้ 1 จาก 4')), 'ควรบอกว่าฝึกไม่ครบเป้า');
  assert.ok(s.overload.some((o) => o.name === 'Bench'), 'ทำครบ 8 ทุกเซ็ต ควรแนะนำเพิ่มน้ำหนัก');
});

test('ประมาณ kcal คาร์ดิโอ (ACSM) สมเหตุสมผล', () => {
  const k = estimateCardioKcal({ type: 'เดินชัน', minutes: 25, speed_kmh: 5, incline_pct: 10, weight_kg: 80 });
  assert.ok(k > 200 && k < 330, `ได้ ${k}`);
  assert.equal(estimateCardioKcal({ type: 'ปั่น', minutes: 25, speed_kmh: 20, weight_kg: 80 }), null);
  assert.equal(estimateCardioKcal({ type: 'วิ่ง', minutes: 0, speed_kmh: 10, weight_kg: 80 }), null);
  assert.ok(estimateCardioKcal({ type: 'วิ่ง', minutes: 30, speed_kmh: 10, weight_kg: 70 }) > estimateCardioKcal({ type: 'เดินชัน', minutes: 30, speed_kmh: 5, incline_pct: 0, weight_kg: 70 }));
});

// ---------- ท่าที่ลบจากคลังแล้วต้องยังอยู่ในประวัติ + ข้อมูลวันที่เพี้ยนต้องไม่ทำให้ล้ม ----------

test('ท่าที่ลบจากคลังแล้ว: ประวัติ/สถิติยังนับ แต่ไม่ขึ้นคำแนะนำเพิ่มน้ำหนัก/ตัวเลขไม่ขึ้น', async () => {
  const { buildHistories, weeklySummary, setsPerMuscle } = await import('../js/analytics.js');
  const mk = (o) => ({ created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', deleted: false, ...o });
  const ex = mk({ id: 'e1', name: 'Bench', muscle: 'อก', category: 'ดัน', rep_min: 8, rep_max: 10 });
  const sessions = [mk({ id: 's1', date: '2026-10-14' }), mk({ id: 's2', date: '2026-10-16' })];
  const sets = [mk({ id: 'a', session_id: 's1', exercise_id: 'e1', weight_kg: 60, reps: 10, order: 0 }), mk({ id: 'b', session_id: 's2', exercise_id: 'e1', weight_kg: 60, reps: 10, order: 0 })];
  const gone = { ...ex, deleted: true };
  const h = buildHistories([gone], sessions, sets);
  assert.equal(h.get('e1').length, 2);
  assert.ok(JSON.stringify(setsPerMuscle(sessions, sets, [gone], '2026-10-12')).includes('อก'));
  const sum = weeklySummary({ ws: '2026-10-12', asOf: '2026-10-18', bodyLogs: [], foodLogs: [], sessions, sets, cardio: [], exercises: [gone], profile: {} });
  assert.deepEqual(sum.overload, []);
  assert.deepEqual(sum.stalled, []);
});

test('cleanWeights/dailyIntake ข้ามแถวที่ date ไม่ใช่ YYYY-MM-DD (ไม่โยน error)', async () => {
  const { cleanWeights, dailyIntake } = await import('../js/analytics.js');
  const ok = { id: 'x', deleted: false };
  assert.deepEqual(cleanWeights([{ ...ok, date: 20261018, weight_kg: 80 }, { ...ok, date: '2026-10-19', weight_kg: 81 }]).map((p) => p.date), ['2026-10-19']);
  assert.deepEqual(Object.keys(dailyIntake([{ ...ok, date: {}, kcal: 5 }, { ...ok, date: '2026-10-19', kcal: 5 }])), ['2026-10-19']);
});
