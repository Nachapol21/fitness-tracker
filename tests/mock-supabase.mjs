// Supabase จำลอง (GoTrue + PostgREST เท่าที่แอปใช้) สำหรับทดสอบโดยไม่แตะเซิร์ฟเวอร์จริง
// ไม่มี import ของ Node จึงโหลดในเบราว์เซอร์ได้ด้วย (ใช้ในการทดสอบหน้าเว็บโดยครอบ window.fetch)
//
// จำลอง: apikey, ล็อกอิน/สมัคร/ต่ออายุ token (refresh token ใช้ได้ครั้งเดียว), RLS (เห็นเฉพาะแถวของตัวเอง, anon เข้าไม่ได้, ไม่มี DELETE),
//        trigger LWW (ข้ามแถวที่ client_updated_at เก่ากว่า) และ server_updated_at ที่เซิร์ฟเวอร์ตั้งเอง (มีไมโครวินาที)
//        PostgREST: on_conflict=user_id,id (PK ของเซิร์ฟเวอร์จริงคือ (user_id, id)) + Prefer merge-duplicates, filter gte, or(gt/eq+id.gt) แบบ keyset, order, limit, offset
// การพิมพ์ query แบบผิด (เช่นลืม encode เครื่องหมาย +) จะได้ 400 เหมือนของจริง

const json = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const MICRO = 417; // เศษไมโครวินาทีคงที่ ให้เห็นว่าเวลาจากเซิร์ฟเวอร์ละเอียดกว่าฝั่งเครื่อง

export function createMockSupabase({ url, key, ttlSec = 3600, clock = () => Date.now(), autoConfirm = false, signupsDisabled = false, strictlyIncreasing = true } = {}) {
  const users = new Map(); // email → {id,email,password,confirmed}
  const accessTokens = new Map(); // token → {userId, expMs, refresh}
  const refreshTokens = new Map(); // token → {userId, used}
  const records = new Map(); // `${user_id}:${id}` → row (PK คือ (user_id, id) เหมือนเซิร์ฟเวอร์จริง: คนละบัญชีมี id เดียวกันได้)
  const rkey = (userId, id) => `${userId}:${id}`;
  const calls = [];
  const injected = [];
  const stats = { pushCalls: 0, pullCalls: 0, maxBatch: 0, pushBatches: [], pullPages: [] };
  let offline = false;
  let seq = 0;
  let lastMs = 0;

  const newId = () => {
    const h = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`;
  };

  function stamp() {
    let ms = clock();
    if (strictlyIncreasing) ms = Math.max(ms, lastMs + 1);
    lastMs = Math.max(lastMs, ms);
    return { ms, us: ms * 1000 + MICRO };
  }
  const fmtServer = (us) => {
    const ms = Math.floor(us / 1000);
    return `${new Date(ms).toISOString().slice(0, 19)}.${String(ms % 1000).padStart(3, '0')}${String(us % 1000).padStart(3, '0')}+00:00`;
  };
  const fmtClient = (iso) => iso.replace('Z', '+00:00');

  /** อ่าน timestamptz ในรูปแบบที่ Postgres ยอมรับ → ไมโครวินาที (ไม่ผ่าน = null → 400) */
  function parseTs(v) {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(v || '');
    if (!m) return null;
    const base = Date.parse(`${m[1]}Z`);
    let off = 0;
    if (m[3] !== 'Z') off = (m[3][0] === '-' ? -1 : 1) * (Number(m[3].slice(1, 3)) * 60 + Number(m[3].slice(4, 6))) * 60000;
    return (base - off) * 1000 + Number((m[2] || '').padEnd(6, '0'));
  }

  function issue(user) {
    const n = ++seq;
    const access = `at-${n}`;
    const refresh = `rt-${n}`;
    const expMs = clock() + ttlSec * 1000;
    accessTokens.set(access, { userId: user.id, expMs, refresh });
    refreshTokens.set(refresh, { userId: user.id, used: false });
    return { access_token: access, token_type: 'bearer', expires_in: ttlSec, expires_at: Math.floor(expMs / 1000), refresh_token: refresh, user: { id: user.id, email: user.email } };
  }

  const authUser = (headers) => {
    const m = /^Bearer (.+)$/.exec(headers.authorization || '');
    if (!m) return { anon: true };
    const t = accessTokens.get(m[1]);
    if (!t) return { anon: true };
    if (t.expMs <= clock()) return { expired: true };
    return { userId: t.userId };
  };

  async function handle(path, query, method, headers, bodyText) {
    // ----- GoTrue -----
    if (path === '/auth/v1/signup' && method === 'POST') {
      const { email, password } = JSON.parse(bodyText || '{}');
      if (signupsDisabled) return json(422, { code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return json(400, { code: 400, error_code: 'validation_failed', msg: "Unable to validate email address: invalid format" });
      if ((password || '').length < 6) return json(422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
      let u = users.get(email);
      if (u) return json(200, { id: newId(), email, identities: [] }); // เหมือนของจริง: ไม่บอกว่าซ้ำ
      u = { id: newId(), email, password, confirmed: autoConfirm };
      users.set(email, u);
      return json(200, autoConfirm ? issue(u) : { id: u.id, email, aud: 'authenticated', confirmation_sent_at: new Date(clock()).toISOString() });
    }
    if (path === '/auth/v1/token' && method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      if (query.get('grant_type') === 'password') {
        const u = users.get(body.email);
        if (!u || u.password !== body.password) return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        if (!u.confirmed) return json(400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
        return json(200, issue(u));
      }
      if (query.get('grant_type') === 'refresh_token') {
        const r = refreshTokens.get(body.refresh_token);
        if (!r) return json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
        if (r.used) return json(400, { code: 400, error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' });
        r.used = true;
        return json(200, issue([...users.values()].find((x) => x.id === r.userId)));
      }
      return json(400, { code: 400, error_code: 'validation_failed', msg: 'unsupported grant_type' });
    }
    if (path === '/auth/v1/logout' && method === 'POST') {
      const who = authUser(headers);
      if (!who.userId) return json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
      const t = accessTokens.get(headers.authorization.slice(7));
      accessTokens.delete(headers.authorization.slice(7));
      refreshTokens.delete(t.refresh);
      return json(204);
    }

    // ----- PostgREST: sync_records -----
    if (path === '/rest/v1/sync_records') {
      const who = authUser(headers);
      if (who.expired) return json(401, { code: 'PGRST301', message: 'JWT expired' });
      if (!who.userId) return json(401, { code: '42501', message: 'permission denied for table sync_records' });

      if (method === 'POST') {
        stats.pushCalls++;
        const rows = JSON.parse(bodyText || 'null');
        if (!Array.isArray(rows)) return json(400, { code: 'PGRST102', message: 'Empty or invalid json' });
        stats.maxBatch = Math.max(stats.maxBatch, rows.length);
        stats.pushBatches.push(rows.length);
        if (query.get('on_conflict') !== 'user_id,id' || !/resolution=merge-duplicates/.test(headers.prefer || '')) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
        for (const r of rows) {
          if (typeof r.id !== 'string' || typeof r.collection !== 'string' || !r.data || typeof r.data !== 'object' || !r.client_updated_at) return json(400, { code: '23502', message: 'null value in column violates not-null constraint' });
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.id)) return json(400, { code: '22P02', message: `invalid input syntax for type uuid: "${r.id}"` });
          if (parseTs(fmtClient(String(r.client_updated_at))) === null) return json(400, { code: '22007', message: `invalid input syntax for type timestamp with time zone: "${r.client_updated_at}"` });
          if (r.user_id !== who.userId) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "sync_records"' });
        }
        const ts = stamp(); // ทั้งชุดได้เวลาเดียวกัน (เหมือน now() ใน statement เดียว)
        for (const r of rows) {
          const ex = records.get(rkey(who.userId, r.id));
          if (ex && parseTs(fmtClient(r.client_updated_at)) < parseTs(ex.client_updated_at)) continue; // trigger LWW: ข้ามแถวที่เก่ากว่าเงียบๆ
          records.set(rkey(who.userId, r.id), {
            id: r.id,
            user_id: who.userId,
            collection: r.collection,
            data: JSON.parse(JSON.stringify(r.data)),
            deleted: !!r.deleted,
            client_updated_at: fmtClient(r.client_updated_at),
            ts_us: ts.us,
          });
        }
        return json(201);
      }
      if (method === 'GET') {
        stats.pullCalls++;
        let rows = [...records.values()].filter((r) => r.user_id === who.userId);
        const gte = query.get('server_updated_at');
        if (gte !== null) {
          const m = /^gte\.(.+)$/.exec(gte);
          const us = m ? parseTs(m[1]) : null;
          if (us === null) return json(400, { code: '22007', message: `invalid input syntax for type timestamp with time zone: "${gte}"` });
          rows = rows.filter((r) => r.ts_us >= us);
        }
        const orq = query.get('or');
        if (orq !== null) {
          const m = /^\(server_updated_at\.gt\.([^,]+),and\(server_updated_at\.eq\.([^,]+),id\.gt\.([^,)]+)\)\)$/.exec(orq);
          const us = m ? parseTs(m[1]) : null;
          if (!m || us === null || parseTs(m[2]) !== us) return json(400, { code: 'PGRST100', message: `failed to parse logic tree ((${orq}))` });
          rows = rows.filter((r) => r.ts_us > us || (r.ts_us === us && r.id > m[3]));
        }
        const order = query.get('order') || 'server_updated_at.asc';
        if (!/^server_updated_at\.asc(,id\.asc)?$/.test(order)) return json(400, { code: 'PGRST100', message: 'unsupported order' });
        rows.sort((a, b) => a.ts_us - b.ts_us || (a.id < b.id ? -1 : 1));
        const limit = Math.min(Number(query.get('limit') || 1000), 1000); // เซิร์ฟเวอร์ตั้ง max-rows 1000
        const offset = Number(query.get('offset') || 0);
        rows = rows.slice(offset, offset + limit);
        stats.pullPages.push({ keyset: orq !== null, offset, count: rows.length });
        return json(
          200,
          rows.map((r) => ({
            id: r.id,
            user_id: r.user_id,
            collection: r.collection,
            data: JSON.parse(JSON.stringify(r.data)),
            deleted: r.deleted,
            client_updated_at: r.client_updated_at,
            server_updated_at: fmtServer(r.ts_us),
          }))
        );
      }
      return json(405, { message: 'method not allowed (ไม่มีสิทธิ์ DELETE/PATCH)' }); // DELETE ไม่มีสิทธิ์
    }
    return json(404, { message: 'not found' });
  }

  async function mockFetch(input, init = {}) {
    const href = typeof input === 'string' ? input : input.url;
    const u = new URL(href);
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    const method = (init.method || 'GET').toUpperCase();
    const call = { method, path: u.pathname, search: u.search, raw: href, headers, status: null, body: init.body };
    calls.push(call);
    if (offline) {
      call.status = 'network-error';
      throw new TypeError('Failed to fetch');
    }
    let res;
    const inj = injected.find((x) => x.times > 0 && x.match.test(`${method} ${u.pathname}${u.search}`));
    if (inj) {
      inj.times--;
      res = json(inj.status, inj.body);
    } else if (headers.apikey !== key) {
      res = json(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });
    } else {
      res = await handle(u.pathname, u.searchParams, method, headers, init.body);
    }
    call.status = res.status;
    return res;
  }

  return {
    fetch: mockFetch,
    url,
    key,
    calls,
    stats,
    records,
    users,
    accessTokens,
    refreshTokens,
    setOffline: (v) => {
      offline = !!v;
    },
    /** ทำให้ access token ทั้งหมดใช้ไม่ได้ฝั่งเซิร์ฟเวอร์ (ฝั่งเครื่องยังคิดว่าไม่หมดอายุ) */
    expireAccessTokens: () => accessTokens.forEach((t) => (t.expMs = 0)),
    revokeRefreshTokens: () => refreshTokens.clear(),
    confirmEmail: (email) => {
      users.get(email).confirmed = true;
    },
    /** ทำให้ request ที่ตรง regex (รูปแบบ "METHOD /path?query") ได้ status ที่กำหนด n ครั้ง */
    inject: (match, status, body, times = 1) => injected.push({ match, status, body, times }),
    resetStats: () => {
      calls.length = 0;
      Object.assign(stats, { pushCalls: 0, pullCalls: 0, maxBatch: 0, pushBatches: [], pullPages: [] });
    },
    rowOf: (userId, id) => records.get(rkey(userId, id)),
    rowsOf: (userId) => [...records.values()].filter((r) => r.user_id === userId),
  };
}
