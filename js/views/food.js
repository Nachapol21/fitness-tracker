// หน้า "กิน": จดแบบกะเอา (ปุ่มกะขนาดมื้อ) · จดซ้ำจากรายการล่าสุด · รายการโปรด · ค้นหาอาหาร · quick add · คลังอาหาร
// การจดที่ไม่รู้แคล: จดแค่ชื่อได้ (kcal = null + kcal_missing) แล้วแตะรายการเพื่อเติมแคลทีหลัง (js/views/food-estimate.js)

import * as db from '../db.js';
import { MEALS } from '../constants.js';
import { QTY_OPTIONS, isEstimateLog, isKcalMissing, nameOnlyLogFields, normText, presetLabelOf, recentDistinct, repeatLogFields, scaleFood, searchFoods, sizeLabel, usageCounts } from '../food-quick.js';
import { getDate, getMeal, guessMeal, setDate, state } from '../state.js';
import { busyClick, chipGroup, clear, confirmSheet, emptyState, field, fmtInt, fmtNum, h, icon, mount, numInput, openSheet, readNum, stepper, textInput, toast } from '../ui.js';
import { dateNav, nutritionSummary, sumLogs, waterCard } from './common.js';
import { openFillKcal, openPresetSheet, presetGrid } from './food-estimate.js';

const r1 = (n) => Math.round(n * 10) / 10;
const byName = (a, b) => a.name.localeCompare(b.name, 'th');
const foodMeta = (f) => `${f.serving} · ${f.kcal == null ? 'ยังไม่มีแคล' : `${fmtNum(f.kcal, 0)} kcal`} · P ${fmtNum(f.protein)}${f.estimated ? ' · ≈ประมาณ' : ''}`;

async function addEntry({ date, meal, food, qty = 1 }) {
  return db.create('food_logs', {
    date,
    meal,
    food_id: food.id,
    name: food.name,
    serving: food.serving,
    qty,
    ...scaleFood(food, qty),
    quick: false,
    is_estimate: false,
    estimate_preset: null,
    kcal_missing: false,
  });
}

// ---------- หน้าหลัก ----------

export async function renderFood(root, params = []) {
  if (params[0] === 'db') return renderFoodDb(root);
  const date = getDate();
  const [profile, logs, water, foods, allLogs, presets] = await Promise.all([db.getProfile(), db.listByIndex('food_logs', 'date', date), db.listByIndex('water_logs', 'date', date), db.list('foods'), db.list('food_logs'), db.getFoodPresets()]);
  const refresh = () => renderFood(root, params);
  const meal = getMeal();
  const totals = sumLogs(logs);
  const favs = foods.filter((f) => f.favorite).sort(byName);
  const recents = recentDistinct(allLogs, 5);

  const mealChips = chipGroup({
    options: MEALS,
    value: meal,
    onChange: (v) => {
      state.meal = v;
    },
  });

  const subText = (l) => {
    if (isKcalMissing(l)) return 'แตะเพื่อเติมแคล';
    if (isEstimateLog(l)) return [h('span', { class: 'tag est' }, '≈ กะเอา'), ` ${presetLabelOf(presets, l.estimate_preset)} ×${sizeLabel(Number(l.qty) || 1)}`];
    return l.quick ? 'Quick add' : `${fmtNum(l.qty, 2)} × ${l.serving || 'ที่'}`;
  };

  const logSections = MEALS.map((m) => {
    const items = logs.filter((l) => l.meal === m).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    if (!items.length) return null;
    const t = sumLogs(items);
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, m), h('span', { class: t.missing ? 'warn-text' : 'muted' }, t.missing ? `≥ ${fmtInt(t.kcal)} kcal · ยังไม่มีแคล ${t.missing} มื้อ` : `${fmtInt(t.kcal)} kcal · P ${fmtNum(t.protein, 0)} ก.`)),
      h(
        'ul',
        { class: 'list' },
        items.map((l) => {
          const missing = isKcalMissing(l);
          return h(
            'li',
            null,
            h(
              'button',
              { class: 'list-row', 'data-log': l.id, onclick: () => (missing ? openFillKcal(l, { onDone: refresh }) : openEntryEditor(l, refresh)) },
              h('span', { class: 'grow' }, h('strong', null, l.name), h('small', { class: 'muted block' }, subText(l))),
              missing ? h('span', { class: 'tag warn' }, 'ยังไม่มีแคล') : h('span', { class: 'right' }, h('strong', null, `${fmtInt(l.kcal)}`), h('small', { class: 'muted block' }, `P ${fmtNum(l.protein)}`))
            )
          );
        })
      )
    );
  });

  const repeat = async (l) => {
    const m = guessMeal(); // จดซ้ำเป็นมื้อตามเวลาตอนนี้
    const e = await db.create('food_logs', repeatLogFields(l, { date, meal: m }));
    toast(`จด ${l.name} ซ้ำในมื้อ${m}`, {
      action: {
        label: 'ย้อน',
        fn: async () => {
          await db.remove('food_logs', e.id);
          refresh();
        },
      },
    });
    refresh();
  };

  mount(root,
    h('header', { class: 'page-head' }, h('h1', null, 'กิน'), h('a', { class: 'btn small ghost', href: '#/food/db' }, 'คลังอาหาร')),
    dateNav(date, (d) => {
      setDate(d);
      refresh();
    }),
    h(
      'section',
      { class: 'card', id: 'preset-card' },
      h('div', { class: 'card-head' }, h('h2', null, 'จดแบบกะเอา'), h('small', { class: 'muted' }, 'ไม่ต้องรู้แคล แตะแล้วบันทึก')),
      presetGrid({ presets, onPick: (preset) => openPresetSheet({ preset, date, onDone: refresh }) }),
      h('small', { class: 'muted' }, 'ค่าประมาณ ไม่ต้องเป๊ะ · แก้ค่าปุ่มได้ที่ ', h('a', { href: '#/settings' }, 'ตั้งค่า'))
    ),
    recents.length
      ? h(
          'section',
          { class: 'card', id: 'recent-card' },
          h('div', { class: 'card-head' }, h('h2', null, 'ล่าสุด'), h('small', { class: 'muted' }, 'แตะครั้งเดียวจดซ้ำ')),
          h(
            'div',
            { class: 'recent-row' },
            recents.map((l) =>
              h(
                'button',
                { class: 'recent-chip', type: 'button', 'data-recent': l.id, onclick: () => repeat(l) },
                h('span', { class: 'fav-name' }, l.name),
                h('small', { class: isKcalMissing(l) ? 'warn-text' : 'muted' }, isKcalMissing(l) ? 'ยังไม่มีแคล' : `${fmtInt(l.kcal)} kcal`)
              )
            )
          )
        )
      : null,
    h('section', { class: 'card' }, nutritionSummary(totals, profile)),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'เพิ่มอาหาร')),
      h('p', { class: 'muted small-text' }, 'เลือกมื้อ แล้วแตะรายการโปรดเพื่อเพิ่ม 1 ที่'),
      mealChips.el,
      favs.length
        ? h(
            'div',
            { class: 'fav-grid' },
            favs.map((f) =>
              h(
                'button',
                {
                  class: 'fav',
                  onclick: async () => {
                    const e = await addEntry({ date, meal: mealChips.get(), food: f });
                    toast(`เพิ่ม ${f.name} ในมื้อ${mealChips.get()}`, {
                      action: {
                        label: 'ย้อน',
                        fn: async () => {
                          await db.remove('food_logs', e.id);
                          refresh();
                        },
                      },
                    });
                    refresh();
                  },
                },
                h('span', { class: 'fav-name' }, f.name),
                h('small', { class: 'muted' }, `${fmtNum(f.kcal, 0)} kcal · P ${fmtNum(f.protein)}`)
              )
            )
          )
        : h('p', { class: 'muted' }, 'ยังไม่มีรายการโปรด — กดดาวในคลังอาหารเพื่อเพิ่ม'),
      h(
        'div',
        { class: 'row gap mt' },
        h('button', { class: 'btn primary grow', id: 'btn-search-food', onclick: () => openFoodPicker({ date, meal: mealChips.get(), onDone: refresh }) }, icon('plus', 18), ' ค้นหา / เพิ่มอาหาร'),
        h('button', { class: 'btn grow', id: 'btn-quick-add', onclick: () => openQuickAdd({ date, meal: mealChips.get(), onDone: refresh }) }, 'Quick add')
      )
    ),
    logs.length ? logSections : emptyState('ยังไม่ได้จดอาหารวันนี้'),
    waterCard({ date, logs: water, profile, refresh }),
    h('p', { class: 'muted small-text' }, 'หมายเหตุ: ค่าอาหารตั้งต้นและค่าปุ่มกะเป็นค่าประมาณ แต่ละร้านต่างกันได้ราว ±20–30% แก้ไขหรือเพิ่มเองได้ (ค่าปุ่มกะแก้ได้ในตั้งค่า)')
  );
}

// ---------- เลือก/ค้นหาอาหาร ----------

export function openFoodPicker({ date, meal, onDone }) {
  // ถ้าปิดแผ่นโดยไม่ได้เพิ่มอาหาร แต่แก้ดาวโปรด/สร้างอาหารใหม่ไว้ ให้วาดหน้าใหม่เพื่อให้ปุ่มโปรดตรงกับข้อมูล
  let dirty = false;
  const sheet = openSheet({
    title: 'เพิ่มอาหาร',
    content: h('p', { class: 'muted' }, 'กำลังโหลด…'),
    onClose: () => {
      if (dirty) onDone();
    },
  });
  let foods = [];
  let usage = new Map();

  async function load() {
    const [f, logs] = await Promise.all([db.list('foods'), db.list('food_logs')]);
    foods = f;
    usage = usageCounts(logs);
    showList();
  }

  /** ไม่เจอเมนู/ไม่รู้แคล: จดแค่ชื่อ (kcal = null) แล้วเติมแคลทีหลัง */
  async function addNameOnly(text) {
    const e = await db.create('food_logs', nameOnlyLogFields({ name: text, date, meal }));
    dirty = false;
    sheet.close();
    toast(`จด ${e.name} แล้ว (ยังไม่มีแคล)`, { action: { label: 'เติมแคล', fn: () => openFillKcal(e, { onDone }) } });
    onDone();
  }

  function showList(query = '') {
    const search = textInput({ placeholder: 'ค้นหาอาหาร เช่น ไข่ กะเพรา', type: 'search', 'aria-label': 'ค้นหาอาหาร', id: 'food-search' });
    search.value = query;
    const listEl = h('ul', { class: 'list', id: 'food-results' });
    const paint = () => {
      const typed = search.value.trim();
      const rows = searchFoods(foods, typed, usage); // คำบางส่วน ไม่สนตัวพิมพ์/ช่องว่าง · โปรด/ที่ใช้บ่อยขึ้นก่อน
      clear(listEl);
      if (!rows.length) listEl.append(h('li', { class: 'muted pad' }, 'ไม่พบเมนูนี้ — จดแค่ชื่อไว้ก่อนก็ได้ หรือกด "สร้างอาหารใหม่" ด้านบน'));
      for (const f of rows) {
        listEl.append(
          h(
            'li',
            { class: 'row' },
            h('button', { class: 'list-row grow', 'data-food': f.id, onclick: () => showQty(f) }, h('span', { class: 'grow' }, h('strong', null, f.name), h('small', { class: 'muted block' }, foodMeta(f)))),
            h(
              'button',
              {
                class: `icon-btn star ${f.favorite ? 'on' : ''}`,
                'aria-label': f.favorite ? 'เอาออกจากรายการโปรด' : 'เพิ่มในรายการโปรด',
                'aria-pressed': String(!!f.favorite),
                onclick: async () => {
                  const u = await db.update('foods', f.id, { favorite: !f.favorite });
                  foods = foods.map((x) => (x.id === u.id ? u : x));
                  dirty = true;
                  paint();
                },
              },
              icon('star', 20)
            )
          )
        );
      }
      if (typed) {
        listEl.append(
          h('li', { class: 'row' }, h('button', { class: 'list-row grow', id: 'btn-name-only', onclick: () => addNameOnly(typed) }, h('span', { class: 'grow' }, h('strong', null, `จดเฉพาะชื่อ "${typed}"`), h('small', { class: 'muted block' }, 'ยังไม่มีแคล · แตะรายการทีหลังเพื่อเติมแคล'))))
        );
      }
    };
    search.addEventListener('input', paint);
    paint();
    sheet.setContent(
      h(
        'div',
        { class: 'stack' },
        h('button', { class: 'btn', onclick: () => showForm() }, icon('plus', 18), ' สร้างอาหารใหม่'),
        search,
        listEl
      ),
      'เลือกอาหาร'
    );
  }

  function showForm() {
    sheet.setContent(
      foodForm({
        onSaved: (f) => {
          foods.push(f);
          dirty = true;
          showQty(f);
        },
        onCancel: () => showList(),
      }),
      'สร้างอาหารใหม่'
    );
  }

  function showQty(food) {
    const qty = chipGroup({ options: QTY_OPTIONS.map((v) => ({ value: v, label: sizeLabel(v) })), value: 1, onChange: () => preview() });
    const mealChips = chipGroup({ options: MEALS, value: meal });
    const out = h('div', { class: 'preview', id: 'qty-preview' });
    const preview = () => {
      const q = qty.get();
      out.textContent = `${fmtInt(food.kcal * q)} kcal · โปรตีน ${fmtNum(food.protein * q)} · คาร์บ ${fmtNum(food.carb * q)} · ไขมัน ${fmtNum(food.fat * q)} ก.`;
    };
    preview();
    sheet.setContent(
      h(
        'div',
        { class: 'stack' },
        h('div', null, h('strong', null, food.name), h('div', { class: 'muted' }, `1 ที่ = ${foodMeta(food)}`)),
        field('จำนวนที่', qty.el),
        field('มื้อ', mealChips.el),
        out,
        h(
          'div',
          { class: 'row gap' },
          h('button', { class: 'btn ghost', onclick: () => showList() }, 'กลับ'),
          h(
            'button',
            {
              class: 'btn primary grow',
              id: 'btn-add-to-meal',
              onclick: busyClick(async () => {
                await addEntry({ date, meal: mealChips.get(), food, qty: qty.get() });
                state.meal = mealChips.get();
                dirty = false;
                sheet.close();
                toast(`เพิ่ม ${food.name} แล้ว`);
                onDone();
              }),
            },
            'เพิ่มลงมื้อ'
          )
        )
      ),
      'จำนวนที่กิน'
    );
  }

  load();
  return sheet;
}

/** ฟอร์มสร้าง/แก้ไขอาหาร */
export function foodForm({ food, onSaved, onCancel, onDelete }) {
  const f = food || {};
  const name = textInput({ value: f.name || '', placeholder: 'เช่น ข้าวผัดกะเพรา' });
  const serving = textInput({ value: f.serving || '', placeholder: 'เช่น 1 จาน / 1 ซอง / 100 ก.' });
  const kcal = numInput({ value: f.kcal ?? '', placeholder: '0' });
  const protein = numInput({ value: f.protein ?? '', placeholder: '0' });
  const carb = numInput({ value: f.carb ?? '', placeholder: '0' });
  const fat = numInput({ value: f.fat ?? '', placeholder: '0' });
  const fav = h('input', { type: 'checkbox', checked: !!f.favorite });
  const est = h('input', { type: 'checkbox', checked: food ? !!f.estimated : false });
  const err = h('p', { class: 'bad-text', role: 'alert' });

  return h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const k = readNum(kcal);
        if (!name.value.trim()) return void (err.textContent = 'ใส่ชื่ออาหารก่อน');
        if (k === null || k < 0) return void (err.textContent = 'ใส่แคลอรี่ (ตัวเลข ≥ 0)');
        const fields = {
          name: name.value.trim(),
          serving: serving.value.trim() || '1 ที่',
          kcal: k,
          protein: readNum(protein) ?? 0,
          carb: readNum(carb) ?? 0,
          fat: readNum(fat) ?? 0,
          favorite: fav.checked,
          estimated: est.checked,
        };
        const saved = food ? await db.update('foods', food.id, fields) : await db.create('foods', fields);
        onSaved(saved);
      },
    },
    field('ชื่ออาหาร', name),
    field('ขนาดหนึ่งที่', serving),
    h('div', { class: 'grid2' }, field('แคลอรี่ (kcal)', kcal), field('โปรตีน (ก.)', protein), field('คาร์บ (ก.)', carb), field('ไขมัน (ก.)', fat)),
    h('label', { class: 'check' }, fav, h('span', null, 'รายการโปรด (กดเพิ่มได้ครั้งเดียว)')),
    h('label', { class: 'check' }, est, h('span', null, 'เป็นค่าประมาณ')),
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

// ---------- quick add ----------

export function openQuickAdd({ date, meal, onDone }) {
  const name = textInput({ placeholder: 'ชื่อ เช่น ก๋วยเตี๋ยวเรือ', 'aria-label': 'ชื่ออาหาร', id: 'qa-name' });
  const kcal = numInput({ placeholder: 'ไม่รู้ = เว้นว่าง', inputmode: 'numeric', 'aria-label': 'แคลอรี่ (kcal)', id: 'qa-kcal' });
  const protein = numInput({ placeholder: 'เช่น 25', 'aria-label': 'โปรตีน (ก.)' });
  const mealChips = chipGroup({ options: MEALS, value: meal });
  const err = h('p', { class: 'bad-text', role: 'alert' });
  const sheet = openSheet({
    title: 'Quick add',
    content: h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          const k = readNum(kcal);
          const typed = name.value.trim();
          if (k !== null && k < 0) return void (err.textContent = 'แคลอรี่ต้องเป็นตัวเลข ≥ 0');
          if (k === null && !typed) return void (err.textContent = 'ใส่ชื่ออาหาร หรือใส่แคลอรี่อย่างน้อยหนึ่งอย่าง');
          let rec;
          if (k === null) {
            // ไม่รู้แคล: จดแค่ชื่อ (kcal = null) เติมแคลทีหลัง
            rec = await db.create('food_logs', nameOnlyLogFields({ name: typed, date, meal: mealChips.get() }));
          } else {
            rec = await db.create('food_logs', { date, meal: mealChips.get(), food_id: null, name: typed || 'Quick add', serving: '', qty: 1, kcal: k, protein: readNum(protein) ?? 0, carb: 0, fat: 0, quick: true, is_estimate: false, estimate_preset: null, kcal_missing: false });
          }
          state.meal = mealChips.get();
          sheet.close();
          toast(k === null ? `จด ${rec.name} แล้ว (ยังไม่มีแคล)` : 'เพิ่มรายการแล้ว', k === null ? { action: { label: 'เติมแคล', fn: () => openFillKcal(rec, { onDone }) } } : undefined);
          onDone();
        },
      },
      h('p', { class: 'muted' }, 'ไม่รู้แคลก็จดแค่ชื่อได้ แล้วแตะรายการทีหลังเพื่อเติมแคล (วันที่ยังมีมื้อไม่มีแคลจะยังไม่ได้ coin แคลอรี่)'),
      field('ชื่อ', name),
      h('div', { class: 'grid2' }, field('แคลอรี่ (kcal) — ไม่บังคับ', kcal), field('โปรตีน (ก.)', protein)),
      field('มื้อ', mealChips.el),
      err,
      h('button', { type: 'submit', class: 'btn primary' }, 'เพิ่ม')
    ),
  });
  setTimeout(() => name.focus(), 50);
}

// ---------- แก้/ลบรายการที่จดแล้ว ----------

function openEntryEditor(entry, onDone) {
  const mealChips = chipGroup({ options: MEALS, value: entry.meal });
  const del = async (close) => {
    await db.remove('food_logs', entry.id);
    close();
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
  };
  let body;
  if (entry.quick) {
    const kcal = numInput({ value: entry.kcal, 'aria-label': 'แคลอรี่ (kcal)' });
    const protein = numInput({ value: entry.protein });
    const name = textInput({ value: entry.name });
    body = (close) =>
      h(
        'div',
        { class: 'stack' },
        entry.is_estimate ? h('p', { class: 'muted small-text' }, '≈ ค่ากะเอา แก้ตัวเลขได้ ล้างช่องแคลเพื่อกลับไปเป็น "ยังไม่มีแคล"') : null,
        h('div', { class: 'grid2' }, field('แคลอรี่ (kcal)', kcal), field('โปรตีน (ก.)', protein)),
        field('ชื่อ', name),
        field('มื้อ', mealChips.el),
        h(
          'div',
          { class: 'row gap' },
          h('button', { class: 'btn danger-outline', onclick: () => del(close) }, 'ลบ'),
          h(
            'button',
            {
              class: 'btn primary grow',
              onclick: async () => {
                const k = readNum(kcal);
                const patch = { protein: readNum(protein) ?? 0, name: name.value.trim() || 'Quick add', meal: mealChips.get() };
                // ช่องแคลว่าง = ยังไม่มีแคล (kcal = null)
                await db.update('food_logs', entry.id, k === null ? { ...patch, kcal: null, kcal_missing: true } : { ...patch, kcal: Math.max(0, k), kcal_missing: false });
                close();
                onDone();
              },
            },
            'บันทึก'
          )
        )
      );
  } else {
    const qty = stepper({ value: Number(entry.qty) || 1, step: 0.5, min: 0.5 });
    const per = (k) => (Number(entry[k]) || 0) / (Number(entry.qty) || 1);
    body = (close) =>
      h(
        'div',
        { class: 'stack' },
        h('div', null, h('strong', null, entry.name), h('div', { class: 'muted' }, entry.serving)),
        field('จำนวนที่', qty.el),
        field('มื้อ', mealChips.el),
        h(
          'div',
          { class: 'row gap' },
          h('button', { class: 'btn danger-outline', onclick: () => del(close) }, 'ลบ'),
          h(
            'button',
            {
              class: 'btn primary grow',
              onclick: async () => {
                const q = qty.get();
                await db.update('food_logs', entry.id, { qty: q, meal: mealChips.get(), kcal: r1(per('kcal') * q), protein: r1(per('protein') * q), carb: r1(per('carb') * q), fat: r1(per('fat') * q) });
                close();
                onDone();
              },
            },
            'บันทึก'
          )
        )
      );
  }
  openSheet({ title: 'แก้ไขรายการ', content: body });
}

// ---------- คลังอาหาร ----------

async function renderFoodDb(root) {
  const foods = await db.list('foods');
  const refresh = () => renderFoodDb(root);
  const search = textInput({ placeholder: 'ค้นหาอาหาร', type: 'search', 'aria-label': 'ค้นหาอาหาร' });
  const listEl = h('ul', { class: 'list' });
  const paint = () => {
    const q = normText(search.value);
    clear(listEl);
    for (const f of foods.filter((x) => !q || normText(x.name).includes(q)).sort(byName)) {
      listEl.append(
        h(
          'li',
          { class: 'row' },
          h('button', { class: 'list-row grow', onclick: () => openEdit(f) }, h('span', { class: 'grow' }, h('strong', null, f.name), h('small', { class: 'muted block' }, foodMeta(f)))),
          h(
            'button',
            {
              class: `icon-btn star ${f.favorite ? 'on' : ''}`,
              'aria-label': f.favorite ? 'เอาออกจากรายการโปรด' : 'เพิ่มในรายการโปรด',
              'aria-pressed': String(!!f.favorite),
              onclick: async () => {
                await db.update('foods', f.id, { favorite: !f.favorite });
                refresh();
              },
            },
            icon('star', 20)
          )
        )
      );
    }
  };
  function openEdit(food) {
    const sheet = openSheet({
      title: food ? 'แก้ไขอาหาร' : 'เพิ่มอาหาร',
      content: foodForm({
        food,
        onSaved: () => {
          sheet.close();
          refresh();
        },
        onCancel: () => sheet.close(),
        onDelete: food
          ? async () => {
              if (await confirmSheet(`ลบ "${food.name}" ออกจากคลัง? (รายการที่จดไปแล้วไม่หาย)`, { okText: 'ลบ', danger: true })) {
                await db.remove('foods', food.id);
                sheet.close();
                refresh();
              }
            }
          : undefined,
      }),
    });
  }
  search.addEventListener('input', paint);
  paint();
  mount(root,
    h('header', { class: 'page-head' }, h('a', { class: 'btn small ghost', href: '#/food' }, '‹ กลับ'), h('h1', null, 'คลังอาหาร'), h('button', { class: 'btn small primary', onclick: () => openEdit(null) }, '+ เพิ่ม')),
    h('p', { class: 'muted small-text' }, `${foods.length} รายการ · ค่าที่ตั้งต้นให้เป็นค่าประมาณ แตะเพื่อแก้ไข กดดาวเพื่อตั้งเป็นรายการโปรด`),
    search,
    h('section', { class: 'card flush' }, listEl)
  );
}
