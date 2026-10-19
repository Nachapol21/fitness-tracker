// หน้าจอเกม coin + streak: การ์ดในหน้า "วันนี้" · ร้านแลกรางวัล (#/shop) · ประวัติ coin (#/coins) · แอนิเมชันฉลอง
// ตัวเลขทั้งหมดคำนวณจาก log ใน js/game.js (ไม่เก็บ +coin) — ไฟล์นี้มีแค่ส่วนแสดงผลและเรียกการกระทำ

import * as db from '../db.js';
import { computeGame, tierMultiplier, REASON_LABELS, bigMealAdvice, canCancelRedemption, checkRedeem, coinTransactions, groupTransactions } from '../game.js';
import { GameError, buyFreeze, cancelRedemption, redeemReward } from '../game-actions.js';
import { diffDays, fmtLong, fmtShort, toDateStr } from '../dates.js';
import { MEALS } from '../constants.js';
import { getMeal } from '../state.js';
import { chipGroup, confirmSheet, field, fmtInt, h, mount, numInput, openSheet, readNum, textInput, toast } from '../ui.js';

/** โหลดข้อมูลทั้งหมดแล้วคำนวณสถานะเกม ณ วันนี้ */
export async function loadGame() {
  const [data, profile, settings] = await Promise.all([db.loadAll(), db.getProfile(), db.getGameSettings()]);
  const today = toDateStr();
  const game = computeGame({
    asOf: today,
    profile,
    settings,
    foodLogs: data.food_logs,
    bodyLogs: data.body_logs,
    sessions: data.sessions,
    sets: data.sets,
    cardio: data.cardio,
    exercises: data.exercises,
    redemptions: data.redemptions,
  });
  return { game, data, profile, settings: game.settings, today };
}

const fmtMult = (m) => `×${Number.isInteger(m) ? m : Math.round(m * 100) / 100}`;
const signed = (n) => (n > 0 ? `+${fmtInt(n)}` : n < 0 ? `−${fmtInt(-n)}` : '0');
const backLink = (href = '#/today') => h('a', { class: 'btn small ghost', href }, '‹ กลับ');

// ---------- การ์ดในหน้า "วันนี้" ----------

export async function gameCard() {
  let state;
  try {
    state = await loadGame();
  } catch (err) {
    console.error(err);
    return null; // เกมพังต้องไม่ทำให้หน้าวันนี้ใช้ไม่ได้
  }
  const { game, profile } = state;
  const st = game.streak;
  const noTarget = !(Number(profile.kcal) > 0);
  const recentBreak = st.lastBreak && st.display === 0 && diffDays(st.lastBreak.date, state.today) <= 2;

  const messages = [];
  const t = game.today;
  if (t && !t.coinStarted) messages.push(['', `coin เริ่มนับตั้งแต่ ${fmtShort(game.settings.start_date)} (ตั้งค่าเกมแก้ได้) · ไฟนับจากประวัติทั้งหมดตามปกติ`]);
  if (t && st.todayStatus !== 'pass' && st.todayStatus !== 'allowed') {
    const left = Math.max(0, game.rest.cap - game.rest.used);
    messages.push(['', t.trainingDay ? 'วันนี้เป็นวันฝึกตามแผน 💪' : `วันพักตามแผน — พักได้อีก ${left} วันในสัปดาห์นี้`]);
  }
  if (noTarget) messages.push(['notice', 'ตั้งเป้าแคลอรี่ในโปรไฟล์ก่อน แอปถึงจะนับไฟและ coin แคลอรี่ให้ได้']);
  else if (recentBreak) messages.push(['', 'ไฟดับไปแล้ว เริ่มใหม่ได้เลย วันนี้เป็นวันแรกของไฟรอบใหม่ 🔥']);
  else if (st.todayStatus === 'allowed') messages.push(['ok', 'วันนี้เป็นวันได้รับอนุญาต ไฟไม่ดับ สนุกกับรางวัลได้เลย 🎉']);
  else if (st.todayStatus === 'pass') messages.push(['ok', 'วันนี้ไฟติดแล้ว เก่งมาก! 🔥']);
  if (st.nextTier && st.run > 0) messages.push(['', `อีก ${st.nextTier.left} วันถึงตัวคูณ ${fmtMult(st.nextTier.mult)}`]);
  if (game.balance < 0) messages.push(['warn', `ยอด coin ติดลบ ${fmtInt(-game.balance)} เพราะข้อมูลย้อนหลังเปลี่ยน ไม่เป็นไร เก็บเพิ่มแล้วจะกลับมาเป็นบวก (ตอนนี้ยังแลกไม่ได้)`]);

  const stat = (top, label, extra) => h('div', { class: 'game-stat' }, h('strong', null, top), h('small', null, label), extra ? h('small', { class: 'muted' }, extra) : null);
  const todo = game.today?.todo || [];

  const card = h(
    'section',
    { class: 'card game-card', id: 'game-card' },
    h('div', { class: 'card-head' }, h('h2', null, '🎮 เกม'), h('span', { class: 'coin-pill', 'aria-label': `ยอด coin ${game.balance}` }, `🪙 ${fmtInt(game.balance)}`)),
    h(
      'div',
      { class: 'game-stats' },
      stat([h('span', { class: st.display > 0 ? 'flame' : '' }, '🔥'), ` ${st.display}`], 'ไฟรายวัน (วัน)'),
      stat(`${st.weeks}`, 'ไฟรายสัปดาห์', `สัปดาห์นี้ ${st.weekCount}/${st.weekTarget}`),
      stat(fmtMult(st.multiplier), 'ตัวคูณ coin', game.freeze.held ? '🧊 มีไฟสำรอง' : null)
    ),
    messages.map(([kind, text]) => h('p', { class: kind === 'notice' || kind === 'warn' ? 'callout warn' : kind === 'ok' ? 'callout ok' : 'muted small-text' }, text)),
    todo.length
      ? h(
          'div',
          { class: 'stack tight' },
          h('h3', null, 'วันนี้ยังได้อีก'),
          h(
            'ul',
            { class: 'todo-list' },
            todo.map((t) => h('li', { class: t.pending ? 'pending' : '' }, h('span', { class: 'txt' }, t.text), h('span', { class: 'gain' }, `+${t.coins}`)))
          )
        )
      : h('p', { class: 'muted' }, 'วันนี้เก็บ coin ครบทุกอย่างแล้ว 👏'),
    h('div', { class: 'row gap' }, h('a', { class: 'btn primary grow', href: '#/shop' }, '🛍️ ร้านรางวัล'), h('a', { class: 'btn grow', href: '#/coins' }, 'ประวัติ coin'))
  );
  maybeCelebrate(state).catch(console.error);
  return card;
}

// ---------- ฉลองเมื่อไฟถึง 7 / 14 / 30 วัน ----------

let celebrating = false;

async function maybeCelebrate({ game, settings }) {
  // ใช้จำนวนวันเดียวกับที่การ์ดแสดง (display = ไฟที่ยืนยันแล้ว + วันนี้ถ้าผ่านแล้ว) ไม่งั้นการ์ดโชว์ 7 แต่ยังไม่ฉลอง
  const run = game.streak.display;
  const runStart = game.streak.displayStart;
  if (celebrating || !run || !runStart) return;
  const milestones = [settings.tier1_days, settings.tier2_days, settings.tier3_days].filter((m) => run >= m).sort((a, b) => a - b);
  if (!milestones.length) return;
  celebrating = true;
  try {
    const seen = new Set(await db.getMeta('game_celebrated', []));
    const keyOf = (m) => `${m}@${runStart}`; // หนึ่งเหตุการณ์ = ไฟรอบนี้ถึงหลักนี้ (ไฟดับแล้วถึงใหม่ถือเป็นเหตุการณ์ใหม่)
    const fresh = milestones.filter((m) => !seen.has(keyOf(m)));
    if (!fresh.length) return;
    milestones.forEach((m) => seen.add(keyOf(m)));
    await db.setMeta('game_celebrated', [...seen].slice(-60)); // meta ไม่ซิงก์: แต่ละเครื่องฉลองของตัวเอง
    const days = fresh[fresh.length - 1];
    const active = game.streak.run >= days; // ไฟที่ยืนยันแล้วถึงหลักนี้ = ตัวคูณใช้ตั้งแต่วันนี้ · ไม่งั้นเริ่มพรุ่งนี้
    openCelebration(days, active ? game.streak.multiplier : tierMultiplier(run, settings), { fromTomorrow: !active });
  } finally {
    celebrating = false;
  }
}

export function openCelebration(days, mult, { fromTomorrow = false } = {}) {
  const colors = ['#f97316', '#facc15', '#22c55e', '#38bdf8', '#a78bfa', '#f43f5e'];
  const confetti = Array.from({ length: 28 }, (_, i) =>
    h('span', { class: 'confetti', 'aria-hidden': 'true', style: { '--x': `${(i * 37) % 100}%`, '--c': colors[i % colors.length], '--delay': `${((i * 53) % 700) / 1000}s`, '--dur': `${1.6 + ((i * 29) % 12) / 10}s` } })
  );
  openSheet({
    title: `ไฟถึง ${days} วันแล้ว!`,
    content: (close) =>
      h(
        'div',
        { class: 'celebrate stack', role: 'status' },
        ...confetti,
        h('div', { class: 'celebrate-fire', 'aria-hidden': 'true' }, '🔥'),
        h('p', { class: 'center' }, h('strong', null, `ทำตามแผนติดกัน ${days} วัน`), h('br'), `ตัวคูณ coin ${fmtMult(mult)} ${fromTomorrow ? 'เริ่มพรุ่งนี้' : 'ตอนนี้'} เก่งมาก ไปต่อด้วยกันนะ`),
        h('button', { class: 'btn primary', onclick: () => close() }, 'ขอบคุณ!')
      ),
  });
}

// ---------- ร้านแลกรางวัล ----------

const byPrice = (a, b) => (a.price === b.price ? String(a.name).localeCompare(String(b.name), 'th') : a.price - b.price);

export async function renderShop(root) {
  const { game, data, settings, today } = await loadGame();
  const refresh = () => renderShop(root);
  const rewards = [...data.rewards].sort(byPrice);
  const redemptions = data.redemptions;
  const todays = redemptions.filter((r) => canCancelRedemption(r, today)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const ctx = { game, data, settings, today, redemptions, refresh };

  const rewardRow = (r) => {
    const chk = checkRedeem({ reward: r, balance: game.balance, redemptions, today, freezeHeld: game.freeze.held });
    const meta = [`${fmtInt(r.price)} coin`, Number(r.kcal) > 0 ? `≈ ${fmtInt(r.kcal)} kcal` : null, Number(r.cooldown_days) > 0 ? `แลกซ้ำได้ทุก ${r.cooldown_days} วัน` : null].filter(Boolean).join(' · ');
    return h(
      'li',
      { class: `reward-row ${r.active === false ? 'faded' : ''}`, 'data-reward': r.id },
      h('span', { class: 'reward-emoji', 'aria-hidden': 'true' }, r.emoji || '🎁'),
      h(
        'div',
        { class: 'grow' },
        h('strong', null, r.name, r.active === false ? h('span', { class: 'tag' }, 'ปิดใช้') : null),
        h('small', { class: 'muted block' }, meta),
        !chk.ok ? h('small', { class: 'reason block', 'data-reason': chk.code }, chk.text) : null
      ),
      h(
        'div',
        { class: 'reward-actions' },
        h('button', { class: 'btn small primary', disabled: !chk.ok, onclick: () => openRedeem(r, ctx) }, 'แลก'),
        h('button', { class: 'btn small ghost', onclick: () => openRewardEditor(r, refresh) }, 'แก้')
      )
    );
  };

  const fchk = checkRedeem({ kind: 'freeze', balance: game.balance, redemptions, today, freezeHeld: game.freeze.held, freezePrice: game.freeze.price });

  mount(
    root,
    h('header', { class: 'page-head' }, backLink(), h('h1', null, 'ร้านแลกรางวัล'), h('button', { class: 'btn small', onclick: () => openRewardEditor(null, refresh) }, '+ เพิ่ม')),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('span', { class: 'muted' }, 'coin ที่มี'), h('a', { class: 'btn small ghost', href: '#/coins' }, 'ประวัติ')),
      h('div', { class: 'big', id: 'shop-balance' }, `🪙 ${fmtInt(game.balance)}`),
      game.balance < 0 ? h('p', { class: 'callout warn' }, 'ยอดติดลบเพราะข้อมูลย้อนหลังเปลี่ยน ยังแลกไม่ได้จนกว่าจะกลับมาเป็นบวก ไม่เป็นไร เก็บเพิ่มได้เรื่อยๆ') : null,
      h('p', { class: 'muted small-text' }, `ตัวคูณตอนนี้ ${fmtMult(game.streak.multiplier)} · ไฟรายวัน ${game.streak.display} วัน`)
    ),
    rewards.length
      ? h('section', { class: 'card flush' }, h('div', { class: 'card-head pad-h' }, h('h2', null, 'รางวัล')), h('ul', { class: 'list reward-list' }, rewards.map(rewardRow)))
      : h('section', { class: 'card' }, h('p', { class: 'muted' }, 'ยังไม่มีรางวัล กด "+ เพิ่ม" เพื่อสร้างรางวัลของคุณ')),
    h(
      'section',
      { class: 'card', id: 'freeze-card' },
      h('div', { class: 'card-head' }, h('h2', null, '🧊 ไฟสำรอง'), h('span', { class: 'muted' }, `${fmtInt(game.freeze.price)} coin`)),
      h('p', { class: 'muted small-text' }, 'ถือได้ทีละ 1 อัน ใช้เองอัตโนมัติกับวันแรกที่พลาดหลังซื้อ (ไม่ใช้กับวันนี้ เพราะวันนี้ยังไม่จบ) กันไม่ให้ไฟดับ'),
      game.freeze.held ? h('p', { class: 'callout ok' }, 'ตอนนี้คุณมีไฟสำรอง 1 อัน พร้อมใช้') : null,
      h('button', { class: 'btn', disabled: !fchk.ok, onclick: () => openBuyFreeze(ctx) }, 'ซื้อไฟสำรอง'),
      !fchk.ok && !game.freeze.held ? h('small', { class: 'reason', 'data-reason': fchk.code }, fchk.text) : null
    ),
    todays.length
      ? h(
          'section',
          { class: 'card' },
          h('h2', null, 'แลกวันนี้'),
          h('p', { class: 'muted small-text' }, 'กดผิดยกเลิกได้ภายในวันนี้ จะคืน coin และเอารายการที่เพิ่มลงบันทึกการกินออกให้'),
          h(
            'ul',
            { class: 'list' },
            todays.map((r) =>
              h(
                'li',
                { class: 'reward-row', 'data-redemption': r.id },
                h('span', { class: 'reward-emoji', 'aria-hidden': 'true' }, r.emoji || '🎁'),
                h('div', { class: 'grow' }, h('strong', null, r.name), h('small', { class: 'muted block' }, `${fmtInt(r.coins)} coin${r.food_log_id ? ' · เพิ่มลงบันทึกการกินแล้ว' : ''}`)),
                h(
                  'button',
                  {
                    class: 'btn small danger-outline',
                    onclick: async () => {
                      if (!(await confirmSheet(`ยกเลิกการแลก "${r.name}"?\nคืน ${fmtInt(r.coins)} coin${r.food_log_id ? ' และเอารายการที่เพิ่มในบันทึกการกินออก' : ''}`, { okText: 'ยกเลิกการแลก', cancelText: 'ไม่ยกเลิก', danger: true, title: 'ยกเลิกการแลก' }))) return;
                      try {
                        await cancelRedemption(db, r, { today });
                        toast('ยกเลิกแล้ว คืน coin ให้แล้ว');
                      } catch (e) {
                        toast(e instanceof GameError ? e.message : 'ยกเลิกไม่สำเร็จ');
                      }
                      refresh();
                    },
                  },
                  'ยกเลิกการแลก'
                )
              )
            )
          )
        )
      : null,
    h('p', { class: 'muted small-text' }, 'แลกของกินแล้ว วันนั้นนับเป็นวัน "ได้รับอนุญาต" ไฟรายวันไม่ดับ แม้แคลอรี่เกินช่วง (สัปดาห์ละ 1 วัน) · ค่า kcal ของรางวัลเป็นค่าประมาณ แก้ได้ตอนแลก')
  );
}

let sheetBusy = false; // กันเปิด sheet แลก/ซื้อซ้อนกัน (กดปุ่มรัว)

function openBuyFreeze({ game, refresh }) {
  if (sheetBusy) return;
  sheetBusy = true;
  confirmSheet(`ซื้อไฟสำรอง 🧊 ราคา ${fmtInt(game.freeze.price)} coin?\nเหลือ ${fmtInt(game.balance - game.freeze.price)} coin`, { okText: 'ซื้อเลย', title: 'ไฟสำรอง' }).then(async (ok) => {
    sheetBusy = false;
    if (!ok) return;
    try {
      const fresh = await loadGame(); // ตรวจจากข้อมูลล่าสุดตอนกดยืนยัน ไม่ใช่ตอนวาดหน้า
      await buyFreeze(db, { game: fresh.game, redemptions: fresh.data.redemptions, today: fresh.today });
      toast('ได้ไฟสำรองแล้ว 🧊 จะใช้เองเมื่อพลาดวันแรก');
    } catch (e) {
      toast(e instanceof GameError ? e.message : 'ซื้อไม่สำเร็จ');
    }
    refresh();
  });
}

/** ขั้นตอนแลก: ยืนยัน → (ของกิน) ถามเพิ่มลงบันทึกการกิน/แก้ kcal/มื้อ → แลก → คำแนะนำ */
function openRedeem(reward, { game, settings, refresh }) {
  if (sheetBusy) return;
  sheetBusy = true;
  const isFood = Number(reward.kcal) > 0;
  const addFood = h('input', { type: 'checkbox', checked: true, id: 'redeem-add-food' });
  const kcal = numInput({ value: reward.kcal, inputmode: 'numeric', 'aria-label': 'kcal ประมาณ', id: 'redeem-kcal' });
  const meal = chipGroup({ options: MEALS, value: getMeal() });
  const err = h('p', { class: 'bad-text', role: 'alert' });
  const allowedLeft = game.allowed.cap - game.allowed.used;
  let busy = false;

  const sheet = openSheet({
    title: `แลก ${reward.emoji || ''} ${reward.name}`.trim(),
    onClose: () => {
      sheetBusy = false;
      refresh();
    },
    content: (close) => {
      const fields = h('div', { class: 'stack', id: 'redeem-food-fields' }, field('kcal ประมาณ (แก้ได้)', kcal), field('ลงมื้อ', meal.el));
      addFood.addEventListener('change', () => (fields.hidden = !addFood.checked));
      return h(
        'div',
        { class: 'stack' },
        h('p', null, `ใช้ ${fmtInt(reward.price)} coin · เหลือ ${fmtInt(game.balance - reward.price)} coin`),
        isFood ? h('label', { class: 'check' }, addFood, h('span', null, 'เพิ่มลงบันทึกการกินวันนี้')) : null,
        isFood ? fields : null,
        isFood
          ? h(
              'p',
              { class: 'callout' },
              allowedLeft > 0
                ? 'วันนี้จะนับเป็นวัน "ได้รับอนุญาต" ไฟรายวันไม่ดับ แม้แคลอรี่เกินช่วง'
                : 'สัปดาห์นี้ใช้สิทธิ์วัน "ได้รับอนุญาต" ครบแล้ว ถ้าวันนี้แคลอรี่เกินช่วง ไฟอาจหยุดนับ แต่ coin ที่มีไม่หาย หรือจะรอแลกสัปดาห์หน้าก็ได้'
            )
          : null,
        err,
        h(
          'div',
          { class: 'row gap' },
          h('button', { class: 'btn ghost grow', onclick: () => close() }, 'ยกเลิก'),
          h(
            'button',
            {
              class: 'btn primary grow',
              id: 'redeem-confirm',
              onclick: async (e) => {
                if (busy) return;
                busy = true;
                e.currentTarget.disabled = true;
                try {
                  const useKcal = readNum(kcal);
                  // โหลดข้อมูลล่าสุดตอนกดยืนยัน แล้วตรวจยอด/cooldown/ราคาจากค่านั้น (กันข้อมูลเก่าจาก sheet ที่เปิดค้างหรือซิงก์เข้ามาระหว่างนั้น)
                  const fresh = await loadGame();
                  const current = fresh.data.rewards.find((x) => x.id === reward.id);
                  if (!current) throw new GameError('ไม่พบรางวัลนี้แล้ว (อาจถูกลบจากอีกเครื่อง)');
                  if (current.price !== reward.price) throw new GameError('ราคารางวัลเปลี่ยนไปแล้ว ปิดแล้วเปิดใหม่อีกครั้ง');
                  const { foodLog } = await redeemReward(db, { reward: current, game: fresh.game, redemptions: fresh.data.redemptions, today: fresh.today, addFood: isFood && addFood.checked, foodKcal: useKcal, meal: meal.get() });
                  const eaten = foodLog ? foodLog.kcal : Number(reward.kcal) || 0;
                  const advice = isFood && eaten > 0 ? bigMealAdvice(eaten, settings) : null;
                  sheet.setContent(
                    h(
                      'div',
                      { class: 'stack' },
                      h('p', null, h('strong', null, `แลก ${reward.emoji || ''} ${reward.name} แล้ว`), foodLog ? ' และเพิ่มลงบันทึกการกินวันนี้แล้ว' : ''),
                      advice ? h('p', { class: 'callout', id: 'big-meal-advice' }, advice) : null,
                      h('p', { class: 'muted' }, 'ขอให้อร่อย/สนุกนะ 🎉'),
                      h('button', { class: 'btn primary', onclick: () => sheet.close() }, 'ตกลง')
                    ),
                    'แลกสำเร็จ'
                  );
                } catch (ex) {
                  busy = false;
                  e.currentTarget.disabled = false;
                  err.textContent = ex instanceof GameError ? ex.message : String(ex.message || ex);
                }
              },
            },
            'แลกเลย'
          )
        )
      );
    },
  });
}

/** เพิ่ม/แก้/ลบรางวัล (ลบแบบ soft delete) */
function openRewardEditor(reward, refresh) {
  const r = reward || {};
  const emoji = textInput({ value: r.emoji || '', placeholder: '🎁', maxlength: 4, 'aria-label': 'emoji' });
  const name = textInput({ value: r.name || '', placeholder: 'เช่น ชานมไข่มุก', 'aria-label': 'ชื่อรางวัล' });
  const price = numInput({ value: r.price ?? '', placeholder: 'coin', inputmode: 'numeric', 'aria-label': 'ราคา coin' });
  const kcal = numInput({ value: r.kcal ?? 0, placeholder: '0', inputmode: 'numeric', 'aria-label': 'kcal ประมาณ' });
  const cooldown = numInput({ value: r.cooldown_days ?? 0, placeholder: '0', inputmode: 'numeric', 'aria-label': 'แลกซ้ำได้ทุกกี่วัน' });
  const active = h('input', { type: 'checkbox', checked: reward ? r.active !== false : true });
  const err = h('p', { class: 'bad-text', role: 'alert' });
  const sheet = openSheet({
    title: reward ? 'แก้รางวัล' : 'เพิ่มรางวัล',
    content: (close) =>
      h(
        'form',
        {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const p = readNum(price);
            if (!name.value.trim()) return void (err.textContent = 'ใส่ชื่อรางวัลก่อน');
            if (p === null || !Number.isInteger(p) || p < 1) return void (err.textContent = 'ใส่ราคา coin เป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
            const fields = { name: name.value.trim(), emoji: emoji.value.trim() || '🎁', price: p, kcal: Math.max(0, Math.round(readNum(kcal) ?? 0)), cooldown_days: Math.max(0, Math.round(readNum(cooldown) ?? 0)), active: active.checked };
            if (reward) await db.update('rewards', reward.id, fields);
            else await db.create('rewards', fields);
            close();
            refresh();
          },
        },
        h('div', { class: 'grid2' }, field('emoji', emoji), field('ชื่อรางวัล', name)),
        h('div', { class: 'grid3' }, field('ราคา (coin)', price), field('kcal ประมาณ', kcal), field('ซ้ำได้ทุก (วัน)', cooldown)),
        h('p', { class: 'muted small-text' }, 'kcal = 0 ถ้าไม่ใช่ของกิน (จะไม่ถามเพิ่มลงบันทึกการกิน และไม่นับเป็นวันได้รับอนุญาต)'),
        h('label', { class: 'check' }, active, h('span', null, 'เปิดใช้รางวัลนี้')),
        err,
        h(
          'div',
          { class: 'row gap' },
          reward
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn danger-outline',
                  onclick: async () => {
                    if (!(await confirmSheet(`ลบ "${reward.name}" ออกจากร้าน? (ประวัติที่เคยแลกไม่หาย)`, { okText: 'ลบ', danger: true }))) return;
                    await db.remove('rewards', reward.id);
                    close();
                    refresh();
                  },
                },
                'ลบ'
              )
            : null,
          h('button', { type: 'submit', class: 'btn primary grow' }, 'บันทึก')
        )
      ),
  });
  setTimeout(() => (reward ? price : name).focus(), 50);
  return sheet;
}

// ---------- ประวัติ coin ----------

export async function renderCoins(root, params = []) {
  const { game, data } = await loadGame();
  const rows = coinTransactions(game, data.redemptions);
  const groups = groupTransactions(rows);
  const PAGE = 30;
  const shown = Math.max(PAGE, Number(params[0]) || PAGE);
  const rerender = (n) => {
    history.replaceState(null, '', `#/coins/${n}`);
    renderCoins(root, [String(n)]);
  };

  const label = (t) => {
    const base = REASON_LABELS[t.reason] || t.reason;
    return t.reason === 'pr' && t.detail ? `${base}: ${t.detail}` : t.kind === 'spend' && t.detail ? `${base}: ${t.detail}` : base;
  };

  mount(
    root,
    h('header', { class: 'page-head' }, backLink(), h('h1', null, 'ประวัติ coin'), h('a', { class: 'btn small', href: '#/shop' }, 'ร้าน')),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'big', id: 'coins-balance' }, `🪙 ${fmtInt(game.balance)}`),
      h('div', { class: 'grid2' }, h('div', { class: 'stat' }, h('small', { class: 'muted' }, 'ได้ทั้งหมด'), h('strong', { class: 'stat-val good-text' }, `+${fmtInt(game.earned)}`)), h('div', { class: 'stat' }, h('small', { class: 'muted' }, 'ใช้ไปแล้ว'), h('strong', { class: 'stat-val' }, `−${fmtInt(game.spent)}`))),
      h('p', { class: 'muted small-text' }, 'coin คำนวณจากข้อมูลที่จดไว้ทุกครั้ง ถ้าแก้ข้อมูลย้อนหลัง ยอดจะคำนวณใหม่ตามจริง และการแก้ย้อนหลังเกิน 2 วันจะไม่ได้ coin (แต่ยังนับในไฟ) · coin ของแคลอรี่จะเข้าเมื่อวันนั้นจบ')
    ),
    groups.length
      ? [
          groups.slice(0, shown).map((g) =>
            h(
              'section',
              { class: 'card flush', 'data-day': g.date },
              h('div', { class: 'card-head pad-h' }, h('h2', null, fmtLong(g.date)), h('strong', { class: g.total < 0 ? '' : 'good-text' }, signed(g.total))),
              h(
                'ul',
                { class: 'list' },
                g.rows.map((t) =>
                  h(
                    'li',
                    { class: 'tx-row' },
                    h('span', { class: 'grow' }, label(t), t.kind === 'earn' && t.multiplier !== 1 ? h('small', { class: 'muted block' }, `${t.base} × ${fmtMult(t.multiplier).slice(1)} (ตัวคูณไฟ)`) : null),
                    h('strong', { class: t.amount < 0 ? '' : 'good-text' }, signed(t.amount))
                  )
                )
              )
            )
          ),
          groups.length > shown ? h('button', { class: 'btn', onclick: () => rerender(shown + PAGE) }, 'แสดงวันที่เก่ากว่า') : null,
        ]
      : h('section', { class: 'card' }, h('p', { class: 'muted' }, 'ยังไม่มี coin — จดการกิน การฝึก หรือน้ำหนักวันนี้แล้ว coin จะเริ่มเข้า'))
  );
}
