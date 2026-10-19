// จดการกินแบบกะเอา: หน้าจอ (ปุ่มกะ 6 ปุ่ม, แผ่นจด, เติมแคลที่ยังไม่มี, รายการมื้อที่ยังไม่มีแคล, การ์ดตั้งค่าปุ่ม)
// ตรรกะ/ตัวเลขอยู่ใน ../food-quick.js (ฟังก์ชันล้วน ทดสอบด้วย node --test) · ไฟล์นี้แตะ DOM และ db เท่านั้น

import * as db from '../db.js';
import { MEALS } from '../constants.js';
import { addDays, fmtShort, toDateStr } from '../dates.js';
import { FOOD_PRESETS, PRESET_FIELDS, SIZE_OPTIONS, fillFromPreset, missingKcalLogs, presetAmounts, presetLogFields, sizeLabel, validatePresetValues } from '../food-quick.js';
import { guessMeal } from '../state.js';
import { busyClick, chipGroup, confirmSheet, field, fmtInt, fmtNum, h, numInput, openSheet, readNum, textInput, toast } from '../ui.js';

const sizeOptions = (opts = SIZE_OPTIONS) => opts.map((v) => ({ value: v, label: sizeLabel(v) }));
const amountText = (a) => `${fmtInt(a.kcal)} kcal · โปรตีน ${fmtNum(a.protein)} · คาร์บ ${fmtNum(a.carb)} · ไขมัน ${fmtNum(a.fat)}`;

// ---------- ปุ่มกะ 6 ปุ่ม (บนสุดของหน้ากิน) ----------

export function presetGrid({ presets, onPick }) {
  return h(
    'div',
    { class: 'preset-grid' },
    presets.map((p) =>
      h(
        'button',
        { class: 'preset', type: 'button', 'data-preset': p.key, onclick: () => onPick(p) },
        h('span', { class: 'preset-emoji', 'aria-hidden': 'true' }, p.emoji),
        h('strong', { class: 'preset-name' }, p.label),
        h('small', { class: 'muted' }, `${fmtInt(p.kcal)} kcal`)
      )
    )
  );
}

// ---------- แผ่นจดจากปุ่มกะ: ขนาด + ชื่อ (ไม่บังคับ) + มื้อ + บันทึก ----------

export function openPresetSheet({ preset, date, onDone }) {
  const size = chipGroup({ options: sizeOptions(), value: 1, onChange: () => paint() });
  const name = textInput({ placeholder: `ชื่อสั้นๆ (ไม่บังคับ) เช่น ${preset.examples.split(' ')[0]}`, 'aria-label': 'ชื่อ', id: 'preset-name' });
  const meal = chipGroup({ options: MEALS, value: guessMeal() }); // เดามื้อจากเวลาตอนนี้ เปลี่ยนได้
  const out = h('div', { class: 'preview', id: 'preset-preview', 'aria-live': 'polite' });
  const paint = () => {
    out.textContent = `≈ ${amountText(presetAmounts(preset, size.get()))}`;
  };
  paint();
  const sheet = openSheet({
    title: `${preset.emoji} ${preset.label}`,
    content: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted small-text' }, `ตัวอย่าง: ${preset.examples} · ค่าประมาณ แก้ได้ในตั้งค่า`),
      field('ขนาด', size.el),
      out,
      field('ชื่อ', name),
      field('มื้อ', meal.el),
      h(
        'button',
        {
          class: 'btn primary big',
          id: 'preset-save',
          onclick: busyClick(async () => {
            const e = await db.create('food_logs', presetLogFields({ preset, size: size.get(), name: name.value, date, meal: meal.get() }));
            sheet.close();
            toast(`จด ${e.name} ≈ ${fmtInt(e.kcal)} kcal แล้ว`, {
              action: {
                label: 'ย้อน',
                fn: async () => {
                  await db.remove('food_logs', e.id);
                  onDone();
                },
              },
            });
            onDone();
          }),
        },
        'บันทึก'
      )
    ),
  });
}

// ---------- เติมแคลให้มื้อที่ยังไม่มีแคล: เลือกปุ่มกะ (× ขนาด) หรือพิมพ์เอง ----------

export async function openFillKcal(entry, { onDone }) {
  const presets = await db.getFoodPresets();
  const size = chipGroup({ options: sizeOptions(), value: 1 });
  const kcal = numInput({ placeholder: 'เช่น 450', inputmode: 'numeric', 'aria-label': 'แคลอรี่ (kcal)', id: 'fill-kcal' });
  const protein = numInput({ placeholder: 'เช่น 25', 'aria-label': 'โปรตีน (ก.)' });
  const err = h('p', { class: 'bad-text', role: 'alert' });
  const before = { kcal: entry.kcal ?? null, protein: entry.protein ?? 0, carb: entry.carb ?? 0, fat: entry.fat ?? 0, qty: entry.qty ?? 1, quick: !!entry.quick, is_estimate: !!entry.is_estimate, estimate_preset: entry.estimate_preset ?? null, kcal_missing: true };
  const sheet = openSheet({ title: 'เติมแคล', content: h('p', { class: 'muted' }, 'กำลังโหลด…') });

  let applying = false;
  const apply = async (patch, label) => {
    if (applying) return; // กันกดซ้ำระหว่างรอเขียนข้อมูล
    applying = true;
    await db.update('food_logs', entry.id, patch);
    sheet.close();
    toast(`เติมแคลแล้ว ${label}`, {
      action: {
        label: 'ย้อน',
        fn: async () => {
          await db.update('food_logs', entry.id, before);
          onDone();
        },
      },
    });
    onDone();
  };

  sheet.setContent(
    h(
      'div',
      { class: 'stack' },
      h('div', null, h('strong', null, entry.name), h('div', { class: 'muted' }, `${fmtShort(entry.date)} · มื้อ${entry.meal || ''}`)),
      field('เลือกปุ่มกะ แล้วเติมให้ทันที', size.el),
      h(
        'div',
        { class: 'preset-grid compact' },
        presets.map((p) =>
          h(
            'button',
            { class: 'preset', type: 'button', 'data-fill': p.key, onclick: () => apply(fillFromPreset(p, size.get()), `≈ ${fmtInt(presetAmounts(p, size.get()).kcal)} kcal`) },
            h('span', { class: 'preset-emoji', 'aria-hidden': 'true' }, p.emoji),
            h('strong', { class: 'preset-name' }, p.label),
            h('small', { class: 'muted' }, `${fmtInt(p.kcal)} kcal`)
          )
        )
      ),
      h('h3', null, 'หรือพิมพ์เอง'),
      h('div', { class: 'grid2' }, field('แคลอรี่ (kcal)', kcal), field('โปรตีน (ก.)', protein)),
      err,
      h(
        'div',
        { class: 'row gap' },
        h(
          'button',
          {
            class: 'btn danger-outline',
            onclick: async () => {
              await db.remove('food_logs', entry.id);
              sheet.close();
              toast('ลบแล้ว', {
                action: {
                  label: 'ย้อน',
                  fn: async () => {
                    await db.update('food_logs', entry.id, { deleted: false });
                    onDone();
                  },
                },
              });
              onDone();
            },
          },
          'ลบรายการนี้'
        ),
        h(
          'button',
          {
            class: 'btn primary grow',
            id: 'fill-save',
            onclick: () => {
              const k = readNum(kcal);
              if (k === null || k < 0) return void (err.textContent = 'ใส่แคลอรี่ (ตัวเลข ≥ 0) หรือเลือกปุ่มกะด้านบน');
              apply({ kcal: k, protein: readNum(protein) ?? 0, kcal_missing: false }, `${fmtInt(k)} kcal`);
            },
          },
          'บันทึกแคล'
        )
      )
    )
  );
}

// ---------- รายการมื้อที่ยังไม่มีแคล (แตะจากแถบเตือนหน้าวันนี้) ----------

/** มื้อที่ยังไม่มีแคลในช่วง 7 วันล่าสุด (รวมวันนี้) */
export async function loadRecentMissing(today = toDateStr()) {
  return missingKcalLogs(await db.listDateRange('food_logs', addDays(today, -6), today));
}

export async function openMissingList({ onDone, today = toDateStr() }) {
  const first = await loadRecentMissing(today);
  if (first.length === 1) return openFillKcal(first[0], { onDone });
  let dirty = false;
  const sheet = openSheet({
    title: 'เติมแคล',
    content: h('p', { class: 'muted' }, 'กำลังโหลด…'),
    onClose: () => {
      if (dirty) onDone();
    },
  });
  const show = async () => {
    const rows = await loadRecentMissing(today);
    if (!rows.length) {
      sheet.close();
      return;
    }
    sheet.setContent(
      h(
        'div',
        { class: 'stack' },
        h('p', { class: 'muted small-text' }, `มี ${rows.length} มื้อที่ยังไม่มีแคล (7 วันล่าสุด) — แตะเพื่อเติม วันที่ยังมีมื้อไม่มีแคลจะยังไม่ได้ coin แคลอรี่`),
        h(
          'ul',
          { class: 'list' },
          rows.map((l) =>
            h(
              'li',
              null,
              h(
                'button',
                {
                  class: 'list-row',
                  'data-missing': l.id,
                  onclick: async () => {
                    dirty = true;
                    // ย้อนจาก toast หลังแผ่นนี้ปิดไปแล้วก็ต้องวาดหน้าหลักใหม่ด้วย
                    await openFillKcal(l, {
                      onDone: async () => {
                        await show();
                        onDone();
                      },
                    });
                  },
                },
                h('span', { class: 'grow' }, h('strong', null, l.name), h('small', { class: 'muted block' }, `${fmtShort(l.date)} · มื้อ${l.meal || ''}`)),
                h('span', { class: 'tag warn' }, 'ยังไม่มีแคล')
              )
            )
          )
        )
      ),
      'เติมแคล'
    );
  };
  await show();
}

// ---------- ตั้งค่า: แก้ค่า 6 ปุ่ม ----------

export function foodPresetsCard({ presets, refresh }) {
  const inputs = {}; // key → {kcal, protein, carb, fat}
  const labels = { kcal: 'kcal', protein: 'โปรตีน', carb: 'คาร์บ', fat: 'ไขมัน' };
  const err = h('p', { class: 'bad-text', role: 'alert' });
  const rows = presets.map((p) => {
    inputs[p.key] = {};
    for (const k of PRESET_FIELDS) inputs[p.key][k] = numInput({ value: p[k], inputmode: k === 'kcal' ? 'numeric' : 'decimal', 'aria-label': `${p.label} ${labels[k]}`, id: `fp-${p.key}-${k}` });
    return h(
      'div',
      { class: 'stack tight' },
      h('div', null, h('strong', null, `${p.emoji} ${p.label}`), h('small', { class: 'muted block' }, p.examples)),
      h('div', { class: 'grid4' }, PRESET_FIELDS.map((k) => field(labels[k], inputs[p.key][k])))
    );
  });
  return h(
    'section',
    { class: 'card', id: 'food-presets-card' },
    h('h2', null, '🍽️ ปุ่มกะขนาดมื้อ'),
    h('p', { class: 'muted small-text' }, 'ค่าประมาณของปุ่มในหน้ากิน (ต่อ 1 ขนาด · ½ และ 1½ คำนวณจากค่านี้) ซิงก์ไปทุกเครื่อง · บันทึกที่จดไปแล้วไม่เปลี่ยน'),
    h(
      'details',
      { class: 'details' },
      h('summary', null, 'แก้ค่าของ 6 ปุ่ม'),
      h(
        'form',
        {
          class: 'stack',
          id: 'food-presets-form',
          onsubmit: async (e) => {
            e.preventDefault();
            const overrides = {};
            for (const p of presets) {
              const v = validatePresetValues(Object.fromEntries(PRESET_FIELDS.map((k) => [k, readNum(inputs[p.key][k])])));
              if (!v.ok) return void (err.textContent = `${p.label}: ${v.text}`);
              if (PRESET_FIELDS.some((k) => v.value[k] !== FOOD_PRESETS.find((d) => d.key === p.key)[k])) overrides[p.key] = v.value;
            }
            err.textContent = '';
            await db.saveFoodPresets(overrides);
            toast('บันทึกค่าปุ่มกะแล้ว');
            refresh();
          },
        },
        rows,
        err,
        h('button', { type: 'submit', class: 'btn primary' }, 'บันทึกค่าปุ่ม'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn ghost',
            id: 'food-presets-reset',
            onclick: async () => {
              if (!(await confirmSheet('คืนค่าของ 6 ปุ่มเป็นค่าเริ่มต้น?', { okText: 'คืนค่าเริ่มต้น' }))) return;
              await db.saveFoodPresets(null);
              toast('คืนค่าเริ่มต้นแล้ว');
              refresh();
            },
          },
          'คืนค่าเริ่มต้น'
        )
      )
    )
  );
}
