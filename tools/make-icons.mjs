// สร้างไอคอน PNG จากรูปทรงเดียวกับ icons/icon.svg โดยไม่ต้องติดตั้งอะไร (ใช้ zlib ของ Node)
// รัน: node tools/make-icons.mjs

import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(outDir, { recursive: true });

// รูปทรง (หน่วยบนผืน 512×512): [x, y, กว้าง, สูง, รัศมีมุม]
const SHAPES = [
  [160, 240, 192, 32, 10],
  [120, 160, 40, 192, 14],
  [352, 160, 40, 192, 14],
  [84, 200, 36, 112, 12],
  [392, 200, 36, 112, 12],
];
const C0 = [0x14, 0xb8, 0xa6];
const C1 = [0x0f, 0x76, 0x6e];

function inRoundRect(px, py, [x, y, w, h, r]) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = Math.abs(px - cx) - (w / 2 - r);
  const dy = Math.abs(py - cy) - (h / 2 - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) <= r;
}

/** size = ขนาดภาพ, rounded = มุมโค้งโปร่งใส (any) หรือเต็มพื้นที่ (maskable/apple) */
function render(size, rounded) {
  const SS = 4; // supersampling กันขอบหยัก
  const scale = 512 / size;
  const px = Buffer.alloc(size * size * 4);
  const corner = { x: 0, y: 0, w: 512, h: 512, r: 112 };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let cov = 0;
      let white = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const x = (i + (si + 0.5) / SS) * scale;
          const y = (j + (sj + 0.5) / SS) * scale;
          if (!rounded || inRoundRect(x, y, [0, 0, 512, 512, corner.r])) {
            cov++;
            if (SHAPES.some((s) => inRoundRect(x, y, s))) white++;
          }
        }
      }
      const n = SS * SS;
      const t = (i + j) / (2 * (size - 1));
      const bg = C0.map((c, k) => c + (C1[k] - c) * t);
      const wf = cov ? white / cov : 0;
      const o = (j * size + i) * 4;
      for (let k = 0; k < 3; k++) px[o + k] = Math.round(bg[k] * (1 - wf) + 255 * wf);
      px[o + 3] = Math.round((cov / n) * 255);
    }
  }
  return px;
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const jobs = [
  ['icon-192.png', 192, true],
  ['icon-512.png', 512, true],
  ['icon-maskable-512.png', 512, false],
  ['apple-touch-icon.png', 180, false],
];
for (const [name, size, rounded] of jobs) {
  writeFileSync(join(outDir, name), png(size, render(size, rounded)));
  console.log('สร้าง', name);
}
