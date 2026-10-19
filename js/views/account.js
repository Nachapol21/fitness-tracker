// UI ส่วน "บัญชีและซิงก์" (แท็บตั้งค่า) และจุดบอกสถานะซิงก์ (หน้า "วันนี้")

import * as db from '../db.js';
import { toDateStr, fmtShort, nowHM } from '../dates.js';
import { auth, sync, syncEnabled } from '../sync-service.js';
import { confirmSheet, field, h, openSheet, textInput, toast } from '../ui.js';

// ---------- ข้อความสถานะ ----------

/** สถานะ → ป้ายสั้นๆ + ระดับสี (ok | warn | bad | busy | off) */
export function describeStatus(s) {
  if (s.state === 'signed_out') return { level: 'off', label: 'ยังไม่ล็อกอิน', detail: 'ข้อมูลอยู่ในเครื่องนี้เท่านั้น' };
  if (s.state === 'syncing') return { level: 'busy', label: 'กำลังซิงก์…', detail: 'กำลังซิงก์…' };
  if (s.state === 'error') return { level: 'bad', label: 'ซิงก์ไม่สำเร็จ', detail: s.error || 'ซิงก์ไม่สำเร็จ' };
  if (s.state === 'offline') return { level: 'warn', label: s.pending ? `ออฟไลน์ · รอส่ง ${s.pending}` : 'ออฟไลน์', detail: 'ออฟไลน์ — จดได้ตามปกติ จะส่งให้เมื่อมีสัญญาณ' };
  if (s.pending > 0) return { level: 'warn', label: `รอส่ง ${s.pending}`, detail: `มี ${s.pending} รายการรอส่ง` };
  return { level: 'ok', label: 'ซิงก์แล้ว', detail: 'ซิงก์แล้ว' };
}

export function fmtWhen(iso, now = new Date()) {
  if (!iso) return 'ยังไม่เคยซิงก์';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'ยังไม่เคยซิงก์';
  const day = toDateStr(d);
  const t = nowHM(d);
  return day === toDateStr(now) ? `วันนี้ ${t}` : `${fmtShort(day)} ${t}`;
}

/** subscribe ที่เลิกฟังเองเมื่อ element หลุดจากหน้า (หน้าถูกวาดใหม่) */
function bindToElement(el, fn) {
  const off = sync.subscribe((s) => {
    if (!el.isConnected) return off();
    fn(s);
  });
}

// ---------- จุดสถานะหน้า "วันนี้" ----------

export function syncDot() {
  if (!syncEnabled) return null;
  const dot = h('span', { class: 'sync-dot', 'aria-hidden': 'true' });
  const text = h('span', { class: 'sync-dot-text' });
  const el = h('a', { class: 'sync-chip', href: '#/settings', id: 'sync-dot' }, dot, text);
  const paint = (s) => {
    const d = describeStatus(s);
    dot.className = `sync-dot ${d.level}`;
    text.textContent = d.label;
    el.setAttribute('aria-label', `สถานะซิงก์: ${d.detail}`);
    el.title = d.detail;
  };
  paint(sync.getStatus());
  bindToElement(el, paint);
  return el;
}

// ---------- การ์ดบัญชีและซิงก์ ----------

export function accountCard({ refresh }) {
  if (!syncEnabled) return null;
  const card = h('section', { class: 'card', id: 'account-card' });
  let mode = null; // 'in' | 'out'
  let paintStatus = () => {};

  function render() {
    const session = auth.getSession();
    mode = session ? 'in' : 'out';
    card.replaceChildren(...[h('h2', null, 'บัญชีและซิงก์'), ...(session ? signedInBody(session) : signedOutBody())].filter(Boolean));
  }

  // ----- ยังไม่ล็อกอิน -----
  function signedOutBody() {
    const email = textInput({ type: 'email', placeholder: 'อีเมล', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', 'aria-label': 'อีเมล', id: 'acc-email' });
    const pass = textInput({ type: 'password', placeholder: 'รหัสผ่าน (อย่างน้อย 6 ตัว)', autocomplete: 'current-password', 'aria-label': 'รหัสผ่าน', id: 'acc-pass' });
    const msg = h('div', { class: 'callout', 'aria-live': 'polite', id: 'acc-msg', hidden: true });
    const loginBtn = h('button', { type: 'submit', class: 'btn primary', id: 'acc-login' }, 'ล็อกอิน');
    const signupBtn = h('button', { type: 'button', class: 'btn', id: 'acc-signup' }, 'สมัครบัญชีใหม่');
    const show = (text, kind = '') => {
      msg.hidden = !text;
      msg.className = `callout ${kind}`;
      msg.textContent = text || '';
    };
    const busy = (b) => {
      loginBtn.disabled = b;
      signupBtn.disabled = b;
    };
    const read = () => {
      const e = email.value.trim();
      const p = pass.value;
      if (!e || !p) {
        show('กรอกอีเมลและรหัสผ่านก่อน', 'warn');
        return null;
      }
      return { e, p };
    };
    async function afterLogin() {
      pass.value = '';
      await sync.init();
      render();
      sync.sync(); // ไม่ต้องรอ — การ์ดอัปเดตเองตามสถานะ
    }
    async function doLogin(ev) {
      ev.preventDefault();
      const v = read();
      if (!v) return;
      busy(true);
      show('กำลังล็อกอิน…');
      try {
        await auth.signIn(v.e, v.p);
        toast('ล็อกอินแล้ว กำลังซิงก์');
        await afterLogin();
      } catch (err) {
        show(err.message || 'ล็อกอินไม่สำเร็จ', 'warn');
        busy(false);
      }
    }
    async function doSignup() {
      const v = read();
      if (!v) return;
      busy(true);
      show('กำลังสมัคร…');
      try {
        const r = await auth.signUp(v.e, v.p);
        if (r.needsConfirmation) {
          pass.value = '';
          show('สมัครแล้ว — ไปกดยืนยันในอีเมลก่อน แล้วค่อยกลับมาล็อกอิน', 'ok');
          busy(false);
        } else {
          await afterLogin();
        }
      } catch (err) {
        show(err.message || 'สมัครไม่สำเร็จ', 'warn');
        busy(false);
      }
    }
    signupBtn.addEventListener('click', doSignup);
    paintStatus = () => {};
    const last = sync.getStatus();
    return [
      h('p', { class: 'muted' }, 'ล็อกอินเพื่อซิงก์ข้อมูลระหว่างเครื่อง (เช่น iPhone กับคอม) ไม่ล็อกอินก็ใช้แอปได้ครบ ข้อมูลจะอยู่ในเครื่องนี้เท่านั้น'),
      last.error && last.errorCode === 'session_expired' ? h('div', { class: 'callout warn' }, last.error) : null,
      h('form', { class: 'stack', onsubmit: doLogin }, field('อีเมล', email), field('รหัสผ่าน', pass), h('div', { class: 'row gap' }, loginBtn, signupBtn), msg),
      h('p', { class: 'muted small-text' }, 'รหัสผ่านไม่ถูกเก็บในเครื่อง เก็บเพียงใบผ่านทาง (session) ที่ออกให้หลังล็อกอิน'),
    ];
  }

  // ----- ล็อกอินแล้ว -----
  function signedInBody(session) {
    const stateEl = h('strong', { id: 'acc-state' });
    const lastEl = h('span', { id: 'acc-last' });
    const pendEl = h('span', { id: 'acc-pending' });
    const rejEl = h('span', { id: 'acc-rejected' });
    const rejLabel = h('dt', { id: 'acc-rejected-label' }, 'ส่งไม่ได้');
    const rejVal = h('dd', null, rejEl);
    const rejNote = h('p', { class: 'muted small-text', id: 'acc-rejected-note', hidden: true }, 'เซิร์ฟเวอร์ปฏิเสธรายการเหล่านี้ (ข้อมูลผิดรูปแบบ เช่น มาจากไฟล์นำเข้าที่เสีย) เครื่องอื่นจะไม่เห็น แต่รายการอื่นซิงก์ตามปกติ — แก้รายการนั้นในแอปแล้วระบบจะลองส่งใหม่เอง');
    const errEl = h('div', { class: 'callout warn', id: 'acc-error', role: 'alert', hidden: true });
    const dot = h('span', { class: 'sync-dot', 'aria-hidden': 'true' });
    const now = h('button', { type: 'button', class: 'btn primary', id: 'acc-sync-now', onclick: () => doSyncNow() }, 'ซิงก์ตอนนี้');
    paintStatus = (s) => {
      const d = describeStatus(s);
      dot.className = `sync-dot ${d.level}`;
      stateEl.textContent = d.level === 'bad' ? d.label : d.detail;
      lastEl.textContent = fmtWhen(s.lastSyncAt);
      pendEl.textContent = s.pending ? `${s.pending} รายการ` : 'ไม่มี';
      rejEl.textContent = `${s.rejected || 0} รายการ`;
      rejLabel.hidden = rejVal.hidden = rejNote.hidden = !(s.rejected > 0);
      errEl.hidden = s.state !== 'error';
      errEl.textContent = s.state === 'error' ? s.error || '' : '';
      now.disabled = s.state === 'syncing';
    };
    paintStatus(sync.getStatus());

    async function doSyncNow() {
      const st = await sync.sync();
      if (st.state === 'idle') toast('ซิงก์เรียบร้อย');
      else if (st.state === 'offline') toast('ออฟไลน์อยู่ จะซิงก์ให้เมื่อมีสัญญาณ');
    }

    return [
      h('p', null, 'ล็อกอินเป็น ', h('strong', { id: 'acc-email-shown' }, session.user?.email || '(ไม่ทราบอีเมล)')),
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'สถานะ'),
        h('dd', null, dot, ' ', stateEl),
        h('dt', null, 'ซิงก์ล่าสุด'),
        h('dd', null, lastEl),
        h('dt', null, 'รอส่ง'),
        h('dd', null, pendEl),
        rejLabel,
        rejVal
      ),
      rejNote,
      errEl,
      h('div', { class: 'stack' }, now, h('button', { type: 'button', class: 'btn danger-outline', id: 'acc-signout', onclick: () => signOutFlow() }, 'ออกจากระบบ')),
      h('p', { class: 'muted small-text' }, 'ซิงก์เองเมื่อเปิดแอป เมื่อกลับมาออนไลน์ และไม่นานหลังจดข้อมูล · ถ้าแก้รายการเดียวกันสองเครื่อง จะใช้ฉบับที่แก้ทีหลัง'),
    ];
  }

  // ----- ออกจากระบบ -----
  function signOutFlow() {
    const sheet = openSheet({
      title: 'ออกจากระบบ',
      content: (close) => {
        const note = h('p', { class: 'muted', 'aria-live': 'polite' }, 'ข้อมูลในเครื่องนี้จะทำอย่างไร?');
        const keep = h('button', { class: 'btn primary', id: 'signout-keep' }, 'เก็บข้อมูลไว้ในเครื่อง');
        const wipe = h('button', { class: 'btn danger-outline', id: 'signout-wipe' }, 'ล้างข้อมูลในเครื่องด้วย');
        const cancel = h('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก');
        const lock = (b) => [keep, wipe, cancel].forEach((x) => (x.disabled = b));

        /** พยายามส่งของที่ค้างให้เสร็จก่อนออก (ถ้าออนไลน์) */
        async function flush() {
          if (sync.getStatus().pending > 0 && navigator.onLine !== false) {
            note.textContent = 'กำลังส่งรายการที่ค้างอยู่ก่อนออก…';
            await sync.sync();
          }
          return db.countDirty();
        }
        keep.addEventListener('click', async () => {
          lock(true);
          await flush();
          await auth.signOut();
          close();
          toast('ออกจากระบบแล้ว ข้อมูลยังอยู่ในเครื่อง');
          refresh();
        });
        wipe.addEventListener('click', async () => {
          lock(true);
          const left = await flush();
          const msg = left > 0 ? `ยังมี ${left} รายการที่ไม่ได้ส่งขึ้นเซิร์ฟเวอร์ (ออฟไลน์หรือซิงก์ไม่สำเร็จ) ถ้าล้างตอนนี้จะหายถาวร\n\nล้างข้อมูลในเครื่องนี้ต่อไหม?` : 'ข้อมูลทั้งหมดซิงก์ขึ้นเซิร์ฟเวอร์แล้ว ล้างจากเครื่องนี้ได้ ล็อกอินใหม่แล้วจะดึงกลับมา\n\nล้างข้อมูลในเครื่องนี้ต่อไหม?';
          if (!(await confirmSheet(msg, { okText: 'ล้างข้อมูลในเครื่อง', danger: true, title: 'ล้างข้อมูลในเครื่อง' }))) {
            lock(false);
            note.textContent = 'ยกเลิกการล้าง ยังไม่ได้ออกจากระบบ';
            return;
          }
          await auth.signOut();
          await db.clearAll();
          close();
          location.hash = '#/today';
          location.reload();
        });
        return h('div', { class: 'stack' }, note, keep, h('small', { class: 'muted' }, 'ล็อกอินกลับมาด้วยบัญชีเดิมแล้วซิงก์ต่อได้ (ถ้าจะใช้บัญชีอื่นบนเครื่องนี้ ให้เลือกล้างข้อมูล)'), wipe, cancel);
      },
    });
    return sheet;
  }

  render();
  bindToElement(card, (s) => {
    const signedIn = !!auth.getSession();
    if (signedIn !== (mode === 'in')) {
      // เฉพาะตอนสลับล็อกอิน/ออก (เช่น session หมดอายุ) จึงวาดใหม่ทั้งการ์ด
      if (!card.querySelector('#acc-pass')?.value) render();
    } else if (mode === 'in') paintStatus(s);
  });
  return card;
}
