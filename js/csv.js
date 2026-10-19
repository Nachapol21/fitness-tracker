// แปลงตารางเป็น CSV (ไม่มี DOM ใช้ทดสอบใน Node ได้)

import { isKcalMissing } from './food-quick.js';

export const BOM = '﻿'; // ให้ Excel อ่านภาษาไทย (UTF-8) ได้ถูกต้อง

function cell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // กัน Excel ตีความข้อความว่าเป็นสูตร (CSV injection)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * เตรียมแถวก่อนแปลงเป็น CSV: food_logs ต้องมีคอลัมน์ is_estimate และ kcal_missing ทุกแถวเสมอ
 * (log เดิมที่ไม่มีสองฟิลด์นี้ = ไม่ใช่ค่ากะ is_estimate=false · kcal_missing ดูจาก kcal เป็นว่างหรือมีธง)
 */
export function csvRowsFor(table, rows) {
  if (table !== 'food_logs') return rows;
  return rows.map((r) => ({ ...r, is_estimate: r.is_estimate === true, kcal_missing: isKcalMissing(r) }));
}

/** rows: array ของ object → ข้อความ CSV (ขึ้นต้นด้วย BOM, ขึ้นบรรทัดใหม่แบบ CRLF) */
export function toCSV(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const lines = [cols.map(cell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}
