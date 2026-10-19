// คู่มือ "เพิ่มไปยังหน้าจอโฮม" สำหรับ iPhone/iPad + ตัวช่วยตรวจว่าติดตั้งแล้วหรือยัง

import * as db from '../db.js';
import { h, icon, openSheet } from '../ui.js';

export function isIOS() {
  const ua = navigator.userAgent || '';
  // iPadOS 13+ ปลอมตัวเป็น Mac แต่มีหน้าจอสัมผัส
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

/** เปิดใน iOS (Safari/เบราว์เซอร์) และยังไม่ได้ติดตั้งเป็นแอป */
export const needsInstallGuide = () => isIOS() && !isStandalone();

const DAY = 24 * 60 * 60 * 1000;

/** แสดงคู่มืออัตโนมัติถ้ายังไม่ได้ติดตั้ง และไม่ได้กด "ไว้ทีหลัง" ในช่วง 3 วัน */
export async function shouldAutoShowGuide() {
  if (!needsInstallGuide()) return false;
  const at = await db.getMeta('install_dismissed_at');
  return !at || Date.now() - new Date(at).getTime() > 3 * DAY;
}

export function openInstallGuide({ auto = false } = {}) {
  const step = (n, ...content) => h('li', { class: 'step' }, h('span', { class: 'step-no' }, String(n)), h('div', null, ...content));
  const ios = isIOS();
  const sheet = openSheet({
    title: 'ติดตั้งแอปลงหน้าจอโฮม',
    onClose: () => {
      if (auto) db.setMeta('install_dismissed_at', new Date().toISOString());
    },
    content: h(
      'div',
      { class: 'stack' },
      ios
        ? h('p', null, 'เพิ่มแอปนี้ไปยังหน้าจอโฮมของ iPhone เพื่อเปิดเต็มจอ ใช้ออฟไลน์ในยิมได้ และเก็บข้อมูลได้มั่นคงกว่าเปิดผ่านแท็บเบราว์เซอร์')
        : h('p', null, 'แอปนี้เป็น PWA ติดตั้งลงเครื่องได้ ขั้นตอนด้านล่างเป็นของ iPhone/iPad (Safari) ส่วน Android/คอมพิวเตอร์ใช้เมนู "ติดตั้งแอป" ของเบราว์เซอร์'),
      h(
        'ol',
        { class: 'steps' },
        step(1, h('strong', null, 'เปิดหน้านี้ด้วย Safari'), ' (ถ้าเปิดจากแอปอื่น ให้คัดลอกลิงก์ไปเปิดใน Safari)'),
        step(2, 'แตะปุ่ม ', h('strong', null, 'แชร์ '), h('span', { class: 'inline-icon' }, icon('share', 18)), ' ที่แถบด้านล่าง (บน iPad อยู่แถบด้านบน)'),
        step(3, 'เลื่อนลงแล้วแตะ ', h('strong', null, '"เพิ่มไปยังหน้าจอโฮม"'), ' (Add to Home Screen)'),
        step(4, 'แตะ ', h('strong', null, '"เพิ่ม"'), ' มุมขวาบน แล้วเปิดแอปจากไอคอนบนหน้าจอโฮมทุกครั้ง')
      ),
      h(
        'div',
        { class: 'callout info' },
        h('strong', null, 'ควรรู้ '),
        'ข้อมูลที่จดในแท็บ Safari กับในแอปที่ติดตั้งอาจแยกกัน ควรติดตั้งก่อนเริ่มจดจริง (หรือส่งออกแล้วนำเข้าเพื่อย้ายข้อมูล) และ iOS อาจล้างข้อมูลเว็บที่ไม่ได้เปิดนาน จึงควรกด "ส่งออกข้อมูล" สำรองไว้เป็นระยะ'
      ),
      h('button', { class: 'btn primary', onclick: () => sheet.close() }, auto ? 'ไว้ทีหลัง' : 'เข้าใจแล้ว')
    ),
  });
  return sheet;
}
