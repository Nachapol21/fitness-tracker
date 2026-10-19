// หน้า "วิเคราะห์": สรุปรายสัปดาห์ · น้ำหนัก · การกิน · การฝึก
// การคำนวณทั้งหมดอยู่ใน ../analytics.js หน้านี้ทำหน้าที่แสดงผลเท่านั้น

import * as db from '../db.js';
import {
  buildHistories,
  categoryRatio,
  cleanWeights,
  dailyIntake,
  detectStall,
  estimateTDEE,
  intakeSummary,
  movingAverage,
  overloadSuggestion,
  round,
  setsPerMuscle,
  weeklyConsistency,
  weeklySummary,
  weeklyWeightAverages,
  weightAssessment,
} from '../analytics.js';
import { MUSCLES } from '../constants.js';
import { addDays, dateRange, dayNum, diffDays, fmtRange, fmtShort, toDateStr, weekStart } from '../dates.js';
import { barChart, hBars, lineChart, noData, stackBar } from '../charts.js';
import { state } from '../state.js';
import { chipGroup, emptyState, fmtInt, fmtNum, h, mount } from '../ui.js';

const callout = (level, text) => h('div', { class: `callout ${level}`, role: level === 'warn' ? 'alert' : 'note' }, text);
const stat = (label, value, sub) => h('div', { class: 'stat' }, h('small', { class: 'muted' }, label), h('strong', { class: 'stat-val' }, value), sub ? h('small', { class: 'muted' }, sub) : null);

export async function renderInsights(root) {
  const [data, profile, allExercises] = await Promise.all([db.loadAll(), db.getProfile(), db.list('exercises', { includeDeleted: true })]);
  data.exercises = allExercises; // รวมท่าที่ลบจากคลังแล้ว: ประวัติ/กราฟของท่าเหล่านั้นยังอยู่ (แสดงแบบจาง)
  const today = toDateStr();
  const rerender = () => renderInsights(root);
  const tabs = chipGroup({
    options: [
      { value: 'week', label: 'รายสัปดาห์' },
      { value: 'weight', label: 'น้ำหนัก' },
      { value: 'food', label: 'กิน' },
      { value: 'train', label: 'ฝึก' },
    ],
    value: state.insightsTab,
    className: 'tabs',
    onChange: (v) => {
      state.insightsTab = v;
      rerender();
    },
  });
  const body = { week: weekTab, weight: weightTab, food: foodTab, train: trainTab }[state.insightsTab] || weekTab;
  mount(root, h('header', { class: 'page-head' }, h('h1', null, 'วิเคราะห์')), tabs.el, body({ data, profile, today, rerender }));
}

// ---------- สรุปรายสัปดาห์ ----------

function weekTab({ data, profile, today, rerender }) {
  const thisWs = weekStart(today);
  const ws = state.insightsWeek || thisWs;
  const sum = weeklySummary({ ws, asOf: today, bodyLogs: data.body_logs, foodLogs: data.food_logs, sessions: data.sessions, sets: data.sets, cardio: data.cardio, exercises: data.exercises, profile });
  const go = (n) => {
    const next = addDays(ws, 7 * n);
    state.insightsWeek = next >= thisWs ? null : next;
    rerender();
  };
  const i = sum.intake;
  const tiles = h(
    'div',
    { class: 'stats' },
    stat('น้ำหนักเฉลี่ย', sum.avgWeight != null ? `${fmtNum(sum.avgWeight)} กก.` : '–', sum.weightDelta != null ? `${sum.weightDelta > 0 ? '+' : ''}${fmtNum(sum.weightDelta, 2)} จากสัปดาห์ก่อน` : `ชั่ง ${sum.weighIns} ครั้ง`),
    stat('แคลอรี่เฉลี่ย', i.avgKcal != null ? `${fmtInt(i.avgKcal)}` : '–', i.loggedDays ? `จด ${i.loggedDays}/${i.totalDays} วัน${profile.kcal ? ` · ตามเป้า ${i.kcalOkDays} วัน` : ''}` : 'ยังไม่ได้จดอาหาร'),
    stat('โปรตีนเฉลี่ย', i.avgProtein != null ? `${fmtNum(i.avgProtein, 0)} ก.` : '–', i.loggedDays && profile.protein_min ? `ถึงเป้า ${i.proteinOkDays}/${i.loggedDays} วัน` : ''),
    stat('ฝึก', `${sum.sessionCount} / ${sum.sessionTarget}`, 'ครั้ง')
  );
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'datenav' },
      h('button', { class: 'icon-btn', 'aria-label': 'สัปดาห์ก่อน', onclick: () => go(-1) }, '‹'),
      h('div', { class: 'datenav-label' }, h('strong', null, ws === thisWs ? 'สัปดาห์นี้' : fmtRange(ws, sum.we)), ws === thisWs ? h('small', { class: 'muted' }, fmtRange(ws, sum.we)) : null),
      h('button', { class: 'icon-btn', 'aria-label': 'สัปดาห์ถัดไป', disabled: ws >= thisWs, onclick: () => go(1) }, '›')
    ),
    h('section', { class: 'card' }, tiles),
    h(
      'section',
      { class: 'card' },
      h('h2', null, 'สถิติใหม่ (PR)'),
      sum.prs.length
        ? h('ul', { class: 'list plain' }, sum.prs.map((p) => h('li', { class: 'pad-s' }, h('strong', null, p.name), ' ', p.timed ? `${p.best.reps} วินาที` : `${fmtNum(p.best.weight)}×${p.best.reps}`, h('small', { class: 'muted block' }, `เดิม ${p.timed ? `${p.prevBest.reps} วินาที` : `${fmtNum(p.prevBest.weight)}×${p.prevBest.reps}`} · ${fmtShort(p.date)}`))))
        : h('p', { class: 'muted' }, 'ยังไม่มี PR ในสัปดาห์นี้ (เทียบกับท่าที่เคยเล่นก่อนหน้า)')
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', null, 'สิ่งที่ควรปรับ'),
      sum.advice.length ? h('ul', { class: 'bullets' }, sum.advice.map((a) => h('li', null, a))) : h('p', { class: 'good-text' }, 'ไม่มีอะไรต้องปรับเป็นพิเศษ ทำต่อได้เลย'),
      h('small', { class: 'muted' }, 'คำแนะนำมาจากกฎง่ายๆ ในแอป ไม่ใช่คำแนะนำทางการแพทย์')
    )
  );
}

// ---------- น้ำหนัก ----------

function weightTab({ data, profile, today, rerender }) {
  const all = cleanWeights(data.body_logs);
  if (!all.length) return emptyState('ยังไม่มีข้อมูลน้ำหนัก — บันทึกได้ที่หน้า "วันนี้"');
  const range = state.weightRange;
  const from = range ? addDays(today, -(range - 1)) : '0000-00-00';
  const ma = movingAverage(all);
  const pts = all.filter((p) => p.date >= from);
  const maPts = ma.filter((p) => p.date >= from);
  const series = [
    { name: 'น้ำหนักที่ชั่ง', color: 'c3', points: pts.map((p) => ({ x: dayNum(p.date), y: p.weight })), width: 1.5, dotR: 2.8 },
    { name: 'เฉลี่ย 7 วัน', color: 'c1', points: maPts.map((p) => ({ x: dayNum(p.date), y: p.value })), width: 2.6, dots: false },
  ];
  const rate = Number(profile.rate_kg_week) || 0;
  if (maPts.length >= 2 && rate > 0 && profile.goal !== 'maintain') {
    const a = maPts[0];
    const b = maPts[maPts.length - 1];
    const sign = profile.goal === 'gain' ? 1 : -1;
    const span = Math.max(diffDays(a.date, b.date), 7);
    series.push({ name: `เส้นเป้า ${rate} กก./สัปดาห์`, color: 'c2', dashed: true, dots: false, width: 1.8, points: [{ x: dayNum(a.date), y: a.value }, { x: dayNum(a.date) + span, y: a.value + (sign * rate * span) / 7 }] });
  }
  const first = all[0];
  const last = all[all.length - 1];
  const weekly = weeklyWeightAverages(all).slice(-8);
  const chips = chipGroup({
    options: [{ value: 30, label: '30 วัน' }, { value: 90, label: '90 วัน' }, { value: 0, label: 'ทั้งหมด' }],
    value: range,
    onChange: (v) => {
      state.weightRange = v;
      rerender();
    },
  });
  return h(
    'div',
    { class: 'stack' },
    chips.el,
    h('section', { class: 'card' }, h('h2', null, 'น้ำหนัก (กก.)'), lineChart({ series, yFmt: (v) => fmtNum(v), aria: 'กราฟน้ำหนักและค่าเฉลี่ย 7 วัน' })),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'stats' }, stat('เริ่มต้น', `${fmtNum(first.weight)} กก.`, fmtShort(first.date)), stat('ล่าสุด', `${fmtNum(last.weight)} กก.`, fmtShort(last.date)), stat('เปลี่ยนไป', `${last.weight - first.weight > 0 ? '+' : ''}${fmtNum(last.weight - first.weight)} กก.`, `${diffDays(first.date, last.date)} วัน`)),
      ...weightAssessment(all, profile, today).map((a) => callout(a.level, a.text))
    ),
    weekly.length
      ? h(
          'section',
          { class: 'card' },
          h('h2', null, 'ค่าเฉลี่ยรายสัปดาห์'),
          h('ul', { class: 'list plain' }, weekly.map((w, i) => h('li', { class: 'row pad-s' }, h('span', { class: 'grow' }, `สัปดาห์ ${fmtShort(w.weekStart)}`, h('small', { class: 'muted' }, ` · ชั่ง ${w.n} ครั้ง`)), h('strong', null, `${fmtNum(w.avg, 2)} กก.`), i > 0 ? h('small', { class: `muted delta` }, `${w.avg - weekly[i - 1].avg > 0 ? '+' : ''}${fmtNum(w.avg - weekly[i - 1].avg, 2)}`) : null)))
        )
      : null,
    h('small', { class: 'muted' }, 'น้ำหนักแต่ละวันแกว่งได้จากน้ำ/เกลือ/ห้องน้ำ ให้ดูแนวโน้มค่าเฉลี่ยมากกว่าตัวเลขรายวัน')
  );
}

// ---------- การกิน ----------

function foodTab({ data, profile, today, rerender }) {
  const n = state.foodRange;
  const dates = dateRange(addDays(today, -(n - 1)), today);
  const daily = dailyIntake(data.food_logs);
  const sum = intakeSummary(daily, profile, dates);
  const tol = Number(profile.kcal_tolerance) || 0;
  const t = Number(profile.kcal) || 0;
  const pMin = Number(profile.protein_min) || 0;
  const chips = chipGroup({
    options: [{ value: 7, label: '7 วัน' }, { value: 14, label: '14 วัน' }, { value: 30, label: '30 วัน' }],
    value: n,
    onChange: (v) => {
      state.foodRange = v;
      rerender();
    },
  });
  const lab = (d) => String(Number(d.slice(8)));
  const kBars = sum.days.map((d) => ({ label: lab(d.date), value: d.kcal, cls: !d.logged ? 'none' : t ? (d.kcalOk ? 'ok' : d.kcal > t ? 'over' : 'under') : 'ok' }));
  const pBars = sum.days.map((d) => ({ label: lab(d.date), value: d.protein, cls: !d.logged ? 'none' : pMin ? (d.proteinOk ? 'ok' : 'under') : 'ok' }));
  const w = cleanWeights(data.body_logs);
  const est = estimateTDEE(w, daily, profile, { asOf: today });

  const tdeeCard = est.ok
    ? h(
        'section',
        { class: 'card' },
        h('h2', null, 'ประมาณ TDEE จริง'),
        h('div', { class: 'stats' }, stat('TDEE ที่ประมาณได้', `${fmtInt(est.tdee)} kcal`, `ความมั่นใจ${est.confidence}`), stat('กินเฉลี่ย', `${fmtInt(est.avgIntake)} kcal`, `${est.usedDays} วันที่จด`), stat('น้ำหนักเปลี่ยน', `${est.slopePerWeek > 0 ? '+' : ''}${fmtNum(est.slopePerWeek, 2)} กก./สัปดาห์`)),
        h(
          'p',
          null,
          `เป้าแคลอรี่ที่แนะนำตามเป้าหมายตอนนี้ ≈ `,
          h('strong', null, `${fmtInt(est.suggestedKcal)} kcal`),
          t ? ` (เป้าปัจจุบัน ${fmtInt(t)})` : ''
        ),
        h('small', { class: 'muted' }, 'คิดจาก: แคลอรี่ที่กินเฉลี่ย − (น้ำหนักที่เปลี่ยนต่อวัน × 7,700) ยิ่งจดอาหารครบและชั่งสม่ำเสมอ ยิ่งแม่น เป็นแค่ค่าประมาณ')
      )
    : h(
        'section',
        { class: 'card' },
        h('h2', null, 'ประมาณ TDEE จริง'),
        callout('info', `ข้อมูลยังไม่พอ — ต้องจดอาหารอย่างน้อย ${est.minDays} วัน (ตอนนี้ ${est.loggedDays} วันใน 28 วันล่าสุด) และชั่งน้ำหนักอย่างน้อย 4 ครั้งที่ห่างกันเกิน 12 วัน (ตอนนี้ ${est.weighIns} ครั้ง ห่างกัน ${est.weighSpan} วัน)`),
        h('small', { class: 'muted' }, 'เมื่อข้อมูลครบ แอปจะเทียบแคลอรี่ที่กินกับน้ำหนักที่เปลี่ยน เพื่อประมาณ TDEE จริงของคุณและแนะนำเป้าใหม่')
      );

  return h(
    'div',
    { class: 'stack' },
    chips.el,
    h(
      'section',
      { class: 'card' },
      h('h2', null, 'แคลอรี่ต่อวัน'),
      sum.loggedDays ? barChart({ bars: kBars, band: t ? [t - tol, t + tol] : undefined, ref: t || undefined, refLabel: t ? `เป้า ${fmtInt(t)}` : '', aria: 'กราฟแคลอรี่รายวัน' }) : noData('ยังไม่ได้จดอาหารในช่วงนี้'),
      h('div', { class: 'stats' }, stat('เฉลี่ย', sum.avgKcal != null ? `${fmtInt(sum.avgKcal)} kcal` : '–', `จด ${sum.loggedDays}/${sum.totalDays} วัน`), t ? stat('ตามเป้า', `${sum.kcalOkDays}/${sum.loggedDays} วัน`, `${fmtInt(t - tol)}–${fmtInt(t + tol)} kcal`) : null)
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', null, 'โปรตีนต่อวัน (ก.)'),
      sum.loggedDays ? barChart({ bars: pBars, ref: pMin || undefined, refLabel: pMin ? `เป้า ${pMin}` : '', aria: 'กราฟโปรตีนรายวัน' }) : noData('ยังไม่ได้จดอาหารในช่วงนี้'),
      h('div', { class: 'stats' }, stat('เฉลี่ย', sum.avgProtein != null ? `${fmtNum(sum.avgProtein, 0)} ก.` : '–'), pMin ? stat('ถึงเป้า', `${sum.proteinOkDays}/${sum.loggedDays} วัน`, `≥ ${pMin} ก.`) : null)
    ),
    tdeeCard
  );
}

// ---------- การฝึก ----------

function trainTab({ data, profile, today }) {
  const { exercises, sessions, sets, cardio } = data;
  const histories = buildHistories(exercises, sessions, sets);
  if (!histories.size) return emptyState('ยังไม่มีเซ็ตที่บันทึก — จดการฝึกที่แท็บ "ฝึก" ก่อน');
  const exMap = new Map(exercises.map((e) => [e.id, e]));
  const target = Number(profile.sessions_per_week) || 4;

  const list = [...histories.entries()].map(([id, hist]) => ({ id, ex: exMap.get(id), hist, last: hist[hist.length - 1].date })).sort((a, b) => (a.last < b.last ? 1 : -1));
  if (!list.some((x) => x.id === state.exerciseId)) state.exerciseId = list[0].id;
  const cur = list.find((x) => x.id === state.exerciseId);
  const viewEl = () => document.getElementById('view');
  const exSelect = h(
    'select',
    {
      class: 'input',
      'aria-label': 'เลือกท่า',
      value: state.exerciseId,
      onchange: (e) => {
        state.exerciseId = e.target.value;
        renderInsights(viewEl());
      },
    },
    list.map((x) => h('option', { value: x.id }, `${x.ex.name}${x.ex.machine ? ` · ${x.ex.machine}` : ''} (${x.hist.length} ครั้ง)${x.ex.deleted ? ' · ลบจากคลังแล้ว' : ''}`))
  );

  const metric = state.exMetric;
  const metrics = chipGroup({
    options: [{ value: 'best', label: 'เซ็ตที่ดีที่สุด' }, { value: 'e1rm', label: '1RM ประมาณ' }, { value: 'volume', label: 'ปริมาณรวม' }],
    value: metric,
    onChange: (v) => {
      state.exMetric = v;
      renderInsights(viewEl());
    },
  });
  const useReps = cur.hist.every((x) => x.e1rm === 0);
  const pick = {
    best: { name: useReps ? 'จำนวนครั้งสูงสุด' : 'น้ำหนักของเซ็ตที่ดีที่สุด (กก.)', y: (x) => (useReps ? x.best.reps : x.best.weight) },
    e1rm: { name: useReps ? 'จำนวนครั้งสูงสุด' : '1RM ประมาณ (Epley, กก.)', y: (x) => (useReps ? x.best.reps : x.e1rm) },
    volume: { name: 'ปริมาณรวม (น้ำหนัก × ครั้ง)', y: (x) => x.volume },
  }[metric];
  const chart = lineChart({
    series: [{ name: pick.name, color: metric === 'volume' ? 'c2' : 'c1', points: cur.hist.map((x) => ({ x: dayNum(x.date), y: round(pick.y(x), 1) })), area: true }],
    yFmt: (v) => fmtNum(v),
    aria: `กราฟ ${cur.ex.name}: ${pick.name}`,
  });

  const sug = overloadSuggestion(cur.ex, cur.hist);
  const stall = detectStall(cur.hist);

  const thisWs = weekStart(today);
  const perMuscle = setsPerMuscle(sessions, sets, exercises, thisWs);
  const muscleRows = MUSCLES.map((m) => ({ label: m, value: perMuscle[m] || 0, cls: (perMuscle[m] || 0) >= 10 ? 'ok' : 'none' }));
  const ratio = categoryRatio(sessions, sets, exercises, addDays(today, -27), today);
  const cons = weeklyConsistency(sessions, sets, cardio, thisWs, 8);

  // ท่าที่ควรเพิ่มน้ำหนัก / ท่าที่ตัวเลขไม่ขึ้น (ดูเฉพาะท่าที่เล่นใน 45 วันล่าสุด)
  const recent = list.filter((x) => !x.ex.deleted && diffDays(x.last, today) <= 45);
  const overloads = recent.map((x) => ({ x, o: overloadSuggestion(x.ex, x.hist) })).filter((r) => r.o);
  const stalls = recent.filter((x) => detectStall(x.hist).stalled);

  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: `card ${cur.ex.deleted ? 'faded' : ''}` },
      h('h2', null, 'กราฟแต่ละท่า'),
      exSelect,
      metrics.el,
      chart,
      sug ? callout('ok', `ครั้งล่าสุด (${fmtShort(sug.date)}) ทำครบ ${sug.repMax} ครั้งทุกเซ็ต — ครั้งหน้าลองเพิ่มเป็น ${sug.low}–${sug.high} กก.`) : null,
      stall.stalled ? callout('warn', `ตัวเลขไม่ขึ้น ${stall.sessions} ครั้งติด (ตั้งแต่ ${fmtShort(stall.since)}) — ลองพักเบาลง เช็กการนอน/การกิน หรือเปลี่ยนช่วงครั้ง`) : null,
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, ['วันที่', 'เซ็ตที่ดีที่สุด', '1RM≈', 'ปริมาณ'].map((t) => h('th', null, t)))),
          h(
            'tbody',
            null,
            [...cur.hist].reverse().slice(0, 10).map((x) =>
              h('tr', null, h('td', null, fmtShort(x.date)), h('td', null, cur.ex.timed || x.best.weight === 0 ? `${x.best.reps}` : `${fmtNum(x.best.weight)}×${x.best.reps}`), h('td', null, x.e1rm ? fmtNum(x.e1rm) : '–'), h('td', null, fmtInt(x.volume)))
            )
          )
        )
      )
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', null, 'ความสม่ำเสมอ'),
      h('p', { class: 'muted' }, `จำนวนครั้งที่ฝึกต่อสัปดาห์ เทียบเป้า ${target} ครั้ง`),
      barChart({ bars: cons.map((c) => ({ label: fmtShort(c.weekStart), value: c.count, cls: c.count >= target ? 'ok' : c.count > 0 ? 'under' : 'none' })), ref: target, refLabel: `เป้า ${target}`, yFmt: (v) => String(Math.round(v)), height: 170, aria: 'กราฟจำนวนครั้งที่ฝึกต่อสัปดาห์', labelEvery: 2 })
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', null, 'เซ็ตต่อกลุ่มกล้ามสัปดาห์นี้'),
      hBars({ rows: muscleRows, max: 12, marks: [{ x: 10, label: '10' }], aria: 'เซ็ตต่อกลุ่มกล้าม' }),
      h('small', { class: 'muted' }, 'นับเฉพาะเซ็ตทำงาน (ไม่รวมวอร์มอัพ) · เส้น 10 เซ็ต/สัปดาห์เป็นแนวทางทั่วไปสำหรับสร้างกล้ามเนื้อ ไม่ใช่กฎตายตัว')
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', null, 'สัดส่วน ดัน : ดึง : ขา (28 วันล่าสุด)'),
      stackBar({ parts: [{ label: 'ดัน', value: ratio.ดัน, color: 'c1' }, { label: 'ดึง', value: ratio.ดึง, color: 'c3' }, { label: 'ขา', value: ratio.ขา, color: 'c2' }, ...(ratio.core ? [{ label: 'core', value: ratio.core, color: 'c4' }] : [])], aria: 'สัดส่วนดันดึงขา' }),
      ratio.total && ratio.ขา === 0 ? callout('info', 'ยังไม่มีเซ็ตขาใน 28 วันล่าสุด') : null,
      ratio.ดัน > 0 && ratio.ดึง > 0 && ratio.ดัน > ratio.ดึง * 1.5 ? callout('info', 'ท่าดันมากกว่าท่าดึงค่อนข้างมาก ลองเพิ่มท่าดึง (row/pulldown/face pull) เพื่อสมดุลไหล่') : null
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', null, 'ท่าที่พร้อมเพิ่มน้ำหนัก'),
      overloads.length
        ? h('ul', { class: 'list plain' }, overloads.map(({ x, o }) => h('li', { class: 'pad-s' }, h('strong', null, x.ex.name), h('small', { class: 'muted block' }, `ทำครบ ${o.repMax} ทุกเซ็ตที่ ${fmtNum(o.from)} กก. → ลอง ${o.low}–${o.high} กก.`))))
        : h('p', { class: 'muted' }, 'ยังไม่มีท่าที่ครบเลขบนของช่วงครั้งทุกเซ็ต'),
      h('h2', { class: 'mt' }, 'ท่าที่ตัวเลขไม่ขึ้น 3 ครั้งติด'),
      stalls.length ? h('ul', { class: 'list plain' }, stalls.map((x) => h('li', { class: 'pad-s warn-text' }, x.ex.name))) : h('p', { class: 'muted' }, 'ไม่มี')
    )
  );
}
