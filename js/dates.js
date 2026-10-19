// ตัวช่วยเรื่องวันที่ ใช้สตริง 'YYYY-MM-DD' (เวลาท้องถิ่น) ทั้งหมด ไม่มี DOM

const pad = (n) => String(n).padStart(2, '0');

export const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
export const DAYS_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

export function toDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** จำนวนวันนับจาก epoch (UTC) ไม่ติดเรื่อง timezone/DST */
export function dayNum(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function fromDayNum(n) {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const addDays = (s, n) => fromDayNum(dayNum(s) + n);
export const diffDays = (a, b) => dayNum(b) - dayNum(a);

/** 0 = อาทิตย์ */
export function weekday(s) {
  return new Date(dayNum(s) * 86400000).getUTCDay();
}

/** วันจันทร์ของสัปดาห์ที่วันนั้นอยู่ */
export function weekStart(s) {
  return addDays(s, -((weekday(s) + 6) % 7));
}

export function dateRange(from, to) {
  const out = [];
  for (let n = dayNum(from), end = dayNum(to); n <= end; n++) out.push(fromDayNum(n));
  return out;
}

export function fmtShort(s) {
  const [, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export function fmtLong(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${DAYS[weekday(s)]} ${d} ${MONTHS[m - 1]} ${y}`;
}

export function fmtRange(from, to) {
  return `${fmtShort(from)} – ${fmtShort(to)}`;
}

export function nowHM(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
