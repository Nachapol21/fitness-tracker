// ตัวช่วยรวมข้อมูลแบบ last-write-wins (LWW) ไม่มี DOM/IndexedDB ใช้ทดสอบใน Node ได้

/**
 * แปลงเวลาเป็น ms รองรับทั้ง ISO ของเครื่อง ("...123Z") และของ Postgres
 * ("2026-10-18 10:00:00.123456+00" / "...T...+00:00") ซึ่งมีไมโครวินาที
 * ค่าที่อ่านไม่ได้คืน 0 (เก่าที่สุด)
 */
export function toMs(t) {
  if (typeof t === 'number') return Number.isFinite(t) ? t : 0;
  if (typeof t !== 'string' || !t) return 0;
  let s = t.trim();
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ', 'T');
  s = s.replace(/(\.\d{3})\d+/, '$1'); // Safari ไม่ชอบเศษวินาทีเกิน 3 หลัก
  if (s.includes('T')) s = s.replace(/([+-]\d{2})$/, '$1:00'); // "+00" → "+00:00"
  const n = Date.parse(s);
  return Number.isNaN(n) ? 0 : n;
}

/** ใช้ฉบับจากเซิร์ฟเวอร์ก็ต่อเมื่อไม่มีในเครื่อง หรือ client_updated_at ใหม่กว่า updated_at ในเครื่อง (เท่ากัน = คงของเดิม) */
export function shouldApplyRemote(local, row) {
  return !local || toMs(row.client_updated_at) > toMs(local.updated_at);
}

/** แถวบนเซิร์ฟเวอร์ → เรคคอร์ดในเครื่อง โดยไม่แตะ updated_at เดิม */
export function rowToRecord(row) {
  const d = row.data && typeof row.data === 'object' ? row.data : {};
  return {
    ...d,
    id: row.id,
    created_at: d.created_at || row.client_updated_at,
    updated_at: d.updated_at || row.client_updated_at,
    deleted: !!row.deleted,
  };
}

/** เรคคอร์ดในเครื่อง → แถวที่ส่งขึ้น sync_records (ไม่ส่ง server_updated_at) */
export function recordToRow(table, rec, userId) {
  return {
    id: rec.id,
    user_id: userId,
    collection: table,
    data: rec,
    deleted: !!rec.deleted,
    client_updated_at: rec.updated_at,
  };
}

/**
 * รวมแถวที่ดึงมา  io = { tables, get(table,id), put(table,rec) }
 * idempotent: รวมแถวเดิมซ้ำกี่ครั้งก็ได้ผลเท่าเดิม (ครั้งที่สองจะข้ามหมดเพราะเวลาเท่ากัน)
 */
export async function mergeRows(rows, io) {
  let applied = 0;
  let skipped = 0;
  let unknown = 0; // แถวของ collection ที่แอปรุ่นนี้ไม่รู้จัก (มาจากแอปรุ่นใหม่กว่า)
  let unknownMs = 0; // เวลาเซิร์ฟเวอร์ที่เก่าที่สุดของแถวเหล่านั้น: ผู้เรียกต้องไม่เลื่อน cursor ผ่านจุดนี้ ไม่งั้นพออัปเกรดแล้วจะไม่ได้แถวพวกนั้นอีก
  for (const row of rows) {
    if (row && typeof row.collection === 'string' && !io.tables.includes(row.collection)) {
      unknown++;
      const t = toMs(row.server_updated_at);
      if (t > 0 && (unknownMs === 0 || t < unknownMs)) unknownMs = t;
    }
    if (!row || !io.tables.includes(row.collection) || typeof row.id !== 'string') {
      skipped++;
      continue;
    }
    const local = await io.get(row.collection, row.id);
    if (shouldApplyRemote(local, row)) {
      await io.put(row.collection, rowToRecord(row));
      applied++;
    } else skipped++;
  }
  const result = { applied, skipped };
  // unknown/unknownMs ไม่ enumerable: ผลลัพธ์ที่เทสต์/ผู้เรียกเดิมเทียบ ({applied, skipped}) ไม่เปลี่ยน แต่ sync.js อ่านได้
  Object.defineProperties(result, { unknown: { value: unknown }, unknownMs: { value: unknownMs } });
  return result;
}
