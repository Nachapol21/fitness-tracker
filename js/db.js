// ชั้นข้อมูลเดียวของแอป: อ่าน/เขียน IndexedDB ทั้งหมดผ่านไฟล์นี้เท่านั้น
//
// กติกาของทุกเรคคอร์ด (ใช้ซิงก์กับ Supabase ใน js/sync.js):
//   id          UUID
//   created_at  ISO-8601 (UTC)
//   updated_at  ISO-8601 (UTC) อัปเดตทุกครั้งที่แก้ — ใช้ตัดสินว่าฝั่งไหนใหม่กว่าตอนรวมข้อมูล
//   deleted     true = ลบแบบ soft delete (เรคคอร์ดยังอยู่เพื่อให้ซิงก์รู้ว่าถูกลบ)
// ตาราง 'meta' และ 'dirty' เป็นค่าเฉพาะเครื่อง (ไม่ซิงก์ ไม่ export)
//   dirty = รายการที่เขียนในเครื่องแล้วแต่ยังไม่ได้ push ขึ้นเซิร์ฟเวอร์ (เขียนใน transaction เดียวกับตัวข้อมูล)

import { DATA_FORMAT, DATA_VERSION, DEFAULT_PROFILE, PROFILE_ID, TABLES } from './constants.js';
import { SEED_VERSION, seedExercises, seedFoods } from './seed.js';
import { mergeRows, toMs } from './lww.js';
import { isDateStr } from './dates.js';

const DB_NAME = 'fitness-tracker';
const DB_VERSION = 2;
const INDEXES = {
  body_logs: ['date'],
  sessions: ['date'],
  sets: ['session_id', 'exercise_id'],
  cardio: ['session_id', 'date'],
  food_logs: ['date'],
  water_logs: ['date'],
};

// ---------- พื้นฐาน ----------

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // เผื่อเปิดผ่าน http บน LAN (ไม่ใช่ secure context)
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const nowIso = () => new Date().toISOString();
const dirtyEntry = (table, id) => ({ key: `${table}:${id}`, table, id, tok: uuid() });
/** เวลา updated_at ใหม่ที่ต้องมากกว่าค่าเดิมเสมอ (กันนาฬิกาเพี้ยนทำให้การแก้ไขแพ้ LWW) */
const bumpIso = (prev) => new Date(Math.max(Date.now(), toMs(prev) + 1)).toISOString();

let dbPromise = null;
export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const t of TABLES) {
          if (db.objectStoreNames.contains(t)) continue;
          const st = db.createObjectStore(t, { keyPath: 'id' });
          for (const idx of INDEXES[t] || []) st.createIndex(idx, idx);
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('dirty')) db.createObjectStore('dirty', { keyPath: 'key' }); // v2: คิวรอ push
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('ฐานข้อมูลถูกเปิดค้างอยู่ในแท็บอื่น ปิดแท็บเก่าแล้วลองใหม่'));
    });
  }
  return dbPromise;
}

const reqP = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const txDone = (t) =>
  new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });

async function withStores(names, mode, fn) {
  const db = await openDB();
  const t = db.transaction(names, mode);
  const done = txDone(t); // ผูก handler ก่อนเริ่มงาน กันพลาด event
  let out;
  try {
    out = await fn(...[].concat(names).map((n) => t.objectStore(n)));
  } catch (e) {
    done.catch(() => {});
    try {
      t.abort();
    } catch {
      /* transaction จบไปแล้ว */
    }
    throw e;
  }
  await done;
  return out;
}

// ---------- การแจ้งเปลี่ยนแปลง (ใช้ต่อยอดซิงก์) ----------

const listeners = new Set();
/** ลงทะเบียนรับแจ้งเมื่อมีการเขียนข้อมูล: fn({table}) คืนฟังก์ชันยกเลิก */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = (table) => listeners.forEach((fn) => fn({ table }));

// ---------- CRUD ทั่วไป ----------

export async function create(table, fields) {
  const t = nowIso();
  const rec = { ...fields, id: fields.id || uuid(), created_at: t, updated_at: t, deleted: false };
  await withStores([table, 'dirty'], 'readwrite', async (st, dt) => {
    await reqP(st.put(rec));
    await reqP(dt.put(dirtyEntry(table, rec.id)));
  });
  notify(table);
  return rec;
}

export async function update(table, id, patch) {
  const rec = await withStores([table, 'dirty'], 'readwrite', async (st, dt) => {
    const cur = await reqP(st.get(id));
    if (!cur) throw new Error(`ไม่พบ ${table}/${id}`);
    const next = { ...cur, ...patch, id: cur.id, created_at: cur.created_at, updated_at: bumpIso(cur.updated_at) };
    await reqP(st.put(next));
    await reqP(dt.put(dirtyEntry(table, id)));
    return next;
  });
  notify(table);
  return rec;
}

/** soft delete: ไม่ลบจริง แค่ตั้ง deleted=true */
export const remove = (table, id) => update(table, id, { deleted: true });

export async function get(table, id) {
  const rec = await withStores(table, 'readonly', (st) => reqP(st.get(id)));
  return rec && !rec.deleted ? rec : null;
}

const alive = (rows) => rows.filter((r) => !r.deleted);

export async function list(table, { includeDeleted = false } = {}) {
  const rows = await withStores(table, 'readonly', (st) => reqP(st.getAll()));
  return includeDeleted ? rows : alive(rows);
}

export async function listByIndex(table, index, value, { includeDeleted = false } = {}) {
  const rows = await withStores(table, 'readonly', (st) => reqP(st.index(index).getAll(value)));
  return includeDeleted ? rows : alive(rows);
}

export async function listDateRange(table, from, to) {
  const rows = await withStores(table, 'readonly', (st) => reqP(st.index('date').getAll(IDBKeyRange.bound(from, to))));
  return alive(rows);
}

/** โหลดทุกตารางที่ยังไม่ถูกลบ ใช้กับหน้าวิเคราะห์/สรุป */
export async function loadAll() {
  const db = await openDB();
  const t = db.transaction(TABLES, 'readonly');
  const done = txDone(t);
  const entries = await Promise.all(TABLES.map(async (n) => [n, alive(await reqP(t.objectStore(n).getAll()))]));
  await done;
  return Object.fromEntries(entries);
}

// ---------- meta (เฉพาะเครื่อง) ----------

export async function getMeta(key, fallback = null) {
  const r = await withStores('meta', 'readonly', (st) => reqP(st.get(key)));
  return r ? r.value : fallback;
}
export async function setMeta(key, value) {
  await withStores('meta', 'readwrite', (st) => reqP(st.put({ key, value })));
}

// ---------- โปรไฟล์ (มีเรคคอร์ดเดียว id คงที่) ----------

export async function getProfile() {
  const r = await get('profile', PROFILE_ID);
  return { ...DEFAULT_PROFILE, ...(r || {}) };
}

export async function saveProfile(patch) {
  const existing = await withStores('profile', 'readonly', (st) => reqP(st.get(PROFILE_ID)));
  if (existing) return update('profile', PROFILE_ID, { ...patch, deleted: false });
  return create('profile', { ...DEFAULT_PROFILE, ...patch, id: PROFILE_ID });
}

// ---------- งานเฉพาะโดเมน ----------

/** ลบครั้งที่ฝึก พร้อมเซ็ตและคาร์ดิโอของครั้งนั้น (soft delete ทั้งหมด) */
export async function deleteSession(id) {
  const [sets, cardio] = await Promise.all([
    listByIndex('sets', 'session_id', id),
    listByIndex('cardio', 'session_id', id),
  ]);
  await Promise.all([...sets.map((s) => remove('sets', s.id)), ...cardio.map((c) => remove('cardio', c.id))]);
  await remove('sessions', id);
}

/** บันทึกร่างกายของวันนั้น (1 เรคคอร์ดต่อวัน) */
export async function saveBodyLog(date, fields) {
  const existing = (await listByIndex('body_logs', 'date', date))[0];
  if (existing) return update('body_logs', existing.id, fields);
  return create('body_logs', { date, weight_kg: null, waist_cm: null, steps: null, note: '', ...fields });
}

// ---------- seed ----------

/** ใส่ท่าและอาหารตั้งต้นครั้งแรก (ไม่เขียนทับของที่มีอยู่ รวมถึงของที่ผู้ใช้ลบไปแล้ว) */
export async function ensureSeed() {
  const done = await getMeta('seed_version', 0);
  if (done >= SEED_VERSION) return false;
  for (const [table, rows] of [['exercises', seedExercises()], ['foods', seedFoods()]]) {
    await withStores(table, 'readwrite', async (st) => {
      for (const r of rows) {
        const cur = await reqP(st.get(r.id));
        if (!cur) await reqP(st.put(r));
      }
    });
  }
  await setMeta('seed_version', SEED_VERSION);
  if (!(await getMeta('first_run_at'))) await setMeta('first_run_at', nowIso());
  return true;
}

// ---------- export / import ----------

/** ข้อมูลทั้งหมด (รวมรายการที่ soft delete เพื่อให้ซิงก์รู้) */
export async function exportAll() {
  const db = await openDB();
  const t = db.transaction(TABLES, 'readonly');
  const done = txDone(t);
  const entries = await Promise.all(TABLES.map(async (n) => [n, await reqP(t.objectStore(n).getAll())]));
  await done;
  return {
    format: DATA_FORMAT,
    version: DATA_VERSION,
    exported_at: nowIso(),
    tables: Object.fromEntries(entries),
  };
}

export class ImportError extends Error {}

/** ตรวจค่าที่ทำให้หน้าจอ/ซิงก์พังถ้าเพี้ยน: id, date (YYYY-MM-DD จริง), ฟิลด์ *_at (ต้องอ่านเป็นเวลาได้) — ผิดแถวเดียวปฏิเสธทั้งไฟล์ */
function checkRow(table, no, r) {
  const where = `ตาราง ${table} แถวที่ ${no} (id ${JSON.stringify(r.id).slice(0, 60)})`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(r.id)) throw new ImportError(`${where}: id ต้องเป็นตัวอักษร/ตัวเลข/-/_ ไม่เกิน 64 ตัว (UUID ได้)`);
  if ('date' in r && r.date !== undefined) {
    const t = isDateStr(r.date) ? Date.parse(`${r.date}T00:00:00Z`) : NaN;
    const ok = !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === r.date;
    if (!ok) throw new ImportError(`${where}: ฟิลด์ date ต้องเป็นวันที่รูปแบบ YYYY-MM-DD แต่พบ ${JSON.stringify(r.date)?.slice(0, 40)}`);
  }
  for (const [k, v] of Object.entries(r)) {
    if (!k.endsWith('_at') || v === null || v === undefined) continue;
    if (typeof v !== 'string' || toMs(v) <= 0) throw new ImportError(`${where}: ฟิลด์ ${k} อ่านเป็นเวลาไม่ได้ (พบ ${JSON.stringify(v)?.slice(0, 40)})`);
  }
}

/** ตรวจโครงสร้างไฟล์ก่อนนำเข้า คืนข้อมูลที่ผ่านการปรับรูปแล้ว */
export function validateImport(data) {
  if (!data || typeof data !== 'object' || data.format !== DATA_FORMAT) {
    throw new ImportError('ไฟล์นี้ไม่ใช่ไฟล์สำรองของแอปนี้ (format ไม่ตรง)');
  }
  if (typeof data.version !== 'number' || data.version > DATA_VERSION) {
    throw new ImportError(`ไฟล์ใหม่กว่าแอปที่ใช้อยู่ (version ${data.version}) กรุณาอัปเดตแอปก่อน`);
  }
  if (!data.tables || typeof data.tables !== 'object') throw new ImportError('ไม่พบข้อมูล tables ในไฟล์');
  const out = {};
  const t0 = nowIso();
  for (const table of TABLES) {
    const rows = data.tables[table];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new ImportError(`ตาราง ${table} ต้องเป็น array`);
    out[table] = rows.map((r, i) => {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) {
        throw new ImportError(`ตาราง ${table} แถวที่ ${i + 1} ไม่มี id`);
      }
      checkRow(table, i + 1, r);
      return { ...r, created_at: r.created_at || t0, updated_at: r.updated_at || r.created_at || t0, deleted: !!r.deleted };
    });
  }
  return out;
}

/**
 * นำเข้าแบบรวม (merge): ถ้า id ซ้ำ ฝั่งที่ updated_at ใหม่กว่าชนะ
 * replace=true: ข้อมูลในเครื่องที่ไม่อยู่ในไฟล์จะถูก soft delete (ไม่ลบจริง เพื่อให้ซิงก์รู้ว่าถูกลบ)
 *   และรายการที่อยู่ในไฟล์จะใช้ตามไฟล์เสมอ (ถ้าในเครื่องใหม่กว่า จะประทับเวลาใหม่เพื่อให้ฉบับที่กู้คืนชนะตอนซิงก์)
 * ทุกรายการที่เขียนจะถูกทำเครื่องหมาย dirty เพื่อส่งขึ้นเซิร์ฟเวอร์ตอนซิงก์
 * คืนจำนวนที่เพิ่ม/อัปเดต/ข้าม แยกตามตาราง
 */
export async function importData(data, { replace = false } = {}) {
  const tables = validateImport(data);
  if (replace) {
    for (const table of TABLES) {
      const keep = new Set((tables[table] || []).map((r) => r.id));
      await withStores([table, 'dirty'], 'readwrite', async (st, dt) => {
        for (const cur of await reqP(st.getAll())) {
          if (cur.deleted || keep.has(cur.id)) continue;
          await reqP(st.put({ ...cur, deleted: true, updated_at: bumpIso(cur.updated_at) }));
          await reqP(dt.put(dirtyEntry(table, cur.id)));
        }
      });
      notify(table);
    }
  }
  const stats = {};
  for (const [table, rows] of Object.entries(tables)) {
    const s = (stats[table] = { added: 0, updated: 0, skipped: 0 });
    await withStores([table, 'dirty'], 'readwrite', async (st, dt) => {
      for (const r of rows) {
        const cur = await reqP(st.get(r.id));
        let put = null;
        if (!cur) {
          put = r;
          s.added++;
        } else if (toMs(r.updated_at) > toMs(cur.updated_at)) {
          put = r;
          s.updated++;
        } else if (replace && toMs(r.updated_at) < toMs(cur.updated_at)) {
          put = { ...r, updated_at: bumpIso(cur.updated_at) };
          s.updated++;
        } else s.skipped++;
        if (put) {
          await reqP(st.put(put));
          await reqP(dt.put(dirtyEntry(table, r.id)));
        }
      }
    });
    notify(table);
  }
  // นำเข้าแล้วถือว่ามีคลังท่า/อาหารของผู้ใช้แล้ว ไม่ต้อง seed ซ้ำ
  await setMeta('seed_version', SEED_VERSION);
  if (!(await getMeta('first_run_at'))) await setMeta('first_run_at', nowIso());
  return stats;
}

export async function clearAll({ keepMeta = false } = {}) {
  const names = keepMeta ? [...TABLES, 'dirty'] : [...TABLES, 'dirty', 'meta'];
  await withStores(names, 'readwrite', (...stores) => Promise.all(stores.map((st) => reqP(st.clear()))));
  TABLES.forEach(notify);
}

// ---------- จุดต่อสำหรับซิงก์ (ใช้โดย js/sync.js ผ่าน syncStore) ----------

/** รายการที่รอ push: [{key, table, id, tok, record}] (ตัดรายการที่เรคคอร์ดหายไปแล้วทิ้ง) */
export async function listDirty(limit = 500) {
  for (;;) {
    const db = await openDB();
    const t = db.transaction([...TABLES, 'dirty'], 'readonly');
    const done = txDone(t);
    const entries = await reqP(t.objectStore('dirty').getAll(undefined, limit));
    const out = [];
    const orphans = [];
    for (const e of entries) {
      const record = await reqP(t.objectStore(e.table).get(e.id));
      if (record) out.push({ ...e, record });
      else orphans.push(e);
    }
    await done;
    if (orphans.length) await clearDirty(orphans);
    if (out.length || !entries.length) return out;
  }
}

/** เคลียร์สถานะ dirty เฉพาะรายการที่ไม่ถูกแก้ซ้ำระหว่างที่กำลังส่ง (เทียบ tok) */
export async function clearDirty(entries) {
  await withStores('dirty', 'readwrite', async (dt) => {
    for (const e of entries) {
      const cur = await reqP(dt.get(e.key));
      if (cur && cur.tok === e.tok) await reqP(dt.delete(e.key));
    }
  });
}

export const countDirty = () => withStores('dirty', 'readonly', (dt) => reqP(dt.count()));

/** ซิงก์ครั้งแรกบนเครื่องที่มีข้อมูลอยู่แล้ว: ทำเครื่องหมายทุกเรคคอร์ด (รวมที่ soft delete) ว่าต้องส่ง */
export async function markAllDirty() {
  const db = await openDB();
  const t = db.transaction([...TABLES, 'dirty'], 'readwrite');
  const done = txDone(t);
  const dt = t.objectStore('dirty');
  for (const table of TABLES) {
    for (const id of await reqP(t.objectStore(table).getAllKeys())) await reqP(dt.put(dirtyEntry(table, id)));
  }
  await done;
}

/**
 * รวมแถวที่ดึงมาจากเซิร์ฟเวอร์ (LWW: ใช้ของเซิร์ฟเวอร์เมื่อ client_updated_at ใหม่กว่าในเครื่อง)
 * เขียนตรงๆ โดยไม่แตะ updated_at และไม่ทำให้เป็น dirty และไม่เรียก notify (กันซิงก์วนซ้ำ)
 */
export async function applyRemote(rows) {
  const db = await openDB();
  const t = db.transaction([...TABLES, 'dirty'], 'readwrite');
  const done = txDone(t);
  const dt = t.objectStore('dirty');
  let result;
  try {
    result = await mergeRows(rows, {
      tables: TABLES,
      get: (table, id) => reqP(t.objectStore(table).get(id)),
      put: async (table, rec) => {
        await reqP(t.objectStore(table).put(rec));
        await reqP(dt.delete(`${table}:${rec.id}`)); // ฉบับในเครื่องที่รอส่งเก่ากว่า ไม่ต้องส่งแล้ว
      },
    });
  } catch (e) {
    done.catch(() => {});
    try {
      t.abort();
    } catch {
      /* จบไปแล้ว */
    }
    throw e;
  }
  await done;
  return result;
}

/** ตัวเชื่อมที่ js/sync.js คาดหวัง */
export const syncStore = { getMeta, setMeta, listDirty, clearDirty, countDirty, markAllDirty, applyRemote };
