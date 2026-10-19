// หน้า "ฝึก": รายการครั้งที่ฝึก, จดเซ็ต, คาร์ดิโอ, คลังท่า

import * as db from '../db.js';
import { buildHistories, cleanWeights, detectStall, estimateCardioKcal, overloadSuggestion, previousEntry, weekSessionCount } from '../analytics.js';
import { CARDIO_TYPES, CATEGORIES, DAY_NAMES, EQUIPMENT, MUSCLES } from '../constants.js';
import { fmtLong, fmtShort, nowHM, toDateStr, weekStart } from '../dates.js';
import { getDate } from '../state.js';
import { chipGroup, clear, confirmSheet, emptyState, field, flushPending, fmtNum, h, icon, mount, numInput, openSheet, readNum, textInput, toast, trackPending, untrackPending } from '../ui.js';

const ROTATION = ['Upper A', 'Lower A', 'Upper B', 'Lower B'];
const byName = (a, b) => a.name.localeCompare(b.name, 'en');
const exTitle = (ex) => ex.name + (ex.machine ? ` · ${ex.machine}` : '');

function fmtSet(s, ex) {
  if (ex?.timed) return `${fmtNum(s.reps, 0)} วิ`;
  return s.weight > 0 ? `${fmtNum(s.weight)}×${fmtNum(s.reps, 0)}` : `${fmtNum(s.reps, 0)} ครั้ง`;
}

export function nextDayName(sessions) {
  const last = [...sessions].sort((a, b) => (a.date === b.date ? (a.created_at < b.created_at ? 1 : -1) : a.date < b.date ? 1 : -1))[0];
  if (!last) return ROTATION[0];
  const i = ROTATION.indexOf(last.day_name);
  return i < 0 ? ROTATION[0] : ROTATION[(i + 1) % ROTATION.length];
}

// ---------- รายการครั้งที่ฝึก ----------

export async function renderTrain(root, params = []) {
  if (params[0] === 's' && params[1]) return renderSession(root, params[1]);
  if (params[0] === 'ex') return renderExercises(root);

  const [profile, sessions, sets, cardio, exercises] = await Promise.all([db.getProfile(), db.list('sessions'), db.list('sets'), db.list('cardio'), db.list('exercises', { includeDeleted: true })]);
  const exMap = new Map(exercises.map((e) => [e.id, e]));
  const today = toDateStr();
  const target = Number(profile.sessions_per_week) || 4;
  const done = weekSessionCount(sessions, sets, cardio, weekStart(today));
  const sorted = [...sessions].sort((a, b) => (a.date === b.date ? (a.created_at < b.created_at ? 1 : -1) : a.date < b.date ? 1 : -1));

  const rows = sorted.slice(0, 60).map((s) => {
    const ss = sets.filter((x) => x.session_id === s.id && !x.is_warmup && Number(x.reps) > 0);
    const exIds = [...new Set(ss.map((x) => x.exercise_id))];
    const hasCardio = cardio.some((c) => c.session_id === s.id);
    return h(
      'li',
      null,
      h(
        'a',
        { class: 'list-row', href: `#/train/s/${s.id}` },
        h(
          'span',
          { class: 'grow' },
          h('strong', null, `${s.day_name || 'อื่นๆ'}`),
          h('small', { class: 'muted block' }, exIds.slice(0, 4).map((id) => exMap.get(id)?.name || '?').join(', ') + (exIds.length > 4 ? ` +${exIds.length - 4}` : ''))
        ),
        h('span', { class: 'right' }, h('strong', null, `${s.date_estimated ? '≈ ' : ''}${fmtShort(s.date)}`), h('small', { class: 'muted block' }, `${exIds.length} ท่า · ${ss.length} เซ็ต${hasCardio ? ' · คาร์ดิโอ' : ''}`))
      )
    );
  });

  mount(
    root,
    h('header', { class: 'page-head' }, h('h1', null, 'ฝึก'), h('a', { class: 'btn small ghost', href: '#/train/ex' }, 'คลังท่า')),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'สัปดาห์นี้'), h('span', { class: done >= target ? 'good-text' : 'muted' }, `${done} / ${target} ครั้ง`)),
      h('div', { class: 'dots' }, Array.from({ length: Math.max(target, done) }, (_, i) => h('i', { class: `dot ${i < done ? 'on' : ''}` }))),
      h('button', { class: 'btn primary big mt', onclick: () => openStartSession({ date: getDate(), sessions }) }, icon('plus', 20), ' เริ่มฝึก')
    ),
    sorted.length
      ? h('section', { class: 'card flush' }, h('h2', { class: 'pad-h' }, 'ประวัติการฝึก'), h('ul', { class: 'list' }, rows))
      : emptyState('ยังไม่มีบันทึกการฝึก กด "เริ่มฝึก" เพื่อจดครั้งแรก')
  );
}

/** เปิดแผ่นเริ่มครั้งใหม่ ใช้ได้จากหน้าอื่นด้วย (ส่ง sessions มาถ้ามีแล้ว) */
export async function openStartSession({ date, sessions }) {
  const all = sessions || (await db.list('sessions'));
  const suggested = nextDayName(all);
  const dateInput = h('input', { type: 'date', class: 'input', value: date });
  const dayChips = chipGroup({ options: DAY_NAMES, value: suggested });
  const copy = h('input', { type: 'checkbox', checked: all.length > 0 });
  const sheet = openSheet({
    title: 'เริ่มฝึก',
    content: h(
      'div',
      { class: 'stack' },
      field('วันที่', dateInput),
      field('วันฝึก', dayChips.el, `ต่อจากครั้งก่อนคือ ${suggested}`),
      all.length ? h('label', { class: 'check' }, copy, h('span', null, 'ใช้รายการท่าจากครั้งก่อน (ยังไม่ใส่เซ็ต)')) : null,
      h(
        'button',
        {
          class: 'btn primary big',
          onclick: async () => {
            const d = dateInput.value || date;
            const dayName = dayChips.get();
            let exerciseIds = [];
            if (copy.checked) {
              const same = all.filter((s) => s.day_name === dayName && dayName !== 'อื่นๆ');
              const pool = same.length ? same : all;
              const prior = [...pool].sort((a, b) => (a.date === b.date ? (a.created_at < b.created_at ? 1 : -1) : a.date < b.date ? 1 : -1))[0];
              if (prior) exerciseIds = await exerciseIdsOf(prior);
            }
            const s = await db.create('sessions', { date: d, day_name: dayName, start_time: d === toDateStr() ? nowHM() : null, end_time: null, rpe: null, note: '', exercise_ids: exerciseIds });
            sheet.close();
            location.hash = `#/train/s/${s.id}`;
          },
        },
        'เริ่มเลย'
      )
    ),
  });
}

async function exerciseIdsOf(session) {
  const sets = await db.listByIndex('sets', 'session_id', session.id);
  const ids = [];
  for (const id of session.exercise_ids || []) if (!ids.includes(id)) ids.push(id);
  for (const s of [...sets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) if (!ids.includes(s.exercise_id)) ids.push(s.exercise_id);
  return ids;
}

// ---------- หน้าจดการฝึก ----------

async function renderSession(root, id) {
  const session = await db.get('sessions', id);
  if (!session) {
    mount(root, emptyState('ไม่พบครั้งที่ฝึกนี้', h('a', { class: 'btn', href: '#/train' }, 'กลับ')));
    return;
  }
  const [allExercises, sessions, allSets, cardio, bodyLogs, profile] = await Promise.all([db.list('exercises', { includeDeleted: true }), db.list('sessions'), db.list('sets'), db.list('cardio'), db.list('body_logs'), db.getProfile()]);
  const exercises = allExercises.filter((e) => !e.deleted); // ตัวเลือกเพิ่มท่าใช้เฉพาะท่าที่ยังอยู่ในคลัง
  const exMap = new Map(allExercises.map((e) => [e.id, e])); // ประวัติแสดงท่าที่ลบแล้วด้วย (แบบจาง)
  const histories = buildHistories(allExercises, sessions, allSets);
  const mySets = allSets.filter((s) => s.session_id === id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const myCardio = cardio.filter((c) => c.session_id === id);

  const refresh = async () => {
    await flushPending();
    await renderSession(root, id);
  };
  const ids = [...(session.exercise_ids || [])];
  for (const s of mySets) if (!ids.includes(s.exercise_id)) ids.push(s.exercise_id);

  const saveSession = async (patch) => {
    await db.update('sessions', id, patch);
  };

  // ----- รายละเอียดครั้งที่ฝึก -----
  const dateInput = h('input', {
    type: 'date',
    class: 'input',
    value: session.date,
    onchange: async (e) => {
      if (e.target.value) {
        await saveSession({ date: e.target.value, date_estimated: false });
        refresh();
      }
    },
  });
  const dayChips = chipGroup({ options: DAY_NAMES, value: session.day_name, onChange: (v) => saveSession({ day_name: v }).then(() => (titleEl.textContent = v)) });
  const startInput = h('input', { type: 'time', class: 'input', value: session.start_time || '', onchange: (e) => saveSession({ start_time: e.target.value || null }) });
  const endInput = h('input', { type: 'time', class: 'input', value: session.end_time || '', onchange: (e) => saveSession({ end_time: e.target.value || null }) });
  const rpeChips = chipGroup({
    options: Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
    value: session.rpe,
    className: 'rpe',
    onChange: (v) => saveSession({ rpe: v }),
  });
  const noteInput = h('textarea', { class: 'input', rows: '2', placeholder: 'หมายเหตุ เช่น นอนน้อย ไหล่ตึง' }, session.note || '');
  noteInput.addEventListener('change', () => saveSession({ note: noteInput.value }));
  const titleEl = h('strong', null, session.day_name || 'อื่นๆ');
  const detailsEl = h(
    'details',
    { class: 'details' },
    h('summary', null, 'รายละเอียด (เวลา · ความเหนื่อย · หมายเหตุ)'),
    h(
      'div',
      { class: 'stack' },
      field('วันที่', dateInput),
      field('วันฝึก', dayChips.el),
      h('div', { class: 'grid2' }, field('เริ่ม', startInput), field('จบ', endInput)),
      field('ความเหนื่อยโดยรวม (1–10)', rpeChips.el),
      field('หมายเหตุ', noteInput)
    )
  );

  // ----- บล็อกแต่ละท่า -----
  const blocks = ids.map((exId) => {
    const ex = exMap.get(exId);
    if (!ex) return null;
    return exerciseBlock({
      ex,
      session,
      sets: mySets.filter((s) => s.exercise_id === exId),
      history: histories.get(exId) || [],
      refresh,
      removeFromSession: async () => {
        const mine = mySets.filter((s) => s.exercise_id === exId);
        if (mine.length && !(await confirmSheet(`ลบ ${ex.name} และ ${mine.length} เซ็ตออกจากครั้งนี้?`, { okText: 'ลบ', danger: true }))) return;
        await flushPending();
        await Promise.all(mine.map((s) => db.remove('sets', s.id)));
        await saveSession({ exercise_ids: ids.filter((x) => x !== exId) });
        refresh();
      },
    });
  });

  const weightNow = cleanWeights(bodyLogs).slice(-1)[0]?.weight ?? profile.calc_weight_kg ?? null;
  const totalSets = mySets.filter((s) => !s.is_warmup && Number(s.reps) > 0).length;

  mount(
    root,
    h(
      'header',
      { class: 'page-head' },
      h('a', { class: 'btn small ghost', href: '#/train' }, '‹ กลับ'),
      h('div', { class: 'grow center' }, titleEl, h('small', { class: 'muted block' }, fmtLong(session.date) + (session.date_estimated ? ' (วันที่โดยประมาณ)' : ''))),
      h(
        'button',
        {
          class: 'btn small',
          onclick: async () => {
            await saveSession({ end_time: nowHM() });
            endInput.value = nowHM();
            detailsEl.open = true;
            toast('บันทึกเวลาจบแล้ว ให้คะแนนความเหนื่อยได้ที่รายละเอียด');
          },
        },
        'จบ'
      )
    ),
    detailsEl,
    blocks,
    h(
      'div',
      { class: 'row gap' },
      h('button', { class: 'btn primary grow', onclick: () => openExercisePicker({ session, ids, histories, exercises, onDone: refresh }) }, icon('plus', 18), ' เพิ่มท่า')
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'คาร์ดิโอ'), h('button', { class: 'btn small', onclick: () => openCardioForm({ session, weight: weightNow, onDone: refresh }) }, '+ เพิ่ม')),
      myCardio.length
        ? h(
            'ul',
            { class: 'list' },
            myCardio.map((c) =>
              h(
                'li',
                { class: 'row' },
                h('div', { class: 'grow pad-s' }, h('strong', null, c.type), h('small', { class: 'muted block' }, cardioText(c))),
                h(
                  'button',
                  {
                    class: 'icon-btn',
                    'aria-label': 'ลบคาร์ดิโอ',
                    onclick: async () => {
                      await db.remove('cardio', c.id);
                      refresh();
                    },
                  },
                  icon('trash', 20)
                )
              )
            )
          )
        : h('p', { class: 'muted' }, 'ยังไม่ได้จดคาร์ดิโอ')
    ),
    h('p', { class: 'muted center small-text' }, `รวม ${totalSets} เซ็ตทำงาน (ไม่นับวอร์มอัพ)`),
    h(
      'button',
      {
        class: 'btn danger-outline',
        onclick: async () => {
          if (await confirmSheet('ลบครั้งที่ฝึกนี้พร้อมเซ็ตและคาร์ดิโอทั้งหมด?', { okText: 'ลบ', danger: true })) {
            await flushPending();
            await db.deleteSession(id);
            location.hash = '#/train';
          }
        },
      },
      'ลบครั้งที่ฝึกนี้'
    )
  );
}

function cardioText(c) {
  const parts = [];
  if (c.minutes) parts.push(`${fmtNum(c.minutes, 0)} นาที`);
  if (c.incline_pct != null) parts.push(`ชัน ${fmtNum(c.incline_pct)}%`);
  if (c.speed_kmh != null) parts.push(`${fmtNum(c.speed_kmh)} กม./ชม.`);
  if (c.distance_km != null) parts.push(`${fmtNum(c.distance_km, 2)} กม.`);
  if (c.kcal_est != null) parts.push(`≈${fmtNum(c.kcal_est, 0)} kcal`);
  if (c.note) parts.push(c.note);
  return parts.join(' · ') || 'ไม่ได้ระบุรายละเอียด';
}

// ---------- บล็อกของหนึ่งท่า ----------

function exerciseBlock({ ex, session, sets, history, refresh, removeFromSession }) {
  const before = history.filter((h0) => h0.sessionId !== session.id && h0.date <= session.date);
  const prev = previousEntry(history, session.id, session.date);
  const suggestion = overloadSuggestion(ex, before);
  const stall = detectStall(before);
  let nextOrder = sets.length ? Math.max(...sets.map((s) => s.order ?? 0)) + 1 : 0;

  const newSet = async (vals) => {
    await flushPending();
    await db.create('sets', { session_id: session.id, exercise_id: ex.id, order: nextOrder++, weight_kg: vals.weight ?? null, reps: vals.reps ?? null, rir: vals.rir ?? null, is_warmup: false, note: '' });
  };
  const ensureInSession = async () => {
    const ids = session.exercise_ids || [];
    if (!ids.includes(ex.id)) await db.update('sessions', session.id, { exercise_ids: [...ids, ex.id] });
  };

  const copyPrev = async () => {
    if (!prev) return toast('ยังไม่มีข้อมูลครั้งก่อนของท่านี้');
    const have = sets.filter((s) => !s.is_warmup).length;
    let add = prev.sets.slice(have);
    if (!add.length) add = [prev.sets[prev.sets.length - 1]];
    for (const s of add) await newSet({ weight: s.weight || null, reps: s.reps, rir: s.rir });
    await ensureInSession();
    refresh();
  };
  const addSet = async () => {
    const last = [...sets].reverse().find((s) => !s.is_warmup) || null;
    const src = last ? { weight: last.weight_kg, reps: last.reps, rir: last.rir } : prev ? { weight: prev.sets[0].weight || null, reps: prev.sets[0].reps, rir: null } : {};
    await newSet(src);
    await ensureInSession();
    refresh();
  };

  const metaBits = [ex.equipment, ex.rep_min ? `เป้า ${ex.rep_min}${ex.rep_max && ex.rep_max !== ex.rep_min ? `–${ex.rep_max}` : ''} ${ex.timed ? 'วินาที' : 'ครั้ง'}` : null, ex.per_side ? 'ทีละข้าง' : null].filter(Boolean);

  let workNo = 0;
  const rows = sets.map((s) => {
    const label = s.is_warmup ? 'W' : String(++workNo);
    return setRow({ s, label, ex, refresh });
  });

  return h(
    'section',
    { class: `card ex-block ${ex.deleted ? 'faded' : ''}`, 'data-ex': ex.id },
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'grow' }, h('h2', null, exTitle(ex)), h('small', { class: 'muted' }, (ex.deleted ? ['ลบจากคลังท่าแล้ว (ประวัติยังอยู่)'] : []).concat(metaBits).join(' · '))),
      h('button', { class: 'icon-btn', 'aria-label': `เอา ${ex.name} ออกจากครั้งนี้`, onclick: removeFromSession }, icon('trash', 20))
    ),
    prev ? h('p', { class: 'hint' }, `ครั้งก่อน (${fmtShort(prev.date)}): `, prev.sets.map((s) => fmtSet(s, ex)).join(' · ')) : h('p', { class: 'hint muted' }, 'ยังไม่เคยจดท่านี้'),
    suggestion ? h('p', { class: 'hint good-text' }, `ครั้งก่อนทำครบ ${suggestion.repMax} ทุกเซ็ต — ครั้งนี้ลองเพิ่มเป็น ${suggestion.low}–${suggestion.high} กก.`) : null,
    stall.stalled ? h('p', { class: 'hint warn-text' }, `ตัวเลขไม่ขึ้นมา ${stall.sessions} ครั้งติดแล้ว (ตั้งแต่ ${fmtShort(stall.since)})`) : null,
    sets.length ? h('div', { class: 'set-head' }, h('span', null, 'เซ็ต'), h('span', null, ex.timed ? '' : 'น้ำหนัก (กก.)'), h('span', null), h('span', null, ex.timed ? 'วินาที' : 'ครั้ง'), h('span', null, 'RIR'), h('span', null), h('span', null)) : null,
    h('div', { class: 'sets' }, rows),
    h(
      'div',
      { class: 'row gap mt' },
      h('button', { class: 'btn grow', onclick: copyPrev, disabled: !prev, 'data-act': 'copy-prev' }, 'เหมือนครั้งก่อน'),
      h('button', { class: 'btn grow', onclick: addSet, 'data-act': 'add-set' }, '+ เซ็ต')
    )
  );
}

function setRow({ s, label, ex, refresh }) {
  const cur = { weight_kg: s.weight_kg, reps: s.reps, rir: s.rir };
  const w = numInput({ value: s.weight_kg, placeholder: ex.timed ? '' : 'กก.', 'aria-label': 'น้ำหนัก (กก.)', 'data-f': 'w' });
  const r = numInput({ value: s.reps, placeholder: ex.timed ? 'วิ' : 'ครั้ง', inputmode: 'numeric', 'aria-label': ex.timed ? 'วินาที' : 'จำนวนครั้ง', 'data-f': 'r' });
  const rir = numInput({ value: s.rir, placeholder: '–', inputmode: 'numeric', 'aria-label': 'RIR เหลือแรงอีกกี่ครั้ง', 'data-f': 'rir' });
  if (ex.timed) w.style.visibility = 'hidden';

  let dirty = false;
  let timer = null;
  const save = async () => {
    clearTimeout(timer);
    untrackPending(flush);
    if (!dirty) return;
    dirty = false;
    cur.weight_kg = readNum(w);
    cur.reps = readNum(r);
    cur.rir = readNum(rir);
    await db.update('sets', s.id, { ...cur });
  };
  const flush = () => save();
  const onInput = () => {
    dirty = true;
    trackPending(flush);
    clearTimeout(timer);
    timer = setTimeout(save, 600);
  };
  for (const inp of [w, r, rir]) {
    inp.addEventListener('input', onInput);
    inp.addEventListener('change', save);
    inp.addEventListener('focus', () => inp.select && inp.select());
  }

  return h(
    'div',
    { class: `set-row ${s.is_warmup ? 'warm' : ''}`, 'data-set': s.id },
    h('span', { class: 'set-no' }, label),
    w,
    h('span', { class: 'times' }, '×'),
    r,
    rir,
    h(
      'button',
      {
        class: `chip tiny ${s.is_warmup ? 'on' : ''}`,
        'aria-pressed': String(!!s.is_warmup),
        'aria-label': 'เซ็ตวอร์มอัพ',
        title: 'เซ็ตวอร์มอัพ',
        onclick: async () => {
          await flushPending();
          await db.update('sets', s.id, { is_warmup: !s.is_warmup });
          refresh();
        },
      },
      h('span', { class: 'w-long' }, 'วอร์ม'),
      h('span', { class: 'w-short' }, 'W')
    ),
    h(
      'button',
      {
        class: 'icon-btn',
        'aria-label': 'ลบเซ็ต',
        onclick: async () => {
          await flushPending();
          await db.remove('sets', s.id);
          toast('ลบเซ็ตแล้ว', {
            action: {
              label: 'ย้อน',
              fn: async () => {
                await db.update('sets', s.id, { deleted: false });
                refresh();
              },
            },
          });
          refresh();
        },
      },
      icon('x', 20)
    )
  );
}

// ---------- เลือกท่าเข้าครั้งนี้ ----------

function openExercisePicker({ session, ids, histories, exercises, onDone }) {
  const sheet = openSheet({ title: 'เพิ่มท่า', content: h('div') });
  let list = exercises;

  const addToSession = async (ex) => {
    await db.update('sessions', session.id, { exercise_ids: [...new Set([...(await db.get('sessions', session.id)).exercise_ids || ids, ex.id])] });
    sheet.close();
    onDone();
  };

  function show() {
    const search = textInput({ placeholder: 'ค้นหาท่า', type: 'search', 'aria-label': 'ค้นหาท่า' });
    const box = h('div', { class: 'stack' });
    const row = (ex) =>
      h(
        'li',
        null,
        h('button', { class: 'list-row', onclick: () => addToSession(ex) }, h('span', { class: 'grow' }, h('strong', null, exTitle(ex)), h('small', { class: 'muted block' }, `${ex.muscle} · ${ex.equipment}`)), ids.includes(ex.id) ? h('span', { class: 'tag' }, 'อยู่ในครั้งนี้') : null)
      );
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      clear(box);
      if (q) {
        const rows = list.filter((e) => `${e.name} ${e.machine} ${e.muscle}`.toLowerCase().includes(q)).sort(byName);
        box.append(rows.length ? h('ul', { class: 'list' }, rows.map(row)) : h('p', { class: 'muted pad' }, 'ไม่พบท่า — กด "สร้างท่าใหม่"'));
        return;
      }
      const recent = [...histories.entries()]
        .filter(([id]) => !ids.includes(id))
        .map(([id, hist]) => ({ id, last: hist[hist.length - 1].date }))
        .sort((a, b) => (a.last < b.last ? 1 : -1))
        .slice(0, 6)
        .map((x) => list.find((e) => e.id === x.id))
        .filter(Boolean);
      if (recent.length) box.append(h('h3', null, 'เล่นล่าสุด'), h('ul', { class: 'list' }, recent.map(row)));
      for (const m of MUSCLES) {
        const rows = list.filter((e) => e.muscle === m).sort(byName);
        if (rows.length) box.append(h('h3', null, m), h('ul', { class: 'list' }, rows.map(row)));
      }
    };
    search.addEventListener('input', paint);
    paint();
    sheet.setContent(h('div', { class: 'stack' }, h('button', { class: 'btn', onclick: showForm }, icon('plus', 18), ' สร้างท่าใหม่'), search, box), 'เพิ่มท่า');
  }
  function showForm() {
    sheet.setContent(
      exerciseForm({
        onSaved: (ex) => {
          list = [...list, ex];
          addToSession(ex);
        },
        onCancel: show,
      }),
      'สร้างท่าใหม่'
    );
  }
  show();
}

/** ฟอร์มสร้าง/แก้ไขท่า */
export function exerciseForm({ exercise, onSaved, onCancel, onDelete }) {
  const e0 = exercise || {};
  const sel = (opts, val) => h('select', { class: 'input', value: val }, opts.map((o) => h('option', { value: o }, o)));
  const name = textInput({ value: e0.name || '', placeholder: 'เช่น Cable row' });
  const muscle = sel(MUSCLES, e0.muscle || MUSCLES[0]);
  const category = sel(CATEGORIES, e0.category || CATEGORIES[0]);
  const equipment = sel(EQUIPMENT, e0.equipment || EQUIPMENT[0]);
  const machine = textInput({ value: e0.machine || '', placeholder: 'เช่น เครื่อง Low row ชั้น 2 (แยกท่าเมื่อเครื่องต่างกัน)' });
  const repMin = numInput({ value: e0.rep_min ?? '', placeholder: '8', inputmode: 'numeric' });
  const repMax = numInput({ value: e0.rep_max ?? '', placeholder: '12', inputmode: 'numeric' });
  const perSide = h('input', { type: 'checkbox', checked: !!e0.per_side });
  const timed = h('input', { type: 'checkbox', checked: !!e0.timed });
  const note = textInput({ value: e0.note || '', placeholder: 'หมายเหตุ (ไม่บังคับ)' });
  const err = h('p', { class: 'bad-text', role: 'alert' });
  return h(
    'form',
    {
      class: 'stack',
      onsubmit: async (ev) => {
        ev.preventDefault();
        if (!name.value.trim()) return void (err.textContent = 'ใส่ชื่อท่าก่อน');
        const fields = {
          name: name.value.trim(),
          muscle: muscle.value,
          category: category.value,
          equipment: equipment.value,
          machine: machine.value.trim(),
          rep_min: readNum(repMin),
          rep_max: readNum(repMax),
          per_side: perSide.checked,
          timed: timed.checked,
          note: note.value.trim(),
        };
        onSaved(exercise ? await db.update('exercises', exercise.id, fields) : await db.create('exercises', fields));
      },
    },
    field('ชื่อท่า', name),
    h('div', { class: 'grid2' }, field('กลุ่มกล้าม', muscle), field('ประเภท', category)),
    field('อุปกรณ์', equipment),
    field('เครื่อง/รุ่น (ถ้ามี)', machine, 'ท่าเดียวกันแต่คนละเครื่อง น้ำหนักต่างกันมาก ให้สร้างเป็นคนละท่า'),
    h('div', { class: 'grid2' }, field('ช่วงครั้งเป้า (ต่ำ)', repMin), field('ช่วงครั้งเป้า (สูง)', repMax)),
    h('label', { class: 'check' }, perSide, h('span', null, 'จดทีละข้าง')),
    h('label', { class: 'check' }, timed, h('span', null, 'วัดเป็นเวลา (วินาที) เช่น Plank')),
    field('หมายเหตุ', note),
    err,
    h(
      'div',
      { class: 'row gap' },
      onCancel ? h('button', { type: 'button', class: 'btn ghost', onclick: onCancel }, 'ยกเลิก') : null,
      onDelete ? h('button', { type: 'button', class: 'btn danger-outline', onclick: onDelete }, 'ลบ') : null,
      h('button', { type: 'submit', class: 'btn primary grow' }, 'บันทึก')
    )
  );
}

// ---------- คาร์ดิโอ ----------

function openCardioForm({ session, weight, onDone }) {
  const type = chipGroup({ options: CARDIO_TYPES, value: 'เดินชัน', onChange: () => syncVisibility() });
  const minutes = numInput({ placeholder: '25', inputmode: 'numeric' });
  const incline = numInput({ placeholder: '10' });
  const speed = numInput({ placeholder: '5' });
  const distance = numInput({ placeholder: 'ไม่บังคับ' });
  const kcal = numInput({ placeholder: 'ประมาณ', inputmode: 'numeric' });
  const note = textInput({ placeholder: 'หมายเหตุ (ไม่บังคับ)' });
  const inclineField = field('ความชัน (%)', incline);
  const hint = h('p', { class: 'muted small-text' });
  const syncVisibility = () => {
    inclineField.style.display = type.get() === 'เดินชัน' || type.get() === 'วิ่ง' ? '' : 'none';
  };
  syncVisibility();
  const estimate = () => {
    const k = estimateCardioKcal({ type: type.get(), minutes: readNum(minutes), speed_kmh: readNum(speed), incline_pct: readNum(incline), weight_kg: weight });
    if (k == null) {
      hint.textContent = weight ? 'ประมาณให้ได้เฉพาะเดินชัน/วิ่ง และต้องใส่เวลากับความเร็ว' : 'ยังไม่มีน้ำหนักตัว บันทึกน้ำหนักก่อนจึงจะประมาณได้';
      return;
    }
    kcal.value = String(k);
    hint.textContent = `ประมาณจากสมการ ACSM ที่น้ำหนัก ${fmtNum(weight)} กก. (ค่าจริงต่างกันได้มาก แก้เองได้)`;
  };
  const sheet = openSheet({
    title: 'เพิ่มคาร์ดิโอ',
    content: h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          await db.create('cardio', {
            session_id: session.id,
            date: session.date,
            type: type.get(),
            minutes: readNum(minutes),
            incline_pct: type.get() === 'เดินชัน' || type.get() === 'วิ่ง' ? readNum(incline) : null,
            speed_kmh: readNum(speed),
            distance_km: readNum(distance),
            kcal_est: readNum(kcal),
            note: note.value.trim(),
          });
          sheet.close();
          onDone();
        },
      },
      field('ประเภท', type.el),
      h('div', { class: 'grid2' }, field('เวลา (นาที)', minutes), inclineField, field('ความเร็ว (กม./ชม.)', speed), field('ระยะทาง (กม.)', distance)),
      h('div', { class: 'row gap end' }, h('div', { class: 'grow' }, field('พลังงาน kcal (ประมาณ)', kcal)), h('button', { type: 'button', class: 'btn', onclick: estimate }, 'ประมาณให้')),
      hint,
      field('หมายเหตุ', note),
      h('button', { type: 'submit', class: 'btn primary' }, 'บันทึก')
    ),
  });
}

// ---------- คลังท่า ----------

async function renderExercises(root) {
  const exercises = await db.list('exercises');
  const refresh = () => renderExercises(root);
  function openEdit(ex) {
    const sheet = openSheet({
      title: ex ? 'แก้ไขท่า' : 'เพิ่มท่าใหม่',
      content: exerciseForm({
        exercise: ex,
        onSaved: () => {
          sheet.close();
          refresh();
        },
        onCancel: () => sheet.close(),
        onDelete: ex
          ? async () => {
              if (await confirmSheet(`ลบท่า "${ex.name}" ออกจากคลัง? (ประวัติที่จดไปแล้วยังอยู่)`, { okText: 'ลบ', danger: true })) {
                await db.remove('exercises', ex.id);
                sheet.close();
                refresh();
              }
            }
          : undefined,
      }),
    });
  }
  mount(
    root,
    h('header', { class: 'page-head' }, h('a', { class: 'btn small ghost', href: '#/train' }, '‹ กลับ'), h('h1', null, 'คลังท่า'), h('button', { class: 'btn small primary', onclick: () => openEdit(null) }, '+ เพิ่ม')),
    h('p', { class: 'muted small-text' }, `${exercises.length} ท่า · แตะเพื่อแก้ไข ท่าเดียวกันแต่คนละเครื่อง (น้ำหนักต่างกันมาก) แนะนำให้แยกเป็นคนละท่า เพื่อให้กราฟเทียบกันได้จริง`),
    MUSCLES.map((m) => {
      const rows = exercises.filter((e) => e.muscle === m).sort(byName);
      if (!rows.length) return null;
      return h(
        'section',
        { class: 'card flush' },
        h('h2', { class: 'pad-h' }, m),
        h('ul', { class: 'list' }, rows.map((e) => h('li', null, h('button', { class: 'list-row', onclick: () => openEdit(e) }, h('span', { class: 'grow' }, h('strong', null, e.name), h('small', { class: 'muted block' }, [e.equipment, e.machine, e.category].filter(Boolean).join(' · '))), e.rep_min ? h('span', { class: 'muted' }, `${e.rep_min}${e.rep_max && e.rep_max !== e.rep_min ? `–${e.rep_max}` : ''}`) : null))))
      );
    })
  );
}
