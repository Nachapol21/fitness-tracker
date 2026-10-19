// จดการกินแบบกะเอา: ตรรกะล้วน (ไม่แตะ DOM/IndexedDB) ทดสอบด้วย node --test
// - ปุ่มกะขนาดมื้อ 6 ปุ่ม × ขนาด ½/1/1½ → ค่า kcal/โปรตีน/คาร์บ/ไขมันของบันทึก
// - นิยาม "ยังไม่มีแคล" ที่ใช้ร่วมกันทั้งแอป (isKcalMissing)
// - ค้นหาอาหารด้วยคำบางส่วน เรียงรายการโปรด/ที่ใช้บ่อยขึ้นก่อน · รายการล่าสุดสำหรับจดซ้ำ
// ห้าม import ไฟล์อื่นของแอปที่ import ไฟล์นี้กลับ (game.js, analytics.js ใช้ isKcalMissing จากที่นี่)

const r1 = (n) => Math.round(n * 10) / 10;

/** ขนาดที่เลือกได้หลังกดปุ่มกะ */
export const SIZE_OPTIONS = [0.5, 1, 1.5];
/** จำนวนที่ตอนเลือกเมนูจากคลัง */
export const QTY_OPTIONS = [0.5, 1, 1.5, 2];
const SIZE_LABELS = { 0.5: '½', 1: '1', 1.5: '1½', 2: '2' };
export const sizeLabel = (n) => SIZE_LABELS[n] ?? String(n);

/** ค่าเริ่มต้นของปุ่มกะ (ค่าประมาณ แก้ได้ในตั้งค่า) */
export const FOOD_PRESETS = Object.freeze(
  [
    { key: 'snack', emoji: '🍪', label: 'ของว่าง', examples: 'ขนม ผลไม้ ซาลาเปา', kcal: 150, protein: 5, carb: 20, fat: 6 },
    { key: 'light', emoji: '🥗', label: 'มื้อเบา', examples: 'ก๋วยเตี๋ยวน้ำ ข้าวต้ม โจ๊ก สลัด', kcal: 350, protein: 18, carb: 45, fat: 10 },
    { key: 'normal', emoji: '🍛', label: 'มื้อปกติ', examples: 'ข้าวจานเดียวทั่วไป', kcal: 550, protein: 25, carb: 70, fat: 20 },
    { key: 'heavy', emoji: '🍗', label: 'มื้อหนัก', examples: 'ของทอด จานใหญ่ ข้าวพูน', kcal: 800, protein: 30, carb: 90, fat: 35 },
    { key: 'buffet', emoji: '🍲', label: 'บุฟเฟ่ต์', examples: 'ชาบู หมูกระทะ ปิ้งย่าง', kcal: 1500, protein: 70, carb: 140, fat: 70 },
    { key: 'drink', emoji: '🧋', label: 'เครื่องดื่มหวาน', examples: 'ชานม ชาเย็น กาแฟเย็น', kcal: 250, protein: 3, carb: 45, fat: 7 },
  ].map((p) => Object.freeze(p))
);

export const PRESET_FIELDS = ['kcal', 'protein', 'carb', 'fat'];
const MAX_VALUE = { kcal: 5000, protein: 500, carb: 800, fat: 500 };

/**
 * ตรวจค่าที่ผู้ใช้แก้ของ 1 ปุ่ม: คืน { ok, value } (ครบ 4 ค่า) หรือ { ok:false, text }
 * kcal ต้อง≥ 1 (0 ทำให้ปุ่มไม่มีความหมาย) · ค่าอื่นเว้นว่างได้ (= 0)
 */
export function validatePresetValues(raw) {
  const out = {};
  for (const k of PRESET_FIELDS) {
    const v = raw?.[k];
    const n = v === null || v === undefined || v === '' ? (k === 'kcal' ? NaN : 0) : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > MAX_VALUE[k]) return { ok: false, text: k === 'kcal' ? `แคลอรี่ต้องเป็นตัวเลข 1–${MAX_VALUE.kcal}` : `ค่า ${k} ต้องเป็นตัวเลข 0–${MAX_VALUE[k]}` };
    if (k === 'kcal' && n < 1) return { ok: false, text: `แคลอรี่ต้องเป็นตัวเลข 1–${MAX_VALUE.kcal}` };
    out[k] = r1(n);
  }
  return { ok: true, value: out };
}

/**
 * รวมค่าที่ผู้ใช้แก้ (overrides = { [key]: {kcal,protein,carb,fat} }) กับค่าเริ่มต้น
 * ค่าที่เพี้ยน (เช่น ข้อมูลซิงก์เสีย) ใช้ค่าเริ่มต้นของปุ่มนั้นแทน — ไม่ทำให้หน้ากินล้ม
 */
export function resolvePresets(overrides) {
  return FOOD_PRESETS.map((p) => {
    const o = overrides && typeof overrides === 'object' ? overrides[p.key] : null;
    const v = o && typeof o === 'object' ? validatePresetValues(o) : null;
    return v?.ok ? { ...p, ...v.value, customized: PRESET_FIELDS.some((k) => v.value[k] !== p[k]) } : { ...p, customized: false };
  });
}

/** ค่า kcal/โปรตีน/คาร์บ/ไขมัน ของอาหารในคลัง × จำนวนที่ (½ / 1 / 1½ / 2) */
export function scaleFood(food, qty = 1) {
  const q = Number(qty) > 0 ? Number(qty) : 1;
  const n = (v) => r1((Number(v) || 0) * q);
  return { kcal: n(food.kcal), protein: n(food.protein), carb: n(food.carb), fat: n(food.fat) };
}

/** ชื่อปุ่มจาก key (ไม่รู้จัก = 'ปุ่มกะ') */
export const presetLabelOf = (presets, key) => (presets || FOOD_PRESETS).find((p) => p.key === key)?.label || 'ปุ่มกะ';

/** ค่า kcal/โปรตีน/คาร์บ/ไขมัน ของปุ่ม × ขนาด */
export function presetAmounts(preset, size = 1) {
  const s = Number(size) > 0 ? Number(size) : 1;
  return { kcal: r1(preset.kcal * s), protein: r1(preset.protein * s), carb: r1(preset.carb * s), fat: r1(preset.fat * s) };
}

/** ฟิลด์ food_log ที่จดจากปุ่มกะ (ส่งให้ db.create ได้เลย) */
export function presetLogFields({ preset, size = 1, name = '', date, meal }) {
  const s = Number(size) > 0 ? Number(size) : 1;
  return {
    date,
    meal,
    food_id: null,
    name: String(name || '').trim() || preset.label,
    serving: '',
    qty: s,
    ...presetAmounts(preset, s),
    quick: true, // ใช้ตัวแก้ไขแบบ quick (แก้ตัวเลขตรงๆ ได้) และนับเป็นมื้อในเกมเหมือน Quick add
    is_estimate: true,
    estimate_preset: preset.key,
    kcal_missing: false,
  };
}

/** ฟิลด์ที่ใช้เติมแคลให้ log ที่ยังไม่มีแคล ด้วยปุ่มกะ × ขนาด */
export function fillFromPreset(preset, size = 1) {
  const s = Number(size) > 0 ? Number(size) : 1;
  return { ...presetAmounts(preset, s), qty: s, quick: true, is_estimate: true, estimate_preset: preset.key, kcal_missing: false };
}

// ---------- "ยังไม่มีแคล" ----------

/**
 * นิยามเดียวของทั้งแอป: log ที่ยังไม่มีแคลคือ kcal เป็น null/ว่าง หรือมีธง kcal_missing = true
 * (log เดิมที่มี kcal เป็นตัวเลข รวม 0 ไม่ใช่ "ยังไม่มีแคล")
 */
export function isKcalMissing(l) {
  return !!l && (l.kcal_missing === true || l.kcal === null || l.kcal === undefined || l.kcal === '');
}

/** ฟิลด์สำหรับจดแค่ชื่อ */
export function nameOnlyLogFields({ name, date, meal }) {
  return { date, meal, food_id: null, name: String(name || '').trim() || 'ไม่ระบุ', serving: '', qty: 1, kcal: null, protein: 0, carb: 0, fat: 0, quick: true, is_estimate: false, estimate_preset: null, kcal_missing: true };
}

/** log ที่ยังไม่มีแคลในช่วงวันที่ [from, to] เรียงวันใหม่ → เก่า */
export function missingKcalLogs(logs, from, to) {
  return (logs || [])
    .filter((l) => l && !l.deleted && isKcalMissing(l) && (!from || l.date >= from) && (!to || l.date <= to))
    .sort((a, b) => (a.date === b.date ? ((a.created_at || '') < (b.created_at || '') ? 1 : -1) : a.date < b.date ? 1 : -1));
}

// ---------- ค้นหา ----------

/** ทำข้อความให้เทียบกันได้: ตัวพิมพ์เล็ก ตัดช่องว่าง วงเล็บ และอักขระความกว้างศูนย์ */
export function normText(s) {
  return String(s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s​‌‍﻿()[\]{}（）［］]+/g, '')
    // ตัวสะกดที่คนพิมพ์บ่อย ให้ค้นเจอเมนูเดียวกัน
    .replace(/กระเพรา/g, 'กะเพรา');
}

/** จำนวนครั้งที่ใช้แต่ละอาหาร: Map(food_id → จำนวน log ที่ยังไม่ถูกลบ) */
export function usageCounts(logs) {
  const m = new Map();
  for (const l of logs || []) if (l && !l.deleted && l.food_id) m.set(l.food_id, (m.get(l.food_id) || 0) + 1);
  return m;
}

const byThai = (a, b) => String(a).localeCompare(String(b), 'th');

/**
 * ค้นหาอาหารด้วยคำบางส่วน (ไม่สนตัวพิมพ์/ช่องว่าง) แล้วเรียง: รายการโปรด → ที่เคยใช้ (ใช้บ่อยก่อน) → ที่เหลือ
 * ในกลุ่มเดียวกันเรียงตามจำนวนครั้งที่ใช้ แล้วชื่อที่ขึ้นต้นด้วยคำค้น แล้วตามตัวอักษร
 */
export function searchFoods(foods, query, usage = new Map()) {
  const q = normText(query);
  const uses = (f) => usage.get(f.id) || 0;
  const group = (f) => (f.favorite ? 0 : uses(f) > 0 ? 1 : 2);
  return (foods || [])
    .filter((f) => f && !f.deleted && (!q || normText(f.name).includes(q)))
    .map((f) => ({ f, n: normText(f.name) }))
    .sort((a, b) => group(a.f) - group(b.f) || uses(b.f) - uses(a.f) || Number(b.n.startsWith(q)) - Number(a.n.startsWith(q)) || byThai(a.f.name, b.f.name))
    .map((x) => x.f);
}

// ---------- รายการล่าสุด (จดซ้ำ) ----------

const recentKey = (l) => (l.food_id ? `f:${l.food_id}` : `n:${normText(l.name)}|${l.estimate_preset || ''}|${l.qty ?? 1}`);

/** n รายการที่จดล่าสุด ไม่ซ้ำกัน (ใช้ created_at ของ log) */
export function recentDistinct(logs, n = 5) {
  const rows = (logs || []).filter((l) => l && !l.deleted).sort((a, b) => ((a.created_at || '') < (b.created_at || '') ? 1 : (a.created_at || '') > (b.created_at || '') ? -1 : 0));
  const seen = new Set();
  const out = [];
  for (const l of rows) {
    const k = recentKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
    if (out.length >= n) break;
  }
  return out;
}

/** ฟิลด์ของ log ใหม่ที่จดซ้ำจาก log เดิม (วัน/มื้อใหม่) */
export function repeatLogFields(log, { date, meal }) {
  const missing = isKcalMissing(log);
  return {
    date,
    meal,
    food_id: log.food_id ?? null,
    name: log.name,
    serving: log.serving ?? '',
    qty: log.qty ?? 1,
    kcal: missing ? null : log.kcal,
    protein: log.protein ?? 0,
    carb: log.carb ?? 0,
    fat: log.fat ?? 0,
    quick: !!log.quick,
    is_estimate: !!log.is_estimate,
    estimate_preset: log.estimate_preset ?? null,
    kcal_missing: missing,
  };
}

/** บอกว่าเป็นของจากปุ่มกะ (ใช้แสดงป้าย "≈ กะเอา") */
export const isEstimateLog = (l) => !!l && l.is_estimate === true;
