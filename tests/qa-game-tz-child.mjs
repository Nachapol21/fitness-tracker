// รันโดย qa-game.test.mjs ภายใต้ TZ ต่างๆ (child process) · พิมพ์ผลคำนวณเกมเป็น JSON เพื่อเทียบว่า "เหมือนกันทุกโซนเวลา"
// ครอบคลุม: สถานการณ์ 4 สัปดาห์, ขอบเที่ยงคืนเวลาไทย (16:59:59Z / 17:00:00Z), เวลา local ของเครื่องที่ใช้ toDateStr
import { computeGame } from '../js/game.js';
import { toDateStr } from '../js/dates.js';
import { World, handScenario, PROFILE } from './qa-game-helpers.mjs';

const main = handScenario().game('2026-10-19');

// ขอบเที่ยงคืนไทย: วันที่ 14 ต.ค. บันทึก created_at 16 ต.ค. 16:59:59Z (= 23:59:59 ไทย, ช้า 2 วัน) ได้ coin
// เทียบกับ 17:00:00Z (= 00:00:00 ไทย 17 ต.ค., ช้า 3 วัน) ไม่ได้ coin
const edge = (iso) => {
  const w = new World();
  w.body('2026-10-14', { weight_kg: 80 }, { created_at: iso });
  return w.game('2026-10-25').earned;
};

// เครื่องที่เวลาท้องถิ่นไม่ใช่ไทย: toDateStr ให้วันที่ตาม TZ ของเครื่อง · ใช้เวลาตายตัวเพื่อเทียบข้ามโซน
const localDay = toDateStr(new Date('2026-10-18T20:30:00.000Z'));

const gUtc = computeGame({ asOf: '2026-10-19', profile: PROFILE, foodLogs: [], bodyLogs: [], sessions: [], sets: [], cardio: [], exercises: [], redemptions: [] });

console.log(JSON.stringify({ main, edgeIn: edge('2026-10-16T16:59:59.000Z'), edgeOut: edge('2026-10-16T17:00:00.000Z'), localDay, emptyBalance: gUtc.balance }));
