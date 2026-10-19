// หน้า "วันนี้": ภาพรวมของวัน + จดร่างกาย/น้ำ

import * as db from '../db.js';
import { cleanWeights, movingAverage } from '../analytics.js';
import { diffDays, fmtShort } from '../dates.js';
import { getDate, setDate } from '../state.js';
import { field, fmtInt, fmtNum, h, icon, mount, numInput, readNum, textInput, toast } from '../ui.js';
import { dateNav, nutritionSummary, sumLogs, waterCard } from './common.js';
import { openStartSession } from './train.js';
import { syncDot } from './account.js';
import { gameCard } from './game.js';

export async function renderToday(root) {
  const date = getDate();
  const [profile, foodLogs, waterLogs, bodyDay, bodyAll, sessions] = await Promise.all([
    db.getProfile(),
    db.listByIndex('food_logs', 'date', date),
    db.listByIndex('water_logs', 'date', date),
    db.listByIndex('body_logs', 'date', date),
    db.list('body_logs'),
    db.listByIndex('sessions', 'date', date),
  ]);
  const refresh = () => renderToday(root);
  const body = bodyDay[0] || null;
  const totals = sumLogs(foodLogs);

  // เซ็ตของแต่ละครั้งที่ฝึกในวันนี้
  const sessionInfo = await Promise.all(
    sessions.map(async (s) => {
      const sets = (await db.listByIndex('sets', 'session_id', s.id)).filter((x) => !x.is_warmup && Number(x.reps) > 0);
      return { s, sets: sets.length, ex: new Set(sets.map((x) => x.exercise_id)).size };
    })
  );

  const gameEl = await gameCard();
  const weights = cleanWeights(bodyAll);
  const avg7 = movingAverage(weights).filter((p) => p.date <= date).slice(-1)[0];
  const lastW = weights.filter((p) => p.date <= date).slice(-1)[0];

  const needProfile = !(Number(profile.kcal) > 0);
  const recalc = Number(profile.calc_weight_kg) > 0 && lastW && Math.abs(lastW.weight - profile.calc_weight_kg) >= 5;

  const weight = numInput({ value: body?.weight_kg ?? '', placeholder: lastW ? fmtNum(lastW.weight) : 'กก.', 'aria-label': 'น้ำหนัก (กก.)' });
  const waist = numInput({ value: body?.waist_cm ?? '', placeholder: 'ซม.', 'aria-label': 'รอบเอว (ซม.)' });
  const steps = numInput({ value: body?.steps ?? '', placeholder: 'ก้าว', inputmode: 'numeric', 'aria-label': 'ก้าวเดิน' });
  const note = textInput({ value: body?.note || '', placeholder: 'เช่น นอนน้อย กินเค็ม' });

  mount(
    root,
    h('header', { class: 'page-head' }, h('h1', null, 'วันนี้'), syncDot()),
    dateNav(date, (d) => {
      setDate(d);
      refresh();
    }),
    needProfile
      ? h('section', { class: 'card notice' }, h('p', null, 'ยังไม่ได้ตั้งโปรไฟล์และเป้าหมาย — ตั้งครั้งเดียว แอปจะคำนวณ BMR/TDEE และเป้าแคลอรี่ให้'), h('a', { class: 'btn primary', href: '#/settings' }, 'ตั้งค่าโปรไฟล์'))
      : null,
    recalc
      ? h('section', { class: 'card notice warn' }, h('p', null, `น้ำหนักเปลี่ยนไปจากตอนคำนวณเป้า (${fmtNum(profile.calc_weight_kg)} → ${fmtNum(lastW.weight)} กก.) ควรคำนวณเป้าใหม่`), h('a', { class: 'btn', href: '#/settings' }, 'ไปคำนวณใหม่'))
      : null,
    gameEl,
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'อาหาร'), h('a', { class: 'btn small', href: '#/food' }, 'จดอาหาร')),
      foodLogs.length || !needProfile ? nutritionSummary(totals, profile) : h('p', { class: 'muted' }, `ยังไม่ได้จดอาหาร · กินไปแล้ว ${fmtInt(totals.kcal)} kcal`)
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'ฝึก')),
      sessionInfo.length
        ? h(
            'ul',
            { class: 'list' },
            sessionInfo.map(({ s, sets, ex }) =>
              h('li', null, h('a', { class: 'list-row', href: `#/train/s/${s.id}` }, h('span', { class: 'grow' }, h('strong', null, s.day_name || 'อื่นๆ'), h('small', { class: 'muted block' }, `${ex} ท่า · ${sets} เซ็ต`)), icon('chevR', 18)))
            )
          )
        : h('p', { class: 'muted' }, 'ยังไม่ได้ฝึกในวันนี้'),
      h('button', { class: 'btn primary mt', onclick: () => openStartSession({ date }) }, icon('plus', 18), sessionInfo.length ? ' เพิ่มอีกครั้งที่ฝึก' : ' เริ่มฝึก')
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'ร่างกาย'), avg7 ? h('span', { class: 'muted' }, `เฉลี่ย 7 วัน ${fmtNum(avg7.value)} กก.`) : null),
      h(
        'form',
        {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const fields = { weight_kg: readNum(weight), waist_cm: readNum(waist), steps: readNum(steps), note: note.value.trim() };
            const empty = fields.weight_kg == null && fields.waist_cm == null && fields.steps == null && !fields.note;
            if (empty && !body) return toast('ยังไม่ได้กรอกอะไร');
            await db.saveBodyLog(date, fields);
            toast('บันทึกร่างกายแล้ว');
            refresh();
          },
        },
        h('div', { class: 'grid3' }, field('น้ำหนัก (กก.)', weight), field('รอบเอว (ซม.)', waist), field('ก้าวเดิน', steps)),
        field('หมายเหตุ', note),
        h('button', { type: 'submit', class: 'btn primary' }, body ? 'อัปเดต' : 'บันทึก'),
        lastW && lastW.date !== date ? h('small', { class: 'muted' }, `ชั่งล่าสุด ${fmtNum(lastW.weight)} กก. เมื่อ ${fmtShort(lastW.date)} (${diffDays(lastW.date, date)} วันก่อน)`) : null
      )
    ),
    waterCard({ date, logs: waterLogs, profile, refresh })
  );
}
