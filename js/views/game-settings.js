// การ์ด "เกม coin และ streak" ในแท็บตั้งค่า: แก้ตัวเลขทุกตัวของเกมได้ (เก็บใน game_settings เรคคอร์ดเดียว ซิงก์/ส่งออกได้)

import * as db from '../db.js';
import { DEFAULT_GAME_SETTINGS } from '../constants.js';
import { computeGame, normalizeSettings } from '../game.js';
import { DAYS_SHORT, toDateStr } from '../dates.js';
import { confirmSheet, field, h, numInput, readNum, toast } from '../ui.js';

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // จันทร์ → อาทิตย์

/** ctx = { settings, refresh, data (db.loadAll), profile } — data/profile ใช้โชว์ตัวอย่างยอด coin ก่อนกดบันทึก */
export function gameSettingsCard({ settings, refresh, data, profile }) {
  const s = normalizeSettings(settings);
  const balanceWith = (cfg) =>
    computeGame({ asOf: toDateStr(), profile, settings: cfg, foodLogs: data.food_logs, bodyLogs: data.body_logs, sessions: data.sessions, sets: data.sets, cardio: data.cardio, exercises: data.exercises, redemptions: data.redemptions }).balance;
  const savedBalance = balanceWith(s);
  const preview = h('p', { class: 'callout', id: 'gs-preview', 'aria-live': 'polite' }, `ยอด coin ตอนนี้ ${savedBalance} (ยังไม่ได้เปลี่ยนค่า)`);
  let previewTimer = null;
  const updatePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const next = balanceWith(normalizeSettings(readPatch()));
      preview.textContent = next === savedBalance ? `ยอด coin ไม่เปลี่ยน (${savedBalance})` : `ยอด coin จะเปลี่ยนจาก ${savedBalance} เป็น ${next}${next < 0 ? ' (ยอดติดลบจะแลกรางวัลไม่ได้จนกว่าจะเก็บเพิ่ม)' : ''} — ถ้าตกลงค่อยกดบันทึก`;
      preview.classList.toggle('warn', next !== savedBalance);
    }, 150);
  };
  const inputs = {};
  const num = (key, label, hint, { decimal = false } = {}) => {
    inputs[key] = numInput({ value: s[key], inputmode: decimal ? 'decimal' : 'numeric', 'aria-label': label, id: `gs-${key}` });
    return field(label, inputs[key], hint);
  };

  // วันฝึกตามแผน (เลือกได้หลายวัน)
  const training = new Set(s.training_days);
  const dayButtons = WEEK_ORDER.map((d) => {
    const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(training.has(d)), 'data-day': d, onclick: () => toggle(d) }, DAYS_SHORT[d].replace('.', ''));
    return b;
  });
  const paintDays = () =>
    dayButtons.forEach((b) => {
      const on = training.has(Number(b.dataset.day));
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  function toggle(d) {
    if (training.has(d)) training.delete(d);
    else training.add(d);
    paintDays();
    updatePreview();
  }
  paintDays();
  const startDate = h('input', { type: 'date', class: 'input', id: 'gs-start_date', value: s.start_date || '', 'aria-label': 'coin เริ่มนับตั้งแต่วันที่' });
  const readPatch = () => {
    const patch = { training_days: [...training].sort(), start_date: startDate.value || null };
    for (const [k, el] of Object.entries(inputs)) patch[k] = readNum(el);
    return patch;
  };

  const group = (title, ...children) => h('details', { class: 'details' }, h('summary', null, title), h('div', { class: 'stack' }, ...children));

  const form = h(
    'form',
    {
      class: 'stack',
      id: 'game-settings-form',
      oninput: updatePreview,
      onsubmit: async (e) => {
        e.preventDefault();
        await db.saveGameSettings(normalizeSettings(readPatch()));
        toast('บันทึกการตั้งค่าเกมแล้ว');
        refresh();
      },
    },
    preview,
    h('p', { class: 'muted small-text' }, 'เปลี่ยนค่าแล้ว coin ในอดีตจะถูกคำนวณใหม่ทั้งหมดด้วยค่าใหม่ (เพราะ coin คำนวณจากข้อมูลที่จด ไม่ได้เก็บเป็นรายการ) เป้าแคลอรี่ โปรตีนขั้นต่ำ และเป้าก้าว ใช้ค่าจากโปรไฟล์ด้านบน'),
    group(
      'coin ที่ได้',
      h('div', { class: 'grid2' }, num('coin_workout', 'ฝึกครบ 1 ครั้ง'), num('workout_min_exercises', 'ฝึกครบ = กี่ท่าขึ้นไป'), num('workout_min_sets', '...หรือกี่เซ็ตทำงาน'), num('coin_cardio', 'คาร์ดิโอถึงเป้า'), num('cardio_min_minutes', 'คาร์ดิโอกี่นาทีขึ้นไป'), num('coin_pr', 'ทำ PR (ต่อท่า)'), num('pr_cap_per_day', 'PR สูงสุดต่อวัน'), num('coin_kcal', 'แคลอรี่อยู่ในช่วง'), num('coin_protein', 'โปรตีนถึงขั้นต่ำ'), num('coin_steps', 'ก้าวถึงเป้า'), num('coin_weigh', 'ชั่งน้ำหนัก'), num('coin_week_bonus', 'โบนัสฝึกครบรายสัปดาห์'), num('week_target', 'ฝึกกี่ครั้ง/สัปดาห์ (โบนัสและไฟรายสัปดาห์)'))
    ),
    group(
      'ช่วงแคลอรี่ที่ถือว่าตามแผน',
      h('p', { class: 'muted small-text' }, `ค่าเริ่มต้น = เป้า ± "ยอมรับได้" ในโปรไฟล์ (ตอนนี้ ± ${profile.kcal_tolerance ?? 100} kcal) ช่องข้างล่างปล่อยว่างไว้ถ้าจะใช้ค่านั้น ใส่ตัวเลขถ้าอยากให้เกมใช้ช่วงอื่น`),
      h('div', { class: 'grid2' }, num('kcal_below', 'ต่ำกว่าเป้าได้ (kcal) — ว่าง = ตามโปรไฟล์'), num('kcal_above', 'สูงกว่าเป้าได้ (kcal) — ว่าง = ตามโปรไฟล์')),
      num('kcal_min_meals', 'ต้องจดอย่างน้อยกี่มื้อ (มื้อที่ต่างกัน)')
    ),
    group(
      'ไฟ 🔥 และวันพัก',
      field('วันฝึกตามแผน', h('div', { class: 'chips' }, dayButtons), 'วันที่ไม่ได้ฝึกนับเป็นวันพัก (ใช้บอกในหน้าวันนี้)'),
      h('div', { class: 'grid2' }, num('max_rest_days', 'วันพักได้ไม่เกินกี่วัน/สัปดาห์', 'จันทร์–อาทิตย์ เกินแล้วนับว่าพลาด'), num('allowed_per_week', 'วัน "ได้รับอนุญาต" กี่วัน/สัปดาห์', 'วันที่แลกของกิน ไฟไม่ดับ')),
      h('div', { class: 'grid2' }, num('tier1_days', 'ตัวคูณขั้น 1: ไฟกี่วัน'), num('tier1_mult', 'ตัวคูณขั้น 1', null, { decimal: true }), num('tier2_days', 'ตัวคูณขั้น 2: ไฟกี่วัน'), num('tier2_mult', 'ตัวคูณขั้น 2', null, { decimal: true }), num('tier3_days', 'ตัวคูณขั้น 3: ไฟกี่วัน'), num('tier3_mult', 'ตัวคูณขั้น 3', null, { decimal: true })),
      h('p', { class: 'muted small-text' }, 'แอนิเมชันฉลองขึ้นตอนไฟถึงสามขั้นนี้')
    ),
    group(
      'ร้านและอื่นๆ',
      field('coin เริ่มนับตั้งแต่วันที่', startDate, 'วันที่ก่อนหน้านี้ไม่ได้ coin (ไฟยังนับจากประวัติทั้งหมด) · ตั้งเป็นวันที่เริ่มใช้เกมให้อัตโนมัติ · ล้างช่องนี้ = นับทุกวัน'),
      h('div', { class: 'grid2' }, num('freeze_price', 'ราคาไฟสำรอง 🧊 (coin)'), num('backdate_days', 'แก้ย้อนหลังเกินกี่วันไม่ได้ coin'), num('big_meal_kcal', 'แลกของกินตั้งแต่กี่ kcal ให้ขึ้นคำแนะนำ'))
    ),
    h('button', { type: 'submit', class: 'btn primary' }, 'บันทึกการตั้งค่าเกม'),
    h(
      'button',
      {
        type: 'button',
        class: 'btn ghost',
        id: 'game-settings-reset',
        onclick: async () => {
          if (!(await confirmSheet('คืนค่าเกมทั้งหมดเป็นค่าเริ่มต้น? (รางวัลและประวัติการแลกไม่ถูกแตะ)', { okText: 'คืนค่าเริ่มต้น', title: 'คืนค่าเริ่มต้น' }))) return;
          await db.saveGameSettings({ ...DEFAULT_GAME_SETTINGS });
          toast('คืนค่าเริ่มต้นแล้ว');
          refresh();
        },
      },
      'คืนค่าเริ่มต้น'
    )
  );
  return h('section', { class: 'card', id: 'game-settings-card' }, h('h2', null, '🎮 เกม coin และ streak'), form);
}
