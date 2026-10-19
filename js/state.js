// สถานะชั่วคราวของหน้าจอ (ไม่เก็บลงฐานข้อมูล)

import { addDays, toDateStr } from './dates.js';

export const state = {
  date: null, // null = ตามวันนี้เสมอ
  meal: null,
  insightsTab: 'week',
  insightsWeek: null,
  weightRange: 90,
  foodRange: 14,
  exerciseId: null,
  exMetric: 'e1rm',
};

export const getDate = () => state.date || toDateStr();

export function setDate(d) {
  state.date = d === toDateStr() ? null : d;
}

export const shiftDate = (n) => setDate(addDays(getDate(), n));

/** เดามื้อจากเวลาปัจจุบัน */
export function guessMeal(d = new Date()) {
  const h = d.getHours();
  if (h < 10) return 'เช้า';
  if (h < 15) return 'กลางวัน';
  if (h < 17) return 'ของว่าง';
  return 'เย็น';
}

export const getMeal = () => state.meal || guessMeal();
