// ล็อกอิน Supabase (GoTrue) ด้วย fetch ล้วน ไม่ใช้ supabase-js และไม่โหลดอะไรจากภายนอก
// ฉีด fetch/storage/นาฬิกาเข้ามาได้ จึงทดสอบใน Node ด้วย mock ได้ (tests/sync.test.mjs)
//
// session เก็บใน localStorage (access_token, refresh_token, เวลาหมดอายุ, ข้อมูลผู้ใช้) — ไม่เก็บรหัสผ่านเด็ดขาด

export const SESSION_KEY = 'fitness-tracker-session';
const MARGIN_MS = 60_000; // ต่ออายุ token ล่วงหน้าก่อนหมด 60 วินาที

export class AuthError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'AuthError';
    this.code = code; // network | session_expired | no_session | invalid_credentials | email_not_confirmed | ...
    this.status = status;
  }
}

/** แปลงข้อผิดพลาดของ GoTrue เป็นข้อความไทย */
export function describeAuthError(status, body) {
  const code = String(body?.error_code || body?.code || body?.error || '').toLowerCase();
  const msg = String(body?.msg || body?.message || body?.error_description || '');
  const m = msg.toLowerCase();
  const is = (...keys) => keys.some((k) => code === k || m.includes(k));
  if (is('invalid_credentials', 'invalid login credentials')) return ['invalid_credentials', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'];
  if (is('email_not_confirmed', 'email not confirmed')) return ['email_not_confirmed', 'ยังไม่ได้ยืนยันอีเมล — ไปกดลิงก์ในอีเมลก่อน แล้วค่อยกลับมาล็อกอิน'];
  if (is('user_already_exists', 'email_exists', 'already registered')) return ['user_exists', 'อีเมลนี้สมัครไว้แล้ว ลองล็อกอินแทน'];
  if (is('weak_password', 'password should be')) return ['weak_password', 'รหัสผ่านสั้นหรือง่ายเกินไป (อย่างน้อย 6 ตัวอักษร)'];
  if (is('signup_disabled', 'signups not allowed')) return ['signup_disabled', 'ปิดรับสมัครบัญชีใหม่แล้ว (ล็อกอินด้วยบัญชีที่มีอยู่ได้)'];
  if (is('over_email_send_rate_limit', 'over_request_rate_limit', 'rate limit') || status === 429) return ['rate_limit', 'ลองถี่เกินไป รอสักครู่แล้วลองใหม่'];
  if (is('validation_failed', 'email_address_invalid', 'unable to validate email', 'invalid format')) return ['invalid_email', 'รูปแบบอีเมลไม่ถูกต้อง'];
  if (is('refresh_token_not_found', 'refresh_token_already_used', 'invalid refresh token', 'session_not_found', 'invalid_grant')) {
    return ['session_expired', 'เซสชันหมดอายุ กรุณาล็อกอินใหม่'];
  }
  if (status >= 500) return ['server', 'เซิร์ฟเวอร์ขัดข้องชั่วคราว ลองใหม่ภายหลัง'];
  if (status === 401 || status === 403) return ['unauthorized', 'ไม่ได้รับอนุญาต กรุณาล็อกอินใหม่'];
  return ['unknown', `ผิดพลาด (${status})${msg ? `: ${msg}` : ''}`];
}

export function createAuth({ config, fetchFn, storage, now = () => Date.now() } = {}) {
  const doFetch = fetchFn || ((...a) => fetch(...a));
  const store = storage || globalThis.localStorage;
  const listeners = new Set();
  let inflight = null;

  const baseHeaders = (token) => ({
    apikey: config.publishableKey,
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  async function call(path, { body, token, method = 'POST' } = {}) {
    let res;
    try {
      res = await doFetch(`${config.url}${path}`, { method, headers: baseHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new AuthError('network', 'เชื่อมต่ออินเทอร์เน็ตไม่ได้');
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* ตัวตอบกลับว่าง */
    }
    return { ok: res.ok, status: res.status, body: json };
  }

  function read() {
    try {
      const s = JSON.parse(store.getItem(SESSION_KEY) || 'null');
      return s && s.access_token && s.refresh_token ? s : null;
    } catch {
      return null;
    }
  }
  function write(s) {
    if (s) store.setItem(SESSION_KEY, JSON.stringify(s));
    else store.removeItem(SESSION_KEY);
    listeners.forEach((fn) => fn(s));
  }

  function toSession(body, prev) {
    const user = body.user || prev?.user || null;
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: typeof body.expires_at === 'number' ? body.expires_at : Math.floor(now() / 1000) + (Number(body.expires_in) || 3600),
      user: user ? { id: user.id, email: user.email } : null,
    };
  }

  function fail(res) {
    const [code, message] = describeAuthError(res.status, res.body);
    return new AuthError(code, message, res.status);
  }

  async function signUp(email, password) {
    const res = await call('/auth/v1/signup', { body: { email, password } });
    if (!res.ok) throw fail(res);
    // ถ้าเปิดยืนยันอีเมล เซิร์ฟเวอร์จะไม่ให้ session จนกว่าจะกดลิงก์
    if (res.body?.access_token) {
      write(toSession(res.body));
      return { needsConfirmation: false };
    }
    return { needsConfirmation: true };
  }

  async function signIn(email, password) {
    const res = await call('/auth/v1/token?grant_type=password', { body: { email, password } });
    if (!res.ok) throw fail(res);
    const s = toSession(res.body);
    write(s);
    return s;
  }

  /** ต่ออายุ token (force=true หลังโดน 401) คืน session ใหม่ ถ้า refresh token ใช้ไม่ได้จะล้าง session แล้วโยน session_expired */
  function refresh(force = false) {
    if (inflight) return inflight;
    inflight = (async () => {
      const cur = read();
      if (!cur) throw new AuthError('no_session', 'ยังไม่ได้ล็อกอิน');
      // แท็บอื่นอาจต่ออายุให้แล้ว
      if (!force && cur.expires_at * 1000 - now() > MARGIN_MS) return cur;
      const res = await call('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: cur.refresh_token } });
      if (!res.ok) {
        const err = fail(res);
        if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 422) {
          write(null);
          throw new AuthError('session_expired', 'เซสชันหมดอายุ กรุณาล็อกอินใหม่', res.status);
        }
        throw err; // 5xx/429: คง session ไว้ ลองใหม่ทีหลัง
      }
      const s = toSession(res.body, cur);
      write(s);
      return s;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function getAccessToken() {
    let s = read();
    if (!s) throw new AuthError('no_session', 'ยังไม่ได้ล็อกอิน');
    if (s.expires_at * 1000 - now() < MARGIN_MS) s = await refresh(false);
    return s.access_token;
  }

  /** ออกจากระบบเฉพาะเครื่องนี้ (scope=local ไม่เตะเครื่องอื่นออก) ล้าง session เสมอแม้ติดต่อเซิร์ฟเวอร์ไม่ได้ */
  async function signOut() {
    const s = read();
    if (s) {
      try {
        await call('/auth/v1/logout?scope=local', { token: s.access_token });
      } catch {
        /* ไม่เป็นไร */
      }
    }
    write(null);
  }

  return {
    getSession: read,
    signUp,
    signIn,
    signOut,
    refresh,
    getAccessToken,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
