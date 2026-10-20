// "เครื่อง" จำลองสำหรับทดสอบซิงก์ใน Node: ที่เก็บข้อมูลในหน่วยความจำที่ทำตามสัญญาเดียวกับ syncStore ใน js/db.js
// (dirty ติดตามด้วย tok, applyRemote ใช้ mergeRows ตัวจริงจาก js/lww.js)
// ส่วนที่เป็น IndexedDB จริง ตรวจในการทดสอบเบราว์เซอร์แยกต่างหาก

import { createAuth } from '../js/auth.js';
import { createSync } from '../js/sync.js';
import { mergeRows, toMs } from '../js/lww.js';
import { TABLES } from '../js/constants.js';

export function createClock(startIso = '2026-10-18T10:00:00.000Z') {
  let t = Date.parse(startIso);
  return { now: () => t, tick: (ms = 1000) => (t += ms), set: (v) => (t = v) };
}

export function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

/** onSynced: ตะขอหลังซิงก์สำเร็จ (ส่งต่อให้ createSync) — ไม่ส่ง = ทำงานเหมือนเดิมทุกอย่าง */
export function createDevice({ mock, clock, config, name = 'device', fetchWrap, onSynced }) {
  const tables = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
  const dirty = new Map();
  const meta = new Map();
  const storage = memStorage();
  const device = { name, online: true };
  let tokN = 0;
  const iso = () => new Date(clock.now()).toISOString();
  const bump = (prev) => new Date(Math.max(clock.now(), toMs(prev) + 1)).toISOString();
  const mark = (table, id) => dirty.set(`${table}:${id}`, { key: `${table}:${id}`, table, id, tok: ++tokN });

  const store = {
    getMeta: async (k) => (meta.has(k) ? meta.get(k) : null),
    setMeta: async (k, v) => void meta.set(k, v),
    async listDirty(limit) {
      return [...dirty.values()]
        .slice(0, limit)
        .map((e) => ({ ...e, record: structuredClone(tables[e.table].get(e.id)) }))
        .filter((e) => e.record);
    },
    async clearDirty(entries) {
      for (const e of entries) if (dirty.get(e.key)?.tok === e.tok) dirty.delete(e.key);
    },
    countDirty: async () => dirty.size,
    async markAllDirty() {
      for (const t of TABLES) for (const id of tables[t].keys()) mark(t, id);
    },
    applyRemote: (rows) =>
      mergeRows(rows, {
        tables: TABLES,
        get: async (t, id) => tables[t].get(id),
        put: async (t, rec) => {
          tables[t].set(rec.id, structuredClone(rec));
          dirty.delete(`${t}:${rec.id}`);
        },
      }),
  };

  const f = fetchWrap ? fetchWrap(mock.fetch, device) : mock.fetch;
  const auth = createAuth({ config, fetchFn: f, storage, now: clock.now });
  const timers = [];
  const sync = createSync({
    auth,
    store,
    config,
    fetchFn: f,
    now: clock.now,
    isOnline: () => device.online,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => (t.cleared = true),
    onSynced: onSynced ? () => onSynced(device) : undefined,
  });

  Object.assign(device, {
    auth,
    sync,
    store,
    storage,
    timers,
    tables,
    dirty,
    meta,
    create(table, fields) {
      const rec = { id: crypto.randomUUID(), ...fields, created_at: iso(), updated_at: iso(), deleted: false };
      tables[table].set(rec.id, rec);
      mark(table, rec.id);
      sync.schedule();
      return rec;
    },
    update(table, id, patch) {
      const cur = tables[table].get(id);
      const next = { ...cur, ...patch, updated_at: bump(cur.updated_at) };
      tables[table].set(id, next);
      mark(table, id);
      sync.schedule();
      return next;
    },
    remove: (table, id) => device.update(table, id, { deleted: true }),
    get: (table, id) => tables[table].get(id),
    snapshot(table) {
      return Object.fromEntries([...tables[table]].map(([id, r]) => [id, r]));
    },
    async login(email, password) {
      await auth.signIn(email, password);
      await sync.init();
    },
  });
  return device;
}

/** ผู้ใช้ที่ยืนยันอีเมลแล้ว */
export async function makeUser(mock, email = 'a@example.com', password = 'secret12') {
  await createAuth({ config: { url: mock.url, publishableKey: mock.key }, fetchFn: mock.fetch, storage: memStorage() }).signUp(email, password);
  mock.confirmEmail(email);
  return { email, password };
}
