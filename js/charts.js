// กราฟ SVG วาดเอง (ไม่พึ่ง library ภายนอก ใช้ออฟไลน์ได้)
// สีมาจากตัวแปร CSS (--c1..--c4, --ok, --warn, --bad) จึงรองรับ dark mode

import { fmtShort, fromDayNum, dayNum } from './dates.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const W = 360;

function wrap(html, legendItems) {
  const div = document.createElement('div');
  div.className = 'chart-wrap';
  div.innerHTML = html;
  if (legendItems && legendItems.length) {
    const lg = document.createElement('div');
    lg.className = 'legend';
    lg.innerHTML = legendItems
      .map((l) => `<span class="legend-item"><i class="swatch ${l.dashed ? 'dashed' : ''}" style="--sw:var(--${l.color})"></i>${esc(l.name)}</span>`)
      .join('');
    div.append(lg);
  }
  return div;
}

export function noData(text = 'ยังไม่มีข้อมูลพอจะวาดกราฟ') {
  const d = document.createElement('div');
  d.className = 'empty small';
  d.textContent = text;
  return d;
}

function niceTicks(min, max, count = 4) {
  if (!(max > min)) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/**
 * กราฟเส้น
 * series: [{name, color:'c1'|'c2'.., points:[{x,y}], dashed, dots, area}]  x = เลขวัน (dayNum) หรือเลขธรรมดา
 * hlines: [{y, label, color}]  เส้นแนวนอนอ้างอิง เช่น เป้า
 */
export function lineChart({ series, hlines = [], height = 210, yFmt = (v) => String(v), xFmt = (x) => fmtShort(fromDayNum(x)), aria = 'กราฟเส้น', yZero = false }) {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return noData();
  const m = { l: 40, r: 12, t: 12, b: 26 };
  const H = height;
  let xMin = Math.min(...all.map((p) => p.x));
  let xMax = Math.max(...all.map((p) => p.x));
  const singleX = xMin === xMax; // มีวันเดียว: ขยายแกนให้จุดอยู่กลาง และติดป้ายแค่วันนั้น
  if (singleX) {
    xMin -= 3;
    xMax += 3;
  }
  const ys = [...all.map((p) => p.y), ...hlines.map((l) => l.y)];
  let yMin = yZero ? 0 : Math.min(...ys);
  let yMax = Math.max(...ys);
  if (!yZero) {
    const pad = (yMax - yMin) * 0.12 || 1;
    yMin -= pad;
    yMax += pad;
  }
  const ticks = niceTicks(yMin, yMax, 4);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const sx = (x) => m.l + ((x - xMin) / (xMax - xMin)) * (W - m.l - m.r);
  const sy = (y) => H - m.b - ((y - y0) / (y1 - y0)) * (H - m.t - m.b);

  let g = '';
  for (const t of ticks) {
    g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${sy(t)}" y2="${sy(t)}"/><text class="axis" x="${m.l - 5}" y="${sy(t) + 3.5}" text-anchor="end">${esc(yFmt(t))}</text>`;
  }
  if (singleX) {
    const x = all[0].x;
    g += `<text class="axis" x="${sx(x)}" y="${H - 8}" text-anchor="middle">${esc(xFmt(x))}</text>`;
  } else {
    const nx = Math.min(5, Math.max(2, Math.floor(xMax - xMin) + 1));
    for (let i = 0; i < nx; i++) {
      const x = Math.round(xMin + ((xMax - xMin) * i) / (nx - 1));
      g += `<text class="axis" x="${sx(x)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === nx - 1 ? 'end' : 'middle'}">${esc(xFmt(x))}</text>`;
    }
  }
  for (const l of hlines) {
    g += `<line class="ref" style="stroke:var(--${l.color || 'warn'})" x1="${m.l}" x2="${W - m.r}" y1="${sy(l.y)}" y2="${sy(l.y)}"/>`;
    if (l.label) g += `<text class="axis ref-label" style="fill:var(--${l.color || 'warn'})" x="${W - m.r}" y="${sy(l.y) - 4}" text-anchor="end">${esc(l.label)}</text>`;
  }
  for (const s of series) {
    const pts = [...s.points].sort((a, b) => a.x - b.x);
    if (!pts.length) continue;
    const color = `var(--${s.color || 'c1'})`;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    if (s.area && pts.length > 1) {
      g += `<path d="${d} L${sx(pts[pts.length - 1].x).toFixed(1)},${sy(y0)} L${sx(pts[0].x).toFixed(1)},${sy(y0)} Z" style="fill:${color};opacity:.12"/>`;
    }
    if (pts.length > 1) g += `<path d="${d}" fill="none" style="stroke:${color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round" ${s.dashed ? 'stroke-dasharray="5 4"' : ''}/>`;
    const showDots = s.dots ?? pts.length <= 45;
    if (showDots || pts.length === 1) {
      for (const p of pts) g += `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${s.dotR || 3}" style="fill:${color}"><title>${esc(s.name)}: ${esc(yFmt(p.y))} (${esc(xFmt(p.x))})</title></circle>`;
    }
  }
  return wrap(
    `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}" preserveAspectRatio="xMidYMid meet">${g}</svg>`,
    series.filter((s) => s.name).map((s) => ({ name: s.name, color: s.color || 'c1', dashed: s.dashed }))
  );
}

/**
 * กราฟแท่งรายวัน
 * bars: [{label, value, cls:'ok'|'over'|'under'|'none'}]  band: [lo, hi] แถบเป้า  ref: เส้นเป้าเดี่ยว
 */
export function barChart({ bars, band, ref, refLabel, height = 190, yFmt = (v) => String(Math.round(v)), aria = 'กราฟแท่ง', labelEvery }) {
  if (!bars.length) return noData();
  const m = { l: 40, r: 10, t: 12, b: 26 };
  const H = height;
  const vmax = Math.max(...bars.map((b) => b.value), band ? band[1] : 0, ref || 0, 1);
  const ticks = niceTicks(0, vmax * 1.05, 4);
  const top = ticks[ticks.length - 1];
  const sy = (v) => H - m.b - (v / top) * (H - m.t - m.b);
  const bw = (W - m.l - m.r) / bars.length;
  let g = '';
  for (const t of ticks) g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${sy(t)}" y2="${sy(t)}"/><text class="axis" x="${m.l - 5}" y="${sy(t) + 3.5}" text-anchor="end">${esc(yFmt(t))}</text>`;
  if (band) g += `<rect class="band" x="${m.l}" y="${sy(band[1])}" width="${W - m.l - m.r}" height="${Math.max(1, sy(band[0]) - sy(band[1]))}"/>`;
  const every = labelEvery || Math.max(1, Math.ceil(bars.length / 7));
  bars.forEach((b, i) => {
    const x = m.l + i * bw + bw * 0.15;
    const h = Math.max(0, sy(0) - sy(b.value));
    g += `<rect class="bar-rect ${b.cls || 'none'}" x="${x.toFixed(1)}" y="${(sy(0) - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${esc(b.label)}: ${esc(yFmt(b.value))}</title></rect>`;
    if (i % every === 0 || i === bars.length - 1) g += `<text class="axis" x="${(m.l + i * bw + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  if (ref) {
    g += `<line class="ref" style="stroke:var(--warn)" x1="${m.l}" x2="${W - m.r}" y1="${sy(ref)}" y2="${sy(ref)}"/>`;
    if (refLabel) g += `<text class="axis ref-label" style="fill:var(--warn)" x="${W - m.r}" y="${sy(ref) - 4}" text-anchor="end">${esc(refLabel)}</text>`;
  }
  return wrap(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${g}</svg>`);
}

/** แท่งแนวนอนหลายแถว เช่น เซ็ตต่อกลุ่มกล้าม  rows: [{label, value}]  marks: [{x,label}] */
export function hBars({ rows, max, marks = [], aria = 'กราฟแท่งแนวนอน', unit = '' }) {
  if (!rows.length) return noData();
  const rowH = 28;
  const m = { l: 56, r: 40, t: 6, b: marks.length ? 18 : 6 };
  const H = m.t + m.b + rows.length * rowH;
  const top = Math.max(max || 0, ...rows.map((r) => r.value), ...marks.map((k) => k.x), 1);
  const sx = (v) => m.l + (v / top) * (W - m.l - m.r);
  let g = '';
  for (const k of marks) {
    g += `<line class="ref" style="stroke:var(--warn)" x1="${sx(k.x)}" x2="${sx(k.x)}" y1="${m.t}" y2="${H - m.b}"/>`;
    if (k.label) g += `<text class="axis" style="fill:var(--warn)" x="${sx(k.x)}" y="${H - 5}" text-anchor="middle">${esc(k.label)}</text>`;
  }
  rows.forEach((r, i) => {
    const y = m.t + i * rowH;
    g += `<text class="axis lbl" x="${m.l - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(r.label)}</text>`;
    g += `<rect class="track" x="${m.l}" y="${y + 6}" width="${W - m.l - m.r}" height="${rowH - 12}" rx="4"/>`;
    if (r.value > 0) g += `<rect class="bar-rect ${r.cls || 'none'}" x="${m.l}" y="${y + 6}" width="${Math.max(3, sx(r.value) - m.l)}" height="${rowH - 12}" rx="4"/>`;
    g += `<text class="axis val" x="${W - m.r + 6}" y="${y + rowH / 2 + 4}">${esc(String(r.value))}${esc(unit)}</text>`;
  });
  return wrap(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${g}</svg>`);
}

/** แท่งสัดส่วนเดียว แบ่งสี  parts: [{label, value, color}] */
export function stackBar({ parts, aria = 'สัดส่วน' }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!(total > 0)) return noData('ยังไม่มีข้อมูล');
  let x = 0;
  let g = '';
  const bw = W - 20;
  for (const p of parts) {
    const w = (p.value / total) * bw;
    if (w > 0) {
      g += `<rect x="${10 + x}" y="4" width="${w.toFixed(1)}" height="26" style="fill:var(--${p.color})"><title>${esc(p.label)}: ${p.value}</title></rect>`;
      if (w > 28) g += `<text x="${10 + x + w / 2}" y="22" text-anchor="middle" class="stack-text">${Math.round((p.value / total) * 100)}%</text>`;
    }
    x += w;
  }
  const el = wrap(`<svg class="chart" viewBox="0 0 ${W} 34" role="img" aria-label="${esc(aria)}">${g}</svg>`);
  const lg = document.createElement('div');
  lg.className = 'legend';
  lg.innerHTML = parts
    .map((p) => `<span class="legend-item"><i class="swatch" style="--sw:var(--${p.color})"></i>${esc(p.label)} ${p.value} เซ็ต</span>`)
    .join('');
  el.append(lg);
  return el;
}

export { dayNum };
