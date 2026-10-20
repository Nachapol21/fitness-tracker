// ตัวเดียวของแอปสำหรับบัญชีและซิงก์ (ประกอบ auth + sync + ที่เก็บใน IndexedDB เข้าด้วยกัน)

import { SYNC_CONFIG } from './config.js';
import { createAuth } from './auth.js';
import { createSync } from './sync.js';
import * as db from './db.js';
import { refreshKingdomSummary } from './kingdom-summary.js';
import { toDateStr } from './dates.js';

/** ซิงก์เป็นตัวเลือก: ถ้าไม่ได้ตั้งค่า url/key จะซ่อนทุกอย่างและแอปทำงานในเครื่องล้วน */
export const syncEnabled = !!(SYNC_CONFIG.url && SYNC_CONFIG.publishableKey);

export const auth = createAuth({ config: SYNC_CONFIG });
/**
 * สรุป 🔥/🪙 ให้แผนที่อาณาจักร: เรียกหลังซิงก์สำเร็จเท่านั้น (จึงเกิดเฉพาะตอนล็อกอินอยู่ และหลังดึงข้อมูลเครื่องอื่นมารวมแล้ว)
 * หลังจดข้อมูลในเครื่อง → debounce เดิม → ซิงก์ → ตะขอนี้ · เขียนเฉพาะเมื่อค่าเปลี่ยน (ดู js/kingdom-summary.js)
 */
const updateKingdomSummary = () =>
  refreshKingdomSummary({
    load: async () => {
      const [data, profile, settings] = await Promise.all([db.loadAll(), db.getProfile(), db.getGameSettings()]);
      return { data, profile, settings };
    },
    getCurrent: db.getKingdomSummary,
    save: db.saveKingdomSummary,
    asOf: toDateStr(),
  });

export const sync = createSync({ auth, store: db.syncStore, config: SYNC_CONFIG, onSynced: updateKingdomSummary });

let started = false;

/**
 * ผูกจังหวะซิงก์เข้ากับแอป (เรียกครั้งเดียวตอนเปิดแอป):
 *   เปิดแอป · event online · กลับมาเปิดแท็บ/แอป (visibilitychange) · หลังเขียนข้อมูลในเครื่อง (debounce 5 วินาที)
 * onApplied(n) ถูกเรียกเมื่อดึงข้อมูลใหม่จากเครื่องอื่นมาใช้ n รายการ (ให้หน้าจอวาดใหม่)
 * ไม่ล็อกอิน = ไม่ทำอะไรเลย แอปทำงานในเครื่องล้วน
 */
export function startSync({ onApplied } = {}) {
  if (started || !syncEnabled) return;
  started = true;
  const run = () => {
    if (auth.getSession()) sync.sync();
  };
  db.onChange(() => sync.schedule());
  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
  if (onApplied) sync.onApplied(onApplied);
  sync
    .init()
    .then(run)
    .catch((e) => console.warn('เริ่มซิงก์ไม่สำเร็จ', e));
}
