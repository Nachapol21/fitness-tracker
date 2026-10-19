// ส่วนประกอบหน้าจอที่ใช้ร่วมกันหลายหน้า

import * as db from '../db.js';
import { fmtLong, toDateStr } from '../dates.js';
import { isKcalMissing } from '../food-quick.js';
import { fmtInt, fmtNum, h, icon, progress, toast } from '../ui.js';

export function dateNav(date, onChange) {
  const isToday = date === toDateStr();
  const picker = h('input', {
    type: 'date',
    class: 'datenav-input',
    value: date,
    'aria-label': 'เลือกวันที่',
    onchange: (e) => e.target.value && onChange(e.target.value),
  });
  return h(
    'div',
    { class: 'datenav' },
    h('button', { class: 'icon-btn', 'aria-label': 'วันก่อนหน้า', onclick: () => onChange(shift(date, -1)) }, icon('chevL')),
    h('div', { class: 'datenav-label' }, h('strong', null, isToday ? 'วันนี้' : fmtLong(date)), isToday ? h('small', { class: 'muted' }, fmtLong(date)) : null, picker),
    h('button', { class: 'icon-btn', 'aria-label': 'วันถัดไป', onclick: () => onChange(shift(date, 1)) }, icon('chevR'))
  );
}

function shift(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return toDateStr(new Date(y, m - 1, d + n));
}

/** สรุป kcal/โปรตีน/คาร์บ/ไขมันของวัน เทียบเป้า · totals.missing > 0 = ยังมีมื้อไม่มีแคล ยอดเป็นค่าขั้นต่ำ ("≥") */
export function nutritionSummary(totals, profile) {
  const t = Number(profile.kcal) || 0;
  const tol = Number(profile.kcal_tolerance) || 0;
  const missing = totals.missing || 0;
  const over = t > 0 && totals.kcal > t + tol;
  const remain = t - totals.kcal;
  const pMin = Number(profile.protein_min) || 0;
  const pMax = Number(profile.protein_max) || 0;

  const macro = (label, value, target, text, cls = '') =>
    h(
      'div',
      { class: 'macro' },
      h('div', { class: 'macro-head' }, h('span', null, label), h('span', { class: 'muted' }, text)),
      progress(value, target, { cls })
    );

  return h(
    'div',
    { class: 'stack tight' },
    h(
      'div',
      { class: 'kcal-head' },
      h('div', null, h('span', { class: 'big', id: 'kcal-total' }, `${missing ? '≥ ' : ''}${fmtInt(totals.kcal)}`), h('span', { class: 'muted' }, t > 0 ? ` / ${fmtInt(t)} kcal` : ' kcal')),
      missing
        ? h('div', { class: 'warn-text', id: 'kcal-incomplete' }, `ยังไม่มีแคล ${missing} มื้อ`)
        : t > 0
          ? h('div', { class: over ? 'bad-text' : 'muted' }, over ? `เกินเป้า ${fmtInt(-remain)}` : remain >= 0 ? `เหลือ ${fmtInt(remain)}` : `เกิน ${fmtInt(-remain)} (ยังอยู่ในช่วงที่รับได้)`)
          : null
    ),
    t > 0 ? progress(totals.kcal, t, { cls: over ? 'over' : '' }) : null,
    macro('โปรตีน', totals.protein, pMin || pMax, `${fmtNum(totals.protein, 0)} / ${pMin && pMax ? `${pMin}–${pMax}` : pMin || pMax || '–'} ก.`, pMin && totals.protein >= pMin ? 'good' : ''),
    h(
      'div',
      { class: 'grid2' },
      macro('คาร์บ', totals.carb, Number(profile.carb) || 0, `${fmtNum(totals.carb, 0)} / ${profile.carb ?? '–'} ก.`),
      macro('ไขมัน', totals.fat, Number(profile.fat) || 0, `${fmtNum(totals.fat, 0)} / ${profile.fat ?? '–'} ก.`)
    )
  );
}

/** รวมสารอาหารของ log · มื้อที่ยังไม่มีแคลไม่นับแคล/โปรตีน/คาร์บ/ไขมัน แต่นับจำนวนไว้ใน missing */
export function sumLogs(logs) {
  const t = { kcal: 0, protein: 0, carb: 0, fat: 0, missing: 0 };
  for (const l of logs) {
    if (isKcalMissing(l)) {
      t.missing += 1;
      continue;
    }
    t.kcal += Number(l.kcal) || 0;
    t.protein += Number(l.protein) || 0;
    t.carb += Number(l.carb) || 0;
    t.fat += Number(l.fat) || 0;
  }
  return t;
}

/** การ์ดน้ำดื่ม  logs = water_logs ของวันนั้น */
export function waterCard({ date, logs, profile, refresh }) {
  const total = logs.reduce((s, l) => s + (Number(l.ml) || 0), 0);
  const goal = Number(profile.water_goal_ml) || 2000;
  const add = async (ml) => {
    await db.create('water_logs', { date, ml });
    refresh();
  };
  const undo = async () => {
    const last = [...logs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    if (!last) return;
    await db.remove('water_logs', last.id);
    toast('ลบรายการน้ำล่าสุดแล้ว');
    refresh();
  };
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'น้ำดื่ม'), h('span', { class: 'muted' }, `${fmtInt(total)} / ${fmtInt(goal)} มล.`)),
    progress(total, goal, { cls: 'water' }),
    h(
      'div',
      { class: 'row gap wrap mt' },
      h('button', { class: 'btn grow', onclick: () => add(250) }, '+ 1 แก้ว (250)'),
      h('button', { class: 'btn grow', onclick: () => add(500) }, '+ 1 ขวด (500)'),
      logs.length ? h('button', { class: 'btn ghost', onclick: undo, 'aria-label': 'ย้อนรายการน้ำล่าสุด' }, 'ย้อน') : null
    )
  );
}
