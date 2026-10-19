// ซิงก์ระหว่างเครื่องกับ Supabase (PostgREST ตาราง public.sync_records) แบบ local-first ด้วย fetch ล้วน
//
// ลำดับต่อรอบ: ตรวจเจ้าของข้อมูล → push รายการ dirty (ชุดละ ≤500 แถว) → pull แถวที่ใหม่กว่า cursor (ชุดละ 1000 วนจนหมด)
// การแก้ขัดแย้ง: last-write-wins ต่อเรคคอร์ด เทียบ updated_at (client_updated_at) — เซิร์ฟเวอร์ข้ามแถวที่เก่ากว่า
// ตอนรวมที่ pull มาจะไม่แตะ updated_at และไม่ทำให้เป็น dirty (ดู lww.js) จึงไม่วนซ้ำ
//
// ไฟล์นี้ไม่แตะ DOM/IndexedDB โดยตรง: รับ `store` (ดู syncStore ใน db.js) และ `auth` (ดู auth.js) เข้ามา ทดสอบใน Node ได้

import { AuthError } from './auth.js';
import { recordToRow, toMs } from './lww.js';
import { SYNC_TABLES_VERSION } from './constants.js';

export const PUSH_BATCH = 500;
export const PULL_LIMIT = 1000;
export const CURSOR_OVERLAP_MS = 3000; // ถอย cursor เล็กน้อยกัน transaction ที่ commit ช้ากว่าเวลาของมัน (รวมซ้ำปลอดภัย)
const EPOCH = '1970-01-01T00:00:00.000Z';
const REJECTED_KEY = 'sync_rejected';
const MAX_REJECTED_PER_RUN = 25;

export class SyncError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.status = status;
  }
}

function describeHttp(status, body) {
  const detail = body?.message || body?.error_description || body?.msg || '';
  if (status === 401 || status === 403) return ['unauthorized', 'เซิร์ฟเวอร์ไม่อนุญาต (สิทธิ์ไม่ถูกต้อง) ลองออกจากระบบแล้วล็อกอินใหม่'];
  if (status === 404) return ['not_found', 'ไม่พบตาราง sync_records บนเซิร์ฟเวอร์'];
  if (status === 429) return ['rate_limit', 'ส่งคำขอถี่เกินไป รอสักครู่แล้วระบบจะลองใหม่'];
  if (status >= 500) return ['server', 'เซิร์ฟเวอร์ขัดข้องชั่วคราว ระบบจะลองใหม่'];
  return ['rejected', `เซิร์ฟเวอร์ปฏิเสธข้อมูล (${status})${detail ? `: ${detail}` : ''}`];
}

export function createSync({
  auth,
  store,
  config,
  fetchFn,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  isOnline = () => globalThis.navigator?.onLine !== false,
  debounceMs = 5000,
}) {
  const doFetch = fetchFn || ((...a) => fetch(...a));
  const listeners = new Set();
  const appliedListeners = new Set();
  let running = null;
  let rerun = false;
  let timer = null;
  let status = { state: 'signed_out', pending: 0, rejected: 0, lastSyncAt: null, error: null, errorCode: null, user: null, lastResult: null };

  function setStatus(patch) {
    status = { ...status, ...patch };
    listeners.forEach((fn) => fn(status));
  }

  async function refreshPending() {
    try {
      setStatus({ pending: await store.countDirty() });
    } catch {
      /* ไม่สำคัญ */
    }
  }

  async function init() {
    const session = auth.getSession();
    setStatus({
      state: session ? 'idle' : 'signed_out',
      user: session?.user || null,
      lastSyncAt: await store.getMeta('sync_last_at'),
      pending: await store.countDirty(),
      rejected: (await getRejected()).length,
    });
  }

  // ---------- HTTP ----------

  async function rawRequest(path, init, token) {
    try {
      return await doFetch(`${config.url}${path}`, {
        ...init,
        headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
    } catch {
      throw new SyncError('network', 'เชื่อมต่ออินเทอร์เน็ตไม่ได้');
    }
  }

  /** ส่ง request พร้อม token; ถ้าได้ 401 ต่ออายุ token แล้วลองอีกครั้งเดียว */
  async function request(path, init) {
    let res = await rawRequest(path, init, await auth.getAccessToken());
    if (res.status === 401) {
      await auth.refresh(true);
      res = await rawRequest(path, init, await auth.getAccessToken());
    }
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* ว่าง */
      }
      const [code, message] = describeHttp(res.status, body);
      throw new SyncError(code, message, res.status);
    }
    return res;
  }

  // ---------- ขั้นตอนหลัก ----------

  async function ensureOwner(user) {
    const owner = await store.getMeta('sync_owner');
    if (!owner) {
      // ครั้งแรกของบัญชีนี้บนเครื่องนี้: ส่งทุกอย่างที่มี แล้วค่อยดึงทุกอย่าง (รวมสองทาง)
      await store.markAllDirty();
      await store.setMeta('sync_owner', user.id);
    } else if (owner !== user.id) {
      throw new SyncError('owner_mismatch', 'ข้อมูลในเครื่องนี้เป็นของบัญชีอื่น — ล้างข้อมูลในเครื่องก่อนจึงจะซิงก์กับบัญชีนี้ได้');
    }
  }

  // ---------- รายการที่ส่งไม่ได้ (เซิร์ฟเวอร์ปฏิเสธถาวร) ----------
  // เก็บใน meta ของเครื่อง: [{key, table, id, reason, at}] ไม่ถูกนับเป็น "รอส่ง" และไม่ขวางรายการอื่น
  // ถ้าผู้ใช้แก้รายการนั้นอีก (เข้าคิวใหม่) แล้วส่งสำเร็จ จะถูกลบออกจากรายการนี้เอง
  async function getRejected() {
    const v = await store.getMeta(REJECTED_KEY);
    return Array.isArray(v) ? v : [];
  }
  async function markRejected(entry, err) {
    const list = (await getRejected()).filter((x) => x.key !== entry.key);
    list.push({ key: entry.key, table: entry.table, id: entry.id, reason: err.message || String(err), at: new Date(now()).toISOString() });
    await store.setMeta(REJECTED_KEY, list);
    await store.clearDirty([entry]);
  }
  async function unmarkRejected(entries) {
    const list = await getRejected();
    if (!list.length) return;
    const sent = new Set(entries.map((e) => e.key));
    const rest = list.filter((x) => !sent.has(x.key));
    if (rest.length !== list.length) await store.setMeta(REJECTED_KEY, rest);
  }
  /** 4xx ที่เกิดจากข้อมูลของแถวเอง (แยกแถวเสียได้) — 401/403/404/429 เป็นเรื่องของ session/ระบบ ไม่ใช่แถวเดียว */
  const isRowFault = (e) => e instanceof SyncError && e.status >= 400 && e.status < 500 && ![401, 403, 404, 429].includes(e.status);

  async function push(userId) {
    let pushed = 0;
    let rejected = 0;
    const send = async (entries) => {
      const rows = entries.map((e) => recordToRow(e.table, e.record, userId));
      try {
        await request('/rest/v1/sync_records?on_conflict=user_id,id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        });
      } catch (e) {
        if (!isRowFault(e)) throw e;
        // ชุดนี้มีแถวที่เซิร์ฟเวอร์รับไม่ได้ → แบ่งครึ่งส่งใหม่จนเจอแถวเสีย แล้วกันออกจากคิว
        if (entries.length === 1) {
          if (++rejected > MAX_REJECTED_PER_RUN) throw e; // เสียเยอะผิดปกติ น่าจะเป็นปัญหาระบบ ไม่ใช่รายแถว
          await markRejected(entries[0], e);
          return;
        }
        const mid = Math.ceil(entries.length / 2);
        await send(entries.slice(0, mid));
        await send(entries.slice(mid));
        return;
      }
      await store.clearDirty(entries);
      await unmarkRejected(entries);
      pushed += entries.length;
    };
    for (;;) {
      const entries = await store.listDirty(PUSH_BATCH);
      if (!entries.length) return { pushed, rejected };
      await send(entries);
    }
  }

  /** ดึงแถวที่เซิร์ฟเวอร์เปลี่ยนตั้งแต่ cursor ครั้งละ PULL_LIMIT แบบ keyset (server_updated_at, id) ไม่ใช้ offset จึงไม่ตกหล่นถ้ามีการแก้ระหว่างดึง */
  async function pull() {
    const cursor = (await store.getMeta('sync_cursor')) || EPOCH;
    let after = null; // แถวสุดท้ายของหน้าก่อนหน้า { ts: ข้อความจากเซิร์ฟเวอร์ตามเดิม (มีไมโครวินาที), id }
    let maxMs = -1;
    let minUnknownMs = Infinity; // แถวของ collection ที่ไม่รู้จัก: ห้ามเลื่อน cursor ผ่านไป
    let unknown = 0;
    let fetched = 0;
    let applied = 0;
    for (;;) {
      // ค่าที่ใส่ใน URL ต้อง encode ไม่งั้น "+" ใน "+00:00" จะกลายเป็นช่องว่าง
      let path = `/rest/v1/sync_records?select=*&server_updated_at=gte.${encodeURIComponent(cursor)}`;
      if (after) {
        const ts = encodeURIComponent(after.ts);
        path += `&or=(server_updated_at.gt.${ts},and(server_updated_at.eq.${ts},id.gt.${encodeURIComponent(after.id)}))`;
      }
      path += `&order=server_updated_at.asc,id.asc&limit=${PULL_LIMIT}`;
      const rows = await (await request(path, { method: 'GET' })).json();
      if (!Array.isArray(rows)) throw new SyncError('bad_response', 'เซิร์ฟเวอร์ตอบกลับในรูปแบบที่ไม่รู้จัก');
      const r = await store.applyRemote(rows);
      applied += r.applied;
      if (r.unknown) {
        unknown += r.unknown;
        minUnknownMs = Math.min(minUnknownMs, r.unknownMs || 0 || Infinity);
      }
      for (const row of rows) maxMs = Math.max(maxMs, toMs(row.server_updated_at));
      fetched += rows.length;
      if (rows.length < PULL_LIMIT) break;
      const last = rows[rows.length - 1];
      if (typeof last.server_updated_at !== 'string' || typeof last.id !== 'string') throw new SyncError('bad_response', 'เซิร์ฟเวอร์ตอบกลับในรูปแบบที่ไม่รู้จัก');
      after = { ts: last.server_updated_at, id: last.id };
    }
    if (maxMs >= 0) {
      const bound = Math.min(maxMs, minUnknownMs); // เจอแถวที่ไม่รู้จัก → cursor หยุดก่อนแถวนั้น พออัปเกรดแล้วจะได้แถวนั้นมา
      const next = new Date(bound - CURSOR_OVERLAP_MS).toISOString();
      if (toMs(next) > toMs(cursor)) await store.setMeta('sync_cursor', next);
    }
    return { fetched, applied, unknown };
  }

  function handleError(e) {
    if (e instanceof AuthError && (e.code === 'session_expired' || e.code === 'no_session')) {
      setStatus({ state: 'signed_out', user: null, error: e.message, errorCode: e.code });
    } else if ((e instanceof AuthError || e instanceof SyncError) && e.code === 'network') {
      setStatus({ state: 'offline', error: null, errorCode: null });
    } else {
      setStatus({ state: 'error', error: e.message || String(e), errorCode: e.code || 'unknown' });
    }
  }

  async function runOnce() {
    const session = auth.getSession();
    if (!session) {
      setStatus({ state: 'signed_out', user: null });
      return;
    }
    setStatus({ user: session.user });
    if (!isOnline()) {
      setStatus({ state: 'offline', error: null, errorCode: null });
      await refreshPending();
      return;
    }
    setStatus({ state: 'syncing', error: null, errorCode: null });
    try {
      await ensureOwner(session.user);
      const { pushed, rejected } = await push(session.user.id);
      // เครื่องที่ซิงก์มาก่อนมี collection ใหม่ (รุ่นเก่าข้ามแถวแล้วเลื่อน cursor ไปแล้ว): ดึงใหม่จาก epoch หนึ่งครั้ง
      if ((Number(await store.getMeta('sync_tables_version')) || 0) < SYNC_TABLES_VERSION) await store.setMeta('sync_cursor', null);
      const pulled = await pull();
      await store.setMeta('sync_tables_version', SYNC_TABLES_VERSION);
      const at = new Date(now()).toISOString();
      await store.setMeta('sync_last_at', at);
      setStatus({ state: 'idle', lastSyncAt: at, pending: await store.countDirty(), error: null, errorCode: null, rejected: (await getRejected()).length, lastResult: { pushed, rejected, ...pulled } });
      if (pulled.applied > 0) appliedListeners.forEach((fn) => fn(pulled.applied));
    } catch (e) {
      handleError(e);
      await refreshPending();
    }
  }

  /** ซิงก์ตอนนี้ ถ้ากำลังซิงก์อยู่จะรอรอบนั้นแล้วรันซ้ำอีกรอบเพื่อเก็บของที่เขียนเพิ่มระหว่างทาง */
  function sync() {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await runOnce();
        } while (rerun && status.state === 'idle');
      } finally {
        running = null;
      }
      return status;
    })();
    return running;
  }

  /** เรียกหลังเขียนข้อมูล: นับรายการรอส่ง แล้วซิงก์ภายใน debounceMs (ไม่ซิงก์ถ้ายังไม่ล็อกอิน) */
  function schedule() {
    if (!auth.getSession()) return;
    refreshPending();
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      sync();
    }, debounceMs);
  }

  // ล็อกอิน/ออกจากระบบ (รวมถึงโดนเด้งเพราะ token ใช้ไม่ได้) → อัปเดตสถานะทันที
  auth.onChange?.((session) => {
    if (session) setStatus({ state: status.state === 'signed_out' ? 'idle' : status.state, user: session.user, error: null, errorCode: null });
    else setStatus({ state: 'signed_out', user: null });
  });

  return {
    init,
    sync,
    schedule,
    refreshPending,
    getStatus: () => status,
    getRejected,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onApplied(fn) {
      appliedListeners.add(fn);
      return () => appliedListeners.delete(fn);
    },
    isRunning: () => !!running,
  };
}
