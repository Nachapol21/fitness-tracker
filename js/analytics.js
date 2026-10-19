// สูตรคำนวณและการวิเคราะห์ทั้งหมด เป็นฟังก์ชันล้วน (pure) ไม่แตะ DOM/IndexedDB
// รับ array ของเรคคอร์ดที่ยังไม่ถูกลบเข้ามา แล้วคืนค่าที่คำนวณได้ ทดสอบได้ด้วย: node --test tests/

import { addDays, dateRange, diffDays, isDateStr, weekStart } from './dates.js';
import { isKcalMissing } from './food-quick.js';

export const KCAL_PER_KG = 7700; // พลังงานต่อน้ำหนักตัว 1 กก. (ค่าประมาณที่ใช้กันทั่วไป)

// ---------- ตัวช่วยตัวเลข ----------
export const round = (n, d = 0) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};
export const roundTo = (n, step) => Math.round(n / step) * step;
export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export const sum = (a) => a.reduce((s, x) => s + x, 0);
const live = (rows) => (rows || []).filter((r) => !r.deleted);

export function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
}

// ---------- 1. โปรไฟล์: BMR / TDEE / เป้า ----------

/** Mifflin-St Jeor: ชาย +5, หญิง −161 */
export function bmrMifflin({ sex, weight_kg, height_cm, age }) {
  const w = num(weight_kg);
  const h = num(height_cm);
  const a = num(age);
  if (!(w > 0) || !(h > 0) || !(a > 0)) return null;
  return 10 * w + 6.25 * h - 5 * a + (sex === 'female' ? -161 : 5);
}

export function tdeeFromBmr(bmr, activity) {
  const act = num(activity);
  if (bmr == null || !(act > 0)) return null;
  return bmr * act;
}

/**
 * แนะนำเป้าต่อวันจาก TDEE + เป้าหมาย
 * โปรตีน 1.7–2.0 ก./กก. · ไขมัน 0.8 ก./กก. · คาร์บ = ส่วนที่เหลือ
 * ถ้าเป้าลดน้ำหนักทำให้ kcal ต่ำกว่า BMR จะดันกลับมาที่ BMR และบอกผ่าน clamped
 */
export function suggestTargets({ weight_kg, bmr, tdee, goal, rate_kg_week }) {
  const w = num(weight_kg);
  if (!(w > 0) || bmr == null || tdee == null) return null;
  const rate = Math.abs(num(rate_kg_week) || 0);
  const perDay = (rate * KCAL_PER_KG) / 7;
  let kcal = tdee + (goal === 'lose' ? -perDay : goal === 'gain' ? perDay : 0);
  let clamped = false;
  const floor = roundTo(bmr, 50);
  kcal = roundTo(kcal, 50);
  if (goal === 'lose' && kcal < floor) {
    kcal = floor;
    clamped = true;
  }
  const protein_min = roundTo(1.7 * w, 5);
  const protein_max = roundTo(2.0 * w, 5);
  const fat = roundTo(0.8 * w, 5);
  const carb = Math.max(0, roundTo((kcal - ((protein_min + protein_max) / 2) * 4 - fat * 9) / 4, 5));
  return { kcal, protein_min, protein_max, fat, carb, clamped };
}

// ---------- 2. น้ำหนัก ----------

/** [{date, weight}] เรียงตามวันที่ 1 ค่าต่อวัน (ใช้ค่าที่แก้ล่าสุด) */
export function cleanWeights(bodyLogs) {
  const byDate = new Map();
  for (const b of live(bodyLogs)) {
    const w = num(b.weight_kg);
    if (!(w > 0) || !isDateStr(b.date)) continue; // ข้ามแถวที่ date เพี้ยน (เช่นมาจากไฟล์นำเข้า) กันหน้าล้ม
    const prev = byDate.get(b.date);
    if (!prev || (b.updated_at || '') > (prev.updated_at || '')) {
      byDate.set(b.date, { date: b.date, weight: w, updated_at: b.updated_at });
    }
  }
  return [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(({ date, weight }) => ({ date, weight }));
}

/** ค่าเฉลี่ยเคลื่อนที่ 7 วัน (นับเฉพาะวันที่มีค่าชั่งในช่วง 7 วันย้อนหลัง รวมวันนั้น) */
export function movingAverage(points, windowDays = 7) {
  return points.map((p) => {
    const inWin = points.filter((q) => {
      const d = diffDays(q.date, p.date);
      return d >= 0 && d < windowDays;
    });
    return { date: p.date, value: mean(inWin.map((q) => q.weight)), n: inWin.length };
  });
}

/** ค่าเฉลี่ยน้ำหนักรายสัปดาห์ (สัปดาห์เริ่มวันจันทร์) */
export function weeklyWeightAverages(points) {
  const m = new Map();
  for (const p of points) {
    const ws = weekStart(p.date);
    if (!m.has(ws)) m.set(ws, []);
    m.get(ws).push(p.weight);
  }
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ws, arr]) => ({ weekStart: ws, avg: mean(arr), n: arr.length }));
}

/** แนวโน้มน้ำหนักช่วง `days` วันล่าสุด (กก./สัปดาห์ ติดลบ = ลดลง) */
export function weightTrend(points, { asOf, days = 21 }) {
  const from = addDays(asOf, -(days - 1));
  const pts = points.filter((p) => p.date >= from && p.date <= asOf);
  if (pts.length < 3) return { ok: false, n: pts.length, spanDays: pts.length ? diffDays(pts[0].date, pts[pts.length - 1].date) : 0 };
  const x0 = pts[0].date;
  const reg = linearRegression(
    pts.map((p) => diffDays(x0, p.date)),
    pts.map((p) => p.weight)
  );
  const spanDays = diffDays(x0, pts[pts.length - 1].date);
  if (!reg || spanDays < 7) return { ok: false, n: pts.length, spanDays };
  return { ok: true, n: pts.length, spanDays, slopePerWeek: reg.slope * 7, r2: reg.r2 };
}

/**
 * ประเมินน้ำหนักเทียบเป้า คืนรายการข้อความ [{level:'ok'|'warn'|'info', code, text}]
 * เตือนเมื่อ ≥2 สัปดาห์น้ำหนักไม่ลด (เป้าลดน้ำหนัก) หรือลดเร็วเกิน 1 กก./สัปดาห์
 */
export function weightAssessment(points, profile, asOf) {
  const tr = weightTrend(points, { asOf, days: 21 });
  if (!tr.ok) {
    return [
      {
        level: 'info',
        code: 'insufficient',
        text: 'ข้อมูลน้ำหนักยังไม่พอจะดูแนวโน้ม — ลองชั่งอย่างน้อย 3 ครั้งในช่วง 1–2 สัปดาห์ (ชั่งตอนเช้าเงื่อนไขเดิม)',
      },
    ];
  }
  const s = tr.slopePerWeek;
  const fmt = (v) => Math.abs(round(v, 2));
  const out = [];
  const goal = profile?.goal || 'lose';
  const target = Math.abs(num(profile?.rate_kg_week) || 0);

  if (goal === 'lose') {
    if (s < -1) {
      out.push({
        level: 'warn',
        code: 'too_fast',
        text: `น้ำหนักลดเร็วเกิน 1 กก./สัปดาห์ (ตอนนี้ ~${fmt(s)} กก./สัปดาห์) — เสี่ยงเสียกล้ามเนื้อ ลองเพิ่มแคลอรี่ขึ้นอีกเล็กน้อย`,
      });
    } else if (s > -0.1 && tr.spanDays >= 14) {
      const weeks = Math.max(2, Math.round(tr.spanDays / 7));
      out.push({
        level: 'warn',
        code: 'stalled',
        text: `น้ำหนักไม่ลดมาราว ${weeks} สัปดาห์ (แนวโน้ม ${s >= 0 ? '+' : '−'}${fmt(s)} กก./สัปดาห์) — เช็กว่าจดอาหารครบไหม ถ้าครบแล้วลองลดแคลอรี่อีก 100–200 kcal`,
      });
    } else if (s > -0.1) {
      out.push({ level: 'info', code: 'watch', text: 'น้ำหนักยังนิ่งๆ แต่ข้อมูลยังไม่ถึง 2 สัปดาห์ รอดูต่ออีกหน่อย' });
    } else {
      const close = target > 0 ? Math.abs(Math.abs(s) - target) <= 0.25 : true;
      out.push({
        level: 'ok',
        code: 'on_track',
        text: `น้ำหนักลดเฉลี่ย ${fmt(s)} กก./สัปดาห์${target > 0 ? ` (เป้า ${target})` : ''}${close ? ' — เป็นไปตามเป้า' : Math.abs(s) < target ? ' — ช้ากว่าเป้าเล็กน้อย' : ' — เร็วกว่าเป้าเล็กน้อย'}`,
      });
    }
  } else if (goal === 'gain') {
    if (s < 0.05 && tr.spanDays >= 14) {
      out.push({ level: 'warn', code: 'stalled', text: 'น้ำหนักไม่เพิ่มมาราว 2 สัปดาห์ — ลองเพิ่มแคลอรี่อีก 100–200 kcal' });
    } else {
      out.push({ level: 'ok', code: 'on_track', text: `แนวโน้มน้ำหนัก ${s >= 0 ? '+' : '−'}${fmt(s)} กก./สัปดาห์` });
    }
  } else if (Math.abs(s) > 0.5) {
    out.push({ level: 'info', code: 'drift', text: `น้ำหนักกำลัง${s > 0 ? 'เพิ่ม' : 'ลด'} ~${fmt(s)} กก./สัปดาห์ ซึ่งมากกว่าที่ควรเป็นถ้าตั้งใจคงน้ำหนัก` });
  } else {
    out.push({ level: 'ok', code: 'on_track', text: 'น้ำหนักค่อนข้างคงที่ตามเป้า' });
  }
  return out;
}

// ---------- 4–5. การกิน ----------

/**
 * รวมสารอาหารต่อวัน → { 'YYYY-MM-DD': {date,kcal,protein,carb,fat,entries,missing} }
 * missing = จำนวนมื้อที่ยังไม่มีแคล (kcal เป็น null/kcal_missing): มื้อนั้นไม่นับแคล/โปรตีน/คาร์บ/ไขมัน
 * และวันที่ missing > 0 คือ "แคลอรี่ไม่ครบ" ยอดรวมเป็นแค่ขั้นต่ำ (ไม่ใช้ประมาณ TDEE/ค่าเฉลี่ยแคล)
 */
export function dailyIntake(foodLogs) {
  const m = {};
  for (const l of live(foodLogs)) {
    if (!isDateStr(l.date)) continue;
    const t = (m[l.date] ||= { date: l.date, kcal: 0, protein: 0, carb: 0, fat: 0, entries: 0, missing: 0 });
    t.entries += 1;
    if (isKcalMissing(l)) {
      t.missing += 1;
      continue;
    }
    t.kcal += num(l.kcal) || 0;
    t.protein += num(l.protein) || 0;
    t.carb += num(l.carb) || 0;
    t.fat += num(l.fat) || 0;
  }
  return m;
}

export function kcalOk(kcal, profile) {
  const t = num(profile?.kcal);
  if (!(t > 0)) return null;
  const tol = num(profile?.kcal_tolerance) ?? 100;
  return Math.abs(kcal - t) <= tol;
}

export function proteinOk(protein, profile) {
  const p = num(profile?.protein_min);
  if (!(p > 0)) return null;
  return protein >= p;
}

/**
 * สรุปการกินในช่วงวันที่ที่กำหนด เทียบเป้า
 * วัน "แคลอรี่ไม่ครบ" (incomplete = มีมื้อที่ยังไม่มีแคล): นับเป็นวันที่จด (loggedDays) แต่ไม่เอาไปเฉลี่ยแคล/โปรตีน
 * และไม่ตัดสินว่าแคลอยู่ในเป้า (kcalOk = null) — ยอดของวันนั้นเป็นแค่ขั้นต่ำ · โปรตีนที่ถึงเป้าแล้วจากมื้ออื่นยังนับว่าถึงเป้า
 */
export function intakeSummary(daily, profile, dates) {
  const days = dates.map((date) => {
    const t = daily[date];
    const incomplete = !!t && t.missing > 0;
    return {
      date,
      logged: !!t && t.entries > 0,
      incomplete,
      missingMeals: t ? t.missing || 0 : 0,
      kcal: t ? t.kcal : 0,
      protein: t ? t.protein : 0,
      carb: t ? t.carb : 0,
      fat: t ? t.fat : 0,
      kcalOk: t && !incomplete ? kcalOk(t.kcal, profile) : null,
      // วันที่ไม่ครบ: โปรตีนเป็นแค่ค่าขั้นต่ำ — ถึงเป้าแล้วนับว่าผ่าน ถ้ายังไม่ถึงถือว่ายังตัดสินไม่ได้ (null)
      proteinOk: !t ? null : incomplete ? (proteinOk(t.protein, profile) ? true : null) : proteinOk(t.protein, profile),
    };
  });
  const logged = days.filter((d) => d.logged);
  const complete = logged.filter((d) => !d.incomplete);
  return {
    days,
    loggedDays: logged.length,
    completeDays: complete.length,
    incompleteDays: logged.length - complete.length,
    totalDays: dates.length,
    avgKcal: complete.length ? mean(complete.map((d) => d.kcal)) : null,
    avgProtein: complete.length ? mean(complete.map((d) => d.protein)) : null,
    kcalOkDays: complete.filter((d) => d.kcalOk).length,
    proteinOkDays: logged.filter((d) => d.proteinOk).length,
    // ตัวหารของ "ถึงเป้าโปรตีน X/Y วัน": ไม่นับวันที่ไม่ครบซึ่งยังตัดสินไม่ได้
    proteinJudgedDays: logged.filter((d) => d.proteinOk != null).length,
  };
}

/**
 * ประมาณ TDEE จริง = แคลอรี่ที่กินเฉลี่ย − (การเปลี่ยนน้ำหนักต่อวัน × 7700)
 * ต้องมี: จดอาหารครบ ≥14 วัน (วันละ ≥800 kcal นับว่าจดครบ · วันที่ยังมีมื้อไม่มีแคลถูกตัดออก), ชั่งน้ำหนัก ≥4 ครั้ง ห่างกัน ≥12 วัน
 * ไม่ถึงเกณฑ์ → { ok:false } พร้อมจำนวนที่มีอยู่ เพื่อแสดง "ข้อมูลยังไม่พอ"
 */
export function estimateTDEE(points, daily, profile, { asOf, windowDays = 28, minDays = 14 } = {}) {
  const from = addDays(asOf, -(windowDays - 1));
  const pts = points.filter((p) => p.date >= from && p.date <= asOf);
  const windowDates = dateRange(from, asOf);
  const loggedDates = windowDates.filter((d) => daily[d] && !daily[d].missing && daily[d].kcal >= 800);
  const incompleteDays = windowDates.filter((d) => daily[d] && daily[d].missing > 0).length; // วันที่แคลอรี่ไม่ครบ (ตัดออกจากการประมาณ)
  const weighSpan = pts.length ? diffDays(pts[0].date, pts[pts.length - 1].date) : 0;
  const info = { loggedDays: loggedDates.length, incompleteDays, weighIns: pts.length, weighSpan, minDays };

  if (loggedDates.length < minDays || pts.length < 4 || weighSpan < 12) return { ok: false, ...info };

  const x0 = pts[0].date;
  const reg = linearRegression(
    pts.map((p) => diffDays(x0, p.date)),
    pts.map((p) => p.weight)
  );
  if (!reg) return { ok: false, ...info };
  const overlap = loggedDates.filter((d) => d >= pts[0].date && d <= pts[pts.length - 1].date);
  if (overlap.length < Math.min(minDays, 10)) return { ok: false, ...info, overlapDays: overlap.length };

  const avgIntake = mean(overlap.map((d) => daily[d].kcal));
  const slopePerDay = reg.slope;
  const tdee = avgIntake - slopePerDay * KCAL_PER_KG;
  const confidence = overlap.length >= 24 && pts.length >= 8 ? 'สูง' : overlap.length >= 18 && pts.length >= 6 ? 'กลาง' : 'ต่ำ';

  const rate = Math.abs(num(profile?.rate_kg_week) || 0);
  const delta = ((profile?.goal || 'lose') === 'lose' ? -1 : profile?.goal === 'gain' ? 1 : 0) * ((rate * KCAL_PER_KG) / 7);
  return {
    ok: true,
    ...info,
    tdee: round(tdee),
    avgIntake: round(avgIntake),
    slopePerWeek: slopePerDay * 7,
    usedDays: overlap.length,
    confidence,
    suggestedKcal: roundTo(tdee + delta, 50),
  };
}

// ---------- 3/5. การฝึก ----------

/** 1RM ประมาณแบบ Epley: น้ำหนัก × (1 + ครั้ง/30) */
export function epley(weight, reps) {
  const w = num(weight);
  const r = num(reps);
  return w > 0 && r > 0 ? w * (1 + r / 30) : 0;
}

export function isWorkingSet(s) {
  return !s.deleted && !s.is_warmup && num(s.reps) > 0;
}

/**
 * ประวัติของทุกท่า: Map(exerciseId → [{sessionId,date,sets,best,e1rm,topWeight,volume,totalReps,score}])
 * เรียงตามวันที่เก่า → ใหม่ นับเฉพาะเซ็ตทำงาน (ไม่รวมวอร์มอัพ)
 */
export function buildHistories(exercises, sessions, sets) {
  // ท่าที่ลบจากคลังแล้วยังอยู่ในประวัติ (เซ็ตที่ทำไปแล้วเป็นความจริง) — ผู้เรียกกรองเองถ้าไม่ต้องการ
  const exMap = new Map((exercises || []).map((e) => [e.id, e]));
  const sesMap = new Map(live(sessions).filter((s) => isDateStr(s.date)).map((s) => [s.id, s]));
  const groups = new Map(); // exId → Map(sessionId → sets[])
  for (const s of sets || []) {
    if (!isWorkingSet(s)) continue;
    if (!sesMap.has(s.session_id) || !exMap.has(s.exercise_id)) continue;
    if (!groups.has(s.exercise_id)) groups.set(s.exercise_id, new Map());
    const g = groups.get(s.exercise_id);
    if (!g.has(s.session_id)) g.set(s.session_id, []);
    g.get(s.session_id).push(s);
  }
  const result = new Map();
  for (const [exId, g] of groups) {
    const ex = exMap.get(exId);
    const rows = [];
    for (const [sid, arr] of g) {
      const ses = sesMap.get(sid);
      arr.sort((a, b) => (num(a.order) ?? 0) - (num(b.order) ?? 0));
      const ws = arr.map((s) => ({ weight: num(s.weight_kg) || 0, reps: num(s.reps), rir: num(s.rir) }));
      let best = null;
      for (const w of ws) {
        const e = ex.timed ? 0 : epley(w.weight, w.reps);
        const cand = { weight: w.weight, reps: w.reps, e1rm: e };
        if (!best || e > best.e1rm || (e === best.e1rm && (w.weight > best.weight || (w.weight === best.weight && w.reps > best.reps)))) best = cand;
      }
      const e1rm = best.e1rm;
      rows.push({
        sessionId: sid,
        date: ses.date,
        created_at: ses.created_at || '',
        sets: ws,
        best,
        e1rm,
        topWeight: Math.max(...ws.map((w) => w.weight)),
        volume: ex.timed ? sum(ws.map((w) => w.reps)) : sum(ws.map((w) => w.weight * w.reps)),
        totalReps: sum(ws.map((w) => w.reps)),
        score: e1rm > 0 ? e1rm : best.reps, // ท่าน้ำหนักตัวใช้จำนวนครั้ง/วินาที
      });
    }
    rows.sort((a, b) => (a.date === b.date ? (a.created_at < b.created_at ? -1 : 1) : a.date < b.date ? -1 : 1));
    result.set(exId, rows);
  }
  return result;
}

/** ท่าที่ตัวเลขไม่ขึ้น `n` ครั้งติด (ไม่มีครั้งไหนในล่าสุด n ครั้งทำลายสถิติเดิม และไม่ได้ไต่ขึ้นเรื่อยๆ) */
export function detectStall(history, n = 3) {
  if (!history || history.length < n + 1) return { stalled: false };
  const recent = history.slice(-n);
  const ref = Math.max(...history.slice(0, -n).map((h) => h.score));
  const eps = 1e-6;
  const noBeat = recent.every((h) => h.score <= ref + eps);
  const rising = recent.every((h, i) => i === 0 || h.score > recent[i - 1].score + eps);
  return { stalled: noBeat && !rising, sessions: n, ref, since: recent[0].date };
}

/**
 * แนะนำเพิ่มน้ำหนัก: ถ้าครั้งล่าสุดทำถึงเลขบนของช่วงครั้ง (rep_max) ทุกเซ็ตทำงาน
 * ท่าช่วงบน +1–2.5 กก. · ท่าขา +2.5–5 กก.
 */
export function overloadSuggestion(exercise, history) {
  if (!exercise || exercise.timed || !history || !history.length) return null;
  const repMax = num(exercise.rep_max);
  if (!(repMax > 0)) return null;
  const last = history[history.length - 1];
  if (!last.sets.length || !last.sets.every((s) => s.reps >= repMax)) return null;
  const top = last.topWeight;
  if (!(top > 0)) return null;
  const [lo, hi] = exercise.category === 'ขา' ? [2.5, 5] : [1, 2.5];
  return { from: top, low: round(top + lo, 2), high: round(top + hi, 2), date: last.date, repMax };
}

/** ตัวช่วยหาเซ็ตของครั้งก่อนหน้า (สำหรับปุ่ม "เหมือนครั้งก่อน") ไม่รวมครั้งที่กำลังจด */
export function previousEntry(history, sessionId, date) {
  if (!history) return null;
  const before = history.filter((h) => h.sessionId !== sessionId && h.date <= date);
  return before.length ? before[before.length - 1] : null;
}

function sessionsInWeek(sessions, ws) {
  const we = addDays(ws, 6);
  return live(sessions).filter((s) => s.date >= ws && s.date <= we);
}

/** นับเฉพาะครั้งที่ฝึกที่มีเซ็ตทำงานอย่างน้อย 1 เซ็ต หรือมีคาร์ดิโอ */
function activeSessionIds(sessions, sets, cardio) {
  const ids = new Set();
  for (const s of sets || []) if (!s.deleted && num(s.reps) > 0) ids.add(s.session_id);
  for (const c of cardio || []) if (!c.deleted && c.session_id) ids.add(c.session_id);
  return ids;
}

export function weekSessionCount(sessions, sets, cardio, ws) {
  const active = activeSessionIds(sessions, sets, cardio);
  return sessionsInWeek(sessions, ws).filter((s) => active.has(s.id)).length;
}

/** เซ็ตทำงานต่อกลุ่มกล้ามในสัปดาห์ที่เริ่มวันจันทร์ ws */
export function setsPerMuscle(sessions, sets, exercises, ws) {
  const ids = new Set(sessionsInWeek(sessions, ws).map((s) => s.id));
  const exMap = new Map((exercises || []).map((e) => [e.id, e]));
  const out = {};
  for (const s of sets || []) {
    if (!isWorkingSet(s) || !ids.has(s.session_id)) continue;
    const ex = exMap.get(s.exercise_id);
    if (!ex) continue;
    out[ex.muscle] = (out[ex.muscle] || 0) + 1;
  }
  return out;
}

/** จำนวนเซ็ตทำงานแยกประเภท ดัน/ดึง/ขา/core ในช่วง from..to */
export function categoryRatio(sessions, sets, exercises, from, to) {
  const ids = new Set(live(sessions).filter((s) => s.date >= from && s.date <= to).map((s) => s.id));
  const exMap = new Map((exercises || []).map((e) => [e.id, e]));
  const out = { ดัน: 0, ดึง: 0, ขา: 0, core: 0, total: 0 };
  for (const s of sets || []) {
    if (!isWorkingSet(s) || !ids.has(s.session_id)) continue;
    const ex = exMap.get(s.exercise_id);
    if (!ex || !(ex.category in out)) continue;
    out[ex.category] += 1;
    out.total += 1;
  }
  return out;
}

/** จำนวนครั้งที่ฝึกต่อสัปดาห์ย้อนหลัง `weeks` สัปดาห์ (รวมสัปดาห์ที่ endWs) */
export function weeklyConsistency(sessions, sets, cardio, endWs, weeks = 8) {
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = addDays(endWs, -7 * i);
    out.push({ weekStart: ws, count: weekSessionCount(sessions, sets, cardio, ws) });
  }
  return out;
}

/** สถิติใหม่ (PR) ในสัปดาห์: 1RM ประมาณสูงสุดใหม่ของท่านั้น เทียบกับก่อนสัปดาห์นี้ (ต้องเคยเล่นมาก่อน) */
export function weekPRs(histories, exercises, ws) {
  const we = addDays(ws, 6);
  const exMap = new Map((exercises || []).map((e) => [e.id, e]));
  const prs = [];
  for (const [exId, hist] of histories) {
    const inWeek = hist.filter((h) => h.date >= ws && h.date <= we);
    const before = hist.filter((h) => h.date < ws);
    if (!inWeek.length || !before.length) continue;
    const bestNow = inWeek.reduce((a, b) => (b.score > a.score ? b : a));
    const bestBefore = before.reduce((a, b) => (b.score > a.score ? b : a));
    if (bestNow.score > bestBefore.score + 1e-6) {
      const ex = exMap.get(exId);
      prs.push({
        exerciseId: exId,
        name: ex?.name || '?',
        date: bestNow.date,
        best: bestNow.best,
        prevBest: bestBefore.best,
        timed: !!ex?.timed,
      });
    }
  }
  return prs;
}

/** สรุปรายสัปดาห์ (ws = วันจันทร์ของสัปดาห์ที่ดู, asOf = วันนี้) */
export function weeklySummary({ ws, asOf, bodyLogs, foodLogs, sessions, sets, cardio, exercises, profile }) {
  const we = addDays(ws, 6);
  const weights = cleanWeights(bodyLogs);
  const inWeek = weights.filter((p) => p.date >= ws && p.date <= we);
  const prevWs = addDays(ws, -7);
  const prevWeek = weights.filter((p) => p.date >= prevWs && p.date < ws);
  const avgWeight = inWeek.length ? mean(inWeek.map((p) => p.weight)) : null;
  const prevAvgWeight = prevWeek.length ? mean(prevWeek.map((p) => p.weight)) : null;

  const daily = dailyIntake(foodLogs);
  const lastDay = we < asOf ? we : asOf;
  const dates = lastDay >= ws ? dateRange(ws, lastDay) : [];
  const intake = intakeSummary(daily, profile, dates);

  const sessionCount = weekSessionCount(sessions, sets, cardio, ws);
  const target = num(profile?.sessions_per_week) || 4;
  const histories = buildHistories(exercises, sessions, sets);
  const prs = weekPRs(histories, exercises, ws);

  const exMap = new Map((exercises || []).map((e) => [e.id, e]));
  const stalled = [];
  const overload = [];
  for (const [exId, hist] of histories) {
    const ex = exMap.get(exId);
    if (!ex || ex.deleted) continue; // ท่าที่ลบแล้วไม่ขึ้นคำแนะนำ
    const upToWeek = hist.filter((h) => h.date <= we);
    if (!upToWeek.length) continue;
    if (upToWeek[upToWeek.length - 1].date < ws) continue; // ไม่ได้เล่นในสัปดาห์นี้
    if (detectStall(upToWeek).stalled) stalled.push(ex.name);
    const o = overloadSuggestion(ex, upToWeek);
    if (o) overload.push({ name: ex.name, ...o });
  }

  const weekDone = we < asOf;
  const advice = [];
  if (sessionCount < target) {
    advice.push(
      weekDone
        ? `ฝึกได้ ${sessionCount} จาก ${target} ครั้ง — สัปดาห์หน้าลองล็อกวันฝึกไว้ในตารางล่วงหน้า`
        : `สัปดาห์นี้ฝึกแล้ว ${sessionCount} จาก ${target} ครั้ง`
    );
  }
  if (intake.incompleteDays > 0) {
    advice.push(`มี ${intake.incompleteDays} วันที่ยังมีมื้อไม่มีแคล — เติมแคล (แตะรายการที่มีป้าย "ยังไม่มีแคล") แล้วสรุปแคลอรี่กับ coin จะนับวันนั้นให้`);
  }
  if (intake.loggedDays < Math.min(4, dates.length)) {
    advice.push(`จดอาหารได้ ${intake.loggedDays} จาก ${dates.length} วัน — จดให้ครบขึ้นสรุปจะแม่นขึ้น`);
  } else if (intake.completeDays > 0) {
    const pMin = num(profile?.protein_min);
    if (pMin > 0 && intake.avgProtein < pMin) {
      advice.push(`โปรตีนเฉลี่ย ${round(intake.avgProtein)} ก. ต่ำกว่าเป้า ${pMin} ก. — เพิ่มอกไก่ ไข่ นม หรือเวย์`);
    }
    const kt = num(profile?.kcal);
    const tol = num(profile?.kcal_tolerance) ?? 100;
    if (kt > 0) {
      if (intake.avgKcal > kt + tol) advice.push(`แคลอรี่เฉลี่ย ${round(intake.avgKcal)} สูงกว่าเป้า ${kt} kcal`);
      else if (intake.avgKcal < kt - tol * 3) advice.push(`แคลอรี่เฉลี่ย ${round(intake.avgKcal)} ต่ำกว่าเป้า ${kt} kcal พอสมควร — ระวังเหนื่อยล้าและเสียกล้ามเนื้อ`);
    }
  }
  if (stalled.length) advice.push(`ตัวเลขไม่ขึ้น 3 ครั้งติด: ${stalled.join(', ')} — ลองพัก/ลดน้ำหนักลงนิดแล้วไต่ใหม่ หรือเช็กการนอนและการกิน`);
  if (overload.length) advice.push(`พร้อมเพิ่มน้ำหนัก: ${overload.map((o) => `${o.name} (→ ${o.low}–${o.high} กก.)`).join(', ')}`);
  for (const a of weightAssessment(weights, profile, lastDay < asOf ? lastDay : asOf)) {
    if (a.level === 'warn') advice.push(a.text);
  }

  return {
    ws,
    we,
    weekDone,
    avgWeight,
    prevAvgWeight,
    weightDelta: avgWeight != null && prevAvgWeight != null ? avgWeight - prevAvgWeight : null,
    weighIns: inWeek.length,
    intake,
    sessionCount,
    sessionTarget: target,
    prs,
    stalled,
    overload,
    advice,
  };
}

// ---------- คาร์ดิโอ ----------

/**
 * ประมาณ kcal คาร์ดิโอด้วยสมการ ACSM (เดิน/วิ่งบนลู่) — เป็นค่าประมาณเท่านั้น
 * เดิน: VO2 = 0.1·v + 1.8·v·grade + 3.5 · วิ่ง: 0.2·v + 0.9·v·grade + 3.5 (v = เมตร/นาที)
 * kcal = VO2(มล./กก./นาที) × น้ำหนัก × นาที ÷ 1000 × 5
 */
export function estimateCardioKcal({ type, minutes, speed_kmh, incline_pct, weight_kg }) {
  const min = num(minutes);
  const sp = num(speed_kmh);
  const w = num(weight_kg);
  if (!(min > 0) || !(sp > 0) || !(w > 0)) return null;
  if (type !== 'เดินชัน' && type !== 'วิ่ง') return null;
  const v = (sp * 1000) / 60;
  const grade = (num(incline_pct) || 0) / 100;
  const vo2 = type === 'วิ่ง' ? 0.2 * v + 0.9 * v * grade + 3.5 : 0.1 * v + 1.8 * v * grade + 3.5;
  return Math.round(((vo2 * w * min) / 1000) * 5);
}
