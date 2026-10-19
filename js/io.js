// ส่งออก/นำเข้าไฟล์ (JSON ทั้งหมด, CSV รายตาราง) — ส่วนที่แตะเบราว์เซอร์

import { csvRowsFor, toCSV } from './csv.js';
import * as db from './db.js';
import { TABLES } from './constants.js';
import { toDateStr } from './dates.js';

const isTouch = () => matchMedia('(pointer: coarse)').matches;

/**
 * บันทึกไฟล์: มือถือใช้ share sheet (เลือก "บันทึกลงไฟล์" ได้) ถ้าไม่ได้ให้ดาวน์โหลดตามปกติ
 * คืน 'saved' | 'cancelled'
 */
export async function saveFile(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  if (isTouch() && typeof File === 'function' && navigator.canShare && navigator.share) {
    try {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return 'saved';
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // ถ้า share ใช้ไม่ได้ (เช่น หมดสิทธิ์จากการกด) ให้ตกไปดาวน์โหลดธรรมดา
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'saved';
}

export async function exportJSON() {
  const data = await db.exportAll();
  const text = JSON.stringify(data, null, 2);
  const res = await saveFile(`fitness-tracker-backup-${toDateStr()}.json`, 'application/json', text);
  if (res === 'saved') await db.setMeta('last_export_at', new Date().toISOString());
  return { result: res, counts: Object.fromEntries(TABLES.map((t) => [t, data.tables[t].length])) };
}

export async function exportCSV(table) {
  const rows = await db.list(table, { includeDeleted: false });
  return saveFile(`fitness-${table}-${toDateStr()}.csv`, 'text/csv;charset=utf-8', toCSV(csvRowsFor(table, rows)));
}

/** อ่านไฟล์ JSON ที่ผู้ใช้เลือก แล้วนำเข้า */
export async function importFile(file, { replace = false } = {}) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new db.ImportError('อ่านไฟล์ไม่ได้ — ไม่ใช่ไฟล์ JSON ที่ถูกต้อง');
  }
  return db.importData(data, { replace });
}

/** ข้อความสรุปผลนำเข้า */
export function summarizeStats(stats) {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const s of Object.values(stats)) {
    added += s.added;
    updated += s.updated;
    skipped += s.skipped;
  }
  return { added, updated, skipped };
}
