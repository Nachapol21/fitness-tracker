// จุดเริ่มต้นของแอป: router แบบ hash, แบนเนอร์เตือน, service worker, ธีม

import * as db from './db.js';
import { toDateStr } from './dates.js';
import { flushPending, h, mount, toast } from './ui.js';
import { renderToday } from './views/today.js';
import { renderTrain } from './views/train.js';
import { renderFood } from './views/food.js';
import { renderInsights } from './views/insights.js';
import { applyTheme, getTheme, renderSettings } from './views/settings.js';
import { needsInstallGuide, openInstallGuide, shouldAutoShowGuide } from './views/install.js';
import { exportJSON } from './io.js';
import { SYNC_TABLES_VERSION } from './constants.js';
import { auth, startSync, sync, syncEnabled } from './sync-service.js';
import { renderCoins, renderShop } from './views/game.js';

const routes = { today: renderToday, train: renderTrain, food: renderFood, insights: renderInsights, settings: renderSettings, shop: renderShop, coins: renderCoins };
// หน้าย่อย (ไม่มีแท็บของตัวเอง) ให้ไฮไลต์แท็บแม่
const parentTab = { shop: 'today', coins: 'today' };
const view = document.getElementById('view');
const bannersEl = document.getElementById('banners');

applyTheme(getTheme());

// ---------- แบนเนอร์ ----------

const DAY = 86400000;

async function renderBanners() {
  const items = [];

  // เตือนสำรองข้อมูลถ้าไม่ได้ export เกิน 7 วัน (นับจากการ export ล่าสุด หรือวันที่เริ่มใช้ถ้ายังไม่เคย)
  const [lastExport, firstRun, snooze] = await Promise.all([db.getMeta('last_export_at'), db.getMeta('first_run_at'), db.getMeta('backup_snooze_until')]);
  const ref = lastExport || firstRun;
  if (ref && Date.now() - new Date(ref).getTime() > 7 * DAY && !(snooze && Date.now() < new Date(snooze).getTime())) {
    const hasData = (await db.list('sessions')).length + (await db.list('food_logs')).length + (await db.list('body_logs')).length > 0;
    if (hasData) {
      const days = Math.floor((Date.now() - new Date(ref).getTime()) / DAY);
      items.push(
        h(
          'div',
          { class: 'banner warn', role: 'alert', id: 'backup-banner' },
          h('span', { class: 'grow' }, lastExport ? `ไม่ได้สำรองข้อมูลมา ${days} วันแล้ว` : `ใช้งานมา ${days} วันแต่ยังไม่เคยสำรองข้อมูล`),
          h(
            'button',
            {
              class: 'btn small',
              onclick: async () => {
                const r = await exportJSON();
                if (r.result === 'saved') toast('สำรองข้อมูลแล้ว');
                renderBanners();
              },
            },
            'สำรองเลย'
          ),
          h(
            'button',
            {
              class: 'btn small ghost',
              onclick: async () => {
                await db.setMeta('backup_snooze_until', new Date(Date.now() + DAY).toISOString());
                renderBanners();
              },
            },
            'พรุ่งนี้'
          )
        )
      );
    }
  }

  if (needsInstallGuide()) {
    items.push(h('div', { class: 'banner', id: 'install-banner' }, h('span', { class: 'grow' }, 'ติดตั้งลงหน้าจอโฮมเพื่อใช้ออฟไลน์และเก็บข้อมูลได้มั่นคงกว่า'), h('button', { class: 'btn small', onclick: () => openInstallGuide() }, 'ดูวิธี')));
  }
  bannersEl.replaceChildren(...items);
}

// ---------- router ----------

let queue = Promise.resolve();

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: routes[parts[0]] ? parts[0] : 'today', params: parts.slice(1) };
}

async function doRoute({ resetScroll }) {
  await flushPending();
  const { name, params } = parseHash();
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const on = a.dataset.route === (parentTab[name] || name);
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (resetScroll) window.scrollTo(0, 0);
  try {
    await routes[name](view, params);
  } catch (err) {
    console.error(err);
    mount(view, h('section', { class: 'card' }, h('h2', null, 'เกิดข้อผิดพลาด'), h('p', { class: 'bad-text' }, String(err.message || err)), h('a', { class: 'btn', href: '#/today' }, 'กลับหน้าวันนี้')));
  }
  renderBanners().catch(console.error);
}

const go = (opts = {}) => (queue = queue.then(() => doRoute(opts)).catch(console.error));

window.addEventListener('hashchange', () => go({ resetScroll: true }));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
  go();
});

// ---------- เริ่มทำงาน ----------

async function start() {
  try {
    await db.ensureSeed();
  } catch (err) {
    console.error(err);
    if (err instanceof db.DBBlockedError) {
      mount(view, h('section', { class: 'card' }, h('h2', null, 'ปิดหน้าต่างแอปเก่าก่อน'), h('p', null, 'แอปเพิ่งอัปเดต แต่ยังมีแท็บหรือหน้าต่างของแอปรุ่นเก่าเปิดค้างอยู่ จึงอัปเกรดที่เก็บข้อมูลไม่ได้ ข้อมูลของคุณยังอยู่ครบ'), h('p', { class: 'muted' }, 'ปิดแท็บ/หน้าต่างอื่นของแอปนี้ให้หมด (รวมแอปที่ติดตั้งบนหน้าจอโฮมถ้าเปิดค้างอยู่) แล้วกดโหลดใหม่'), h('button', { class: 'btn primary', onclick: () => location.reload() }, 'โหลดใหม่')));
      return;
    }
    mount(view, h('section', { class: 'card' }, h('h2', null, 'เปิดที่เก็บข้อมูลไม่ได้'), h('p', null, 'แอปนี้ต้องใช้ IndexedDB ของเบราว์เซอร์ (โหมดส่วนตัวของบางเบราว์เซอร์ปิดไว้) ลองเปิดในหน้าต่างปกติ'), h('p', { class: 'bad-text' }, String(err.message || err))));
    return;
  }
  // การตั้งค่าเกม (start_date = วันนี้ตามเวลาไทย) สร้างครั้งเดียว: ถ้าล็อกอินซิงก์อยู่ ต้องรอซิงก์ครั้งแรกเสร็จก่อน จะได้ไม่สร้างทับของที่อยู่บนเซิร์ฟเวอร์
  let gameSettingsReady = false;
  const ensureGame = () => {
    if (gameSettingsReady) return;
    gameSettingsReady = true;
    db.ensureGameSettings().catch((e) => {
      gameSettingsReady = false;
      console.warn('สร้างการตั้งค่าเกมไม่สำเร็จ', e);
    });
  };
  // ถือว่า "ดึงข้อมูลจากเซิร์ฟเวอร์แล้ว" เมื่อเคยซิงก์ด้วยรุ่นที่รู้จักตารางปัจจุบันครบ (ไม่งั้นรุ่นนี้ยังไม่ได้ดึงการตั้งค่าเกมของเครื่องอื่นมา)
  const hasSynced = async () => !!(await db.getMeta('sync_last_at')) && (Number(await db.getMeta('sync_tables_version')) || 0) >= SYNC_TABLES_VERSION;
  if (!syncEnabled || !auth.getSession() || (await hasSynced())) ensureGame();
  else {
    const off = sync.subscribe((s) => {
      if (s.lastResult && s.state === 'idle') { // ซิงก์รอบนี้สำเร็จแล้ว (ดึงของเครื่องอื่นมาแล้ว)
        off();
        ensureGame();
        go();
      }
    });
  }
  // ขอให้เบราว์เซอร์เก็บข้อมูลถาวร (iOS/Chrome จะไม่ล้างเอง)
  if (navigator.storage?.persist) {
    navigator.storage.persist().then((ok) => db.setMeta('persisted', ok)).catch(() => {});
  }
  // กลับมาจากลิงก์ยืนยันอีเมลของ Supabase (#access_token=… หรือ #error=…) — ลบ token ออกจาก URL แล้วพาไปหน้าล็อกอิน
  const authReturn = /(^|[#&])(access_token|error)=/.test(location.hash) ? new URLSearchParams(location.hash.slice(1)) : null;
  if (authReturn) history.replaceState(null, '', location.pathname + '#/settings');
  if (!location.hash) history.replaceState(null, '', '#/today');
  await go();
  if (authReturn) {
    if (authReturn.get('error')) toast(`ลิงก์ยืนยันใช้ไม่ได้: ${authReturn.get('error_description') || authReturn.get('error')}`, { ms: 6000 });
    else toast('ยืนยันอีเมลแล้ว ล็อกอินที่การ์ด "บัญชีและซิงก์" ได้เลย', { ms: 6000 });
  }
  // ซิงก์ระหว่างเครื่อง (ทำงานเมื่อล็อกอินเท่านั้น) — ดึงข้อมูลใหม่จากเครื่องอื่นมาแล้วให้วาดหน้าปัจจุบันใหม่
  startSync({
    onApplied: () => {
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return; // กำลังพิมพ์อยู่ ไม่วาดทับ
      go();
    },
  });
  if (await shouldAutoShowGuide()) openInstallGuide({ auto: true });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('ลงทะเบียน service worker ไม่สำเร็จ', e));
  }
}

start();

// ใช้ตอนทดสอบ/ดีบักในคอนโซล
window.__app = { db, toDateStr };
