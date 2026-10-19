// ตัวช่วยสร้าง UI แบบไม่ใช้ framework: h(), toast, bottom sheet, ฟอร์ม

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let deferredValue;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') deferredValue = v; // ตั้งหลังใส่ option ให้ select
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  if (deferredValue !== undefined) el.value = deferredValue;
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** แทนที่เนื้อหาของ root ด้วย children (รับ array/null ได้) และคงตำแหน่งการเลื่อนหน้าไว้ */
export function mount(root, ...children) {
  const y = window.scrollY;
  const frag = document.createDocumentFragment();
  append(frag, children);
  root.replaceChildren(frag);
  window.scrollTo(0, y);
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---------- ไอคอน (SVG เส้น) ----------
const ICONS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  dumbbell: '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>',
  food: '<path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10"/><path d="M17 21V3c-2.5 1.5-3.5 4.5-3.5 8h3.5"/>',
  chart: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  settings:
    '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  chevL: '<polyline points="15 18 9 12 15 6"/>',
  chevR: '<polyline points="9 18 15 12 9 6"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

export function icon(name, size = 22) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

// ---------- รูปแบบตัวเลข ----------
export const fmtNum = (n, d = 1) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const f = 10 ** d;
  return String(Math.round(n * f) / f);
};
export const fmtInt = (n) => (n === null || n === undefined || Number.isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US'));

/** อ่านค่าตัวเลขจากช่อง input ('' → null, รองรับ , เป็นจุดทศนิยม) */
export function readNum(input) {
  const raw = String(input.value ?? '').trim().replace(',', '.');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------- toast ----------
let toastTimer = null;
export function toast(message, { action, ms = 3500, kind = '' } = {}) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  clear(box);
  const el = h('div', { class: `toast ${kind}` }, h('span', null, message));
  if (action) {
    el.append(
      h(
        'button',
        {
          class: 'toast-action',
          onclick: () => {
            el.remove();
            action.fn();
          },
        },
        action.label
      )
    );
  }
  box.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}

// ---------- bottom sheet ----------
let sheetCount = 0;
/**
 * เปิดแผ่นล่างจอ  content: Node หรือ (close) => Node
 * คืน { close, el, setContent }
 */
export function openSheet({ title, content, onClose } = {}) {
  const previouslyFocused = document.activeElement;
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const body = h('div', { class: 'sheet-body' });
  const titleEl = h('h2', { class: 'sheet-title' }, title || '');
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'ปิด', onclick: () => close() }, icon('x'));
  const sheet = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'หน้าต่าง' },
    h('div', { class: 'sheet-head' }, titleEl, closeBtn),
    body
  );
  backdrop.append(sheet);
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (--sheetCount === 0) document.body.classList.remove('no-scroll');
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus({ preventScroll: true });
    if (onClose) onClose(result);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  function setContent(c, newTitle) {
    if (newTitle !== undefined) titleEl.textContent = newTitle;
    clear(body);
    body.append(typeof c === 'function' ? c(close) : c);
  }
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  setContent(content);
  document.body.append(backdrop);
  document.body.classList.add('no-scroll');
  sheetCount++;
  return { close, el: sheet, setContent };
}

/** ถามยืนยัน คืน Promise<boolean> */
export function confirmSheet(message, { okText = 'ตกลง', cancelText = 'ยกเลิก', danger = false, title = 'ยืนยัน' } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v, close) => {
      answered = true;
      resolve(v);
      close();
    };
    openSheet({
      title,
      onClose: () => {
        if (!answered) resolve(false);
      },
      content: (close) =>
        h(
          'div',
          { class: 'stack' },
          h('p', { class: 'pre' }, message),
          h(
            'div',
            { class: 'row gap' },
            h('button', { class: 'btn ghost grow', onclick: () => answer(false, close) }, cancelText),
            h('button', { class: `btn grow ${danger ? 'danger' : 'primary'}`, onclick: () => answer(true, close) }, okText)
          )
        ),
    });
  });
}

// ---------- ส่วนประกอบฟอร์ม ----------

export function field(label, input, hint) {
  // ใช้ <label> เฉพาะกับช่องกรอกเดี่ยว (กลุ่มปุ่มใช้ <div> กันการกดป้ายชื่อแล้วไปกดปุ่มแรก)
  const single = ['INPUT', 'SELECT', 'TEXTAREA'].includes(input?.tagName);
  return h(single ? 'label' : 'div', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
}

export function textInput({ value = '', placeholder = '', type = 'text', ...rest } = {}) {
  return h('input', { class: 'input', type, value, placeholder, autocomplete: 'off', ...rest });
}

export function numInput({ value = null, placeholder = '', step = 'any', min, max, inputmode = 'decimal', ...rest } = {}) {
  return h('input', {
    class: 'input num',
    type: 'text',
    inputmode,
    pattern: '[0-9]*[.,]?[0-9]*',
    placeholder,
    'data-step': step,
    ...(min !== undefined ? { 'data-min': min } : {}),
    ...(max !== undefined ? { 'data-max': max } : {}),
    value: value === null || value === undefined ? '' : String(value),
    autocomplete: 'off',
    ...rest,
  });
}

/** กลุ่มปุ่มเลือก 1 ค่า (chips) */
export function chipGroup({ options, value, onChange, className = '' }) {
  let current = value;
  const el = h('div', { class: `chips ${className}`, role: 'radiogroup' });
  const buttons = options.map((o) => {
    const opt = typeof o === 'object' ? o : { value: o, label: String(o) };
    const b = h(
      'button',
      {
        type: 'button',
        class: 'chip',
        role: 'radio',
        'aria-checked': String(opt.value === current),
        onclick: () => set(opt.value, true),
      },
      opt.label
    );
    b._value = opt.value;
    return b;
  });
  el.append(...buttons);
  function paint() {
    buttons.forEach((b) => {
      const on = b._value === current;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
    });
  }
  function set(v, fire) {
    current = v;
    paint();
    if (fire && onChange) onChange(v);
  }
  paint();
  return { el, get: () => current, set: (v) => set(v, false) };
}

/** ตัวปรับจำนวน − 1 + */
export function stepper({ value = 1, step = 0.5, min = 0.5, max = 99, onChange }) {
  let v = value;
  const out = h('output', { class: 'stepper-val' }, fmtNum(v, 2));
  const set = (n) => {
    v = Math.min(max, Math.max(min, Math.round(n * 100) / 100));
    out.textContent = fmtNum(v, 2);
    if (onChange) onChange(v);
  };
  const el = h(
    'div',
    { class: 'stepper' },
    h('button', { type: 'button', class: 'btn round', 'aria-label': 'ลด', onclick: () => set(v - step) }, '−'),
    out,
    h('button', { type: 'button', class: 'btn round', 'aria-label': 'เพิ่ม', onclick: () => set(v + step) }, '+')
  );
  return { el, get: () => v, set };
}

export function progress(value, target, { cls = '' } = {}) {
  const pct = target > 0 ? Math.min(100, Math.max(0, (value / target) * 100)) : 0;
  return h('div', { class: `bar ${cls}`, role: 'progressbar', 'aria-valuenow': String(Math.round(value)), 'aria-valuemax': String(target || 0) }, h('div', { class: 'bar-fill', style: { width: `${pct}%` } }));
}

export function emptyState(text, action) {
  return h('div', { class: 'empty' }, h('p', null, text), action || null);
}

export function debounce(fn, ms = 400) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    return fn(...a);
  };
  return d;
}

// ---------- รอบันทึกค่าที่ยังพิมพ์ค้าง ----------
// ช่องกรอกที่บันทึกแบบ debounce ลงทะเบียนไว้ที่นี่ เพื่อให้ router/ปุ่มต่างๆ รอให้บันทึกครบก่อนเปลี่ยนหน้าหรือวาดใหม่
const pendingFlushers = new Set();
export const trackPending = (fn) => pendingFlushers.add(fn);
export const untrackPending = (fn) => pendingFlushers.delete(fn);
export async function flushPending() {
  await Promise.all([...pendingFlushers].map((f) => f()));
}
