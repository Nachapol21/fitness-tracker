// การกระทำของร้านแลกรางวัล (แลก / ซื้อไฟสำรอง / ยกเลิกการแลก) — ไม่แตะ DOM
// รับ `store` เข้ามา (ในแอปคือ js/db.js, ในเทสต์คือที่เก็บจำลอง) ต้องมี: create(table, fields), update(table, id, patch), remove(table, id), uuid()
// ตัวเลข coin ไม่เคยถูกเขียนที่นี่ — มีแค่ "redemption" (รายการใช้) ส่วนยอดคำนวณจาก log ใน game.js

import { canCancelRedemption, checkRedeem } from './game.js';

export class GameError extends Error {}

// กันแลก/ซื้อซ้ำจากข้อมูลเก่า (เช่น sheet สองอันที่เปิดค้างไว้ หรือกดรัว): ต่อ store หนึ่งตัวมี
//  1) คิวทำทีละงาน (ไม่ให้ตรวจ-เขียนซ้อนกัน)
//  2) ความจำของรายการที่เพิ่งเขียนใน ~2 นาทีนี้ ซึ่งถูกรวมเข้าการตรวจ (cooldown/ยอด/ไฟสำรอง) ถ้า snapshot ที่ผู้เรียกส่งมายังไม่เห็นรายการนั้น
// (ผู้เรียกที่โหลดข้อมูลใหม่ก่อนเรียกก็ปลอดภัยเหมือนกัน — รายการที่ id ตรงกันจะไม่ถูกนับซ้ำ)
const RECENT_MS = 120000;
const queues = new WeakMap();
const recents = new WeakMap();

function withLock(store, fn) {
  const prev = queues.get(store) || Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(store, run.catch(() => {}));
  return run;
}
function recentOf(store, snapshot) {
  const now = Date.now();
  const list = (recents.get(store) || []).filter((r) => now - r.at < RECENT_MS);
  recents.set(store, list);
  const known = new Set((snapshot || []).map((r) => r.id));
  return list.filter((r) => !known.has(r.id) && !r.cancelled);
}
function remember(store, rec) {
  const list = recents.get(store) || [];
  list.push({ ...rec, at: Date.now() });
  recents.set(store, list);
}
/** รวม snapshot กับรายการที่เพิ่งเขียน แล้วปรับยอด/ไฟสำรองให้ตรงกับความจริงล่าสุด */
function effective(store, { game, redemptions }) {
  const extra = recentOf(store, redemptions);
  const spentExtra = extra.reduce((a, r) => a + (Number(r.coins) || 0), 0);
  return {
    redemptions: [...(redemptions || []), ...extra],
    game: { ...game, balance: game.balance - spentExtra, freeze: { ...game.freeze, held: game.freeze.held || extra.some((r) => r.kind === 'freeze') } },
  };
}

/** ซื้อ/แลก: ตรวจเงื่อนไขอีกรอบก่อนเขียน (ยอดและ cooldown อิงข้อมูลที่ส่งมา) */
export function redeemReward(store, args) {
  return withLock(store, () => doRedeem(store, args));
}

async function doRedeem(store, { reward, game: g0, redemptions: r0, today, addFood = false, foodKcal = null, meal = 'ของว่าง' }) {
  const { game, redemptions } = effective(store, { game: g0, redemptions: r0 });
  const chk = checkRedeem({ kind: 'reward', reward, balance: game.balance, redemptions, today, freezeHeld: game.freeze.held });
  if (!chk.ok) throw new GameError(chk.text);
  const kcal = Number.isFinite(Number(foodKcal)) && foodKcal !== null ? Number(foodKcal) : Number(reward.kcal) || 0;
  const wantFood = addFood && Number(reward.kcal) > 0 && kcal > 0;
  const foodLogId = wantFood ? store.uuid() : null;
  const redemption = await store.create('redemptions', {
    date: today,
    kind: 'reward',
    reward_id: reward.id,
    name: reward.name,
    emoji: reward.emoji || '',
    price: Number(reward.price) || 0, // snapshot ณ ตอนแลก (แก้ราคารางวัลทีหลังไม่กระทบประวัติ)
    coins: chk.price,
    kcal: Number(reward.kcal) || 0,
    food_log_id: foodLogId,
  });
  remember(store, redemption);
  let foodLog = null;
  if (wantFood) {
    foodLog = await store.create('food_logs', {
      id: foodLogId,
      date: today,
      meal,
      food_id: null,
      name: `${reward.emoji || ''} ${reward.name}`.trim(),
      serving: '',
      qty: 1,
      kcal,
      protein: 0,
      carb: 0,
      fat: 0,
      quick: true,
    });
  }
  return { redemption, foodLog };
}

/** ซื้อไฟสำรอง 🧊 (ถือได้ทีละ 1 อัน) */
export function buyFreeze(store, args) {
  return withLock(store, () => doBuyFreeze(store, args));
}

async function doBuyFreeze(store, { game: g0, redemptions: r0, today }) {
  const { game, redemptions } = effective(store, { game: g0, redemptions: r0 });
  const chk = checkRedeem({ kind: 'freeze', balance: game.balance, redemptions, today, freezeHeld: game.freeze.held, freezePrice: game.freeze.price });
  if (!chk.ok) throw new GameError(chk.text);
  const rec = await store.create('redemptions', {
    date: today,
    kind: 'freeze',
    reward_id: null,
    name: 'ไฟสำรอง',
    emoji: '🧊',
    price: chk.price,
    coins: chk.price,
    kcal: 0,
    food_log_id: null,
  });
  remember(store, rec);
  return rec;
}

/** ยกเลิกการแลก (เฉพาะวันเดียวกัน): soft delete redemption และบันทึกการกินที่ผูกไว้ */
export async function cancelRedemption(store, redemption, { today }) {
  if (!canCancelRedemption(redemption, today)) throw new GameError('ยกเลิกได้เฉพาะรายการที่แลกวันนี้');
  await store.remove('redemptions', redemption.id);
  for (const r of recents.get(store) || []) if (r.id === redemption.id) r.cancelled = true;
  if (redemption.food_log_id) {
    try {
      await store.remove('food_logs', redemption.food_log_id);
    } catch {
      /* บันทึกการกินถูกลบไปก่อนแล้ว */
    }
  }
}
