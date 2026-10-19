// Service worker: แคชไฟล์ทั้งหมดของแอปเพื่อใช้ออฟไลน์ (เช่น ในยิมที่สัญญาณไม่ดี)
// ถ้าเพิ่ม/ลบไฟล์ของแอป ให้แก้ FILES และเพิ่มเลข VERSION ด้วย (tests/data.test.mjs ตรวจให้)

const VERSION = 'v6';
const CACHE = `fitness-tracker-${VERSION}`;

const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/analytics.js',
  'js/auth.js',
  'js/charts.js',
  'js/config.js',
  'js/constants.js',
  'js/csv.js',
  'js/dates.js',
  'js/db.js',
  'js/game-actions.js',
  'js/game.js',
  'js/io.js',
  'js/lww.js',
  'js/seed.js',
  'js/state.js',
  'js/sync-service.js',
  'js/sync.js',
  'js/ui.js',
  'js/views/account.js',
  'js/views/common.js',
  'js/views/food.js',
  'js/views/game-settings.js',
  'js/views/game.js',
  'js/views/insights.js',
  'js/views/install.js',
  'js/views/settings.js',
  'js/views/today.js',
  'js/views/train.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))) // ข้าม HTTP cache ให้ได้ไฟล์ล่าสุดจริง
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fitness-tracker-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// แคชก่อน แล้วอัปเดตเบื้องหลัง (stale-while-revalidate) — เปิดครั้งถัดไปจะได้ไฟล์ใหม่
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // ข้ามโดเมน (เช่น Supabase) ต้องไปที่เครือข่ายเสมอ ห้ามแคช: ไม่เรียก respondWith ให้เบราว์เซอร์ส่งเอง
  if (url.origin !== self.location.origin) return;
  // ข้อมูลส่วนตัวห้ามเข้าแคชของ service worker
  if (url.pathname.includes('/private/')) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => undefined);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return (await network) || new Response('ออฟไลน์และยังไม่มีไฟล์นี้ในแคช', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })
  );
});
