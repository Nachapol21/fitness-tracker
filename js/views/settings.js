// หน้า "ตั้งค่า": โปรไฟล์/เป้า · ธีม · ส่งออก/นำเข้า · ที่เก็บข้อมูล · ติดตั้ง

import * as db from '../db.js';
import { bmrMifflin, cleanWeights, suggestTargets, tdeeFromBmr } from '../analytics.js';
import { ACTIVITY_LEVELS, APP_VERSION, GOALS, TABLES, TABLE_LABELS } from '../constants.js';
import { exportCSV, exportJSON, importFile, summarizeStats } from '../io.js';
import { chipGroup, confirmSheet, field, fmtInt, h, mount, numInput, openSheet, readNum, toast } from '../ui.js';
import { isIOS, isStandalone, openInstallGuide } from './install.js';
import { accountCard } from './account.js';
import { gameSettingsCard } from './game-settings.js';
import { auth, syncEnabled } from '../sync-service.js';

export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]:not([media])')?.setAttribute('content', dark ? '#0e1419' : '#0f766e');
}

export const getTheme = () => localStorage.getItem('theme') || 'auto';

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
});

export async function renderSettings(root) {
  const [profile, bodyAll, lastExport, persisted, gameSettings, allData] = await Promise.all([db.getProfile(), db.list('body_logs'), db.getMeta('last_export_at'), db.getMeta('persisted'), db.getGameSettings(), db.loadAll()]);
  const latestW = cleanWeights(bodyAll).slice(-1)[0]?.weight ?? null;
  const refresh = () => renderSettings(root);

  mount(root, h('header', { class: 'page-head' }, h('h1', null, 'ตั้งค่า')), profileCard({ profile, latestW, refresh }), gameSettingsCard({ settings: gameSettings, refresh, data: allData, profile }), appearanceCard(), accountCard({ refresh }), dataCard({ lastExport, refresh }), storageCard({ persisted, refresh }), aboutCard({ refresh }));
}

// ---------- โปรไฟล์และเป้า ----------

function profileCard({ profile, latestW, refresh }) {
  const sex = chipGroup({ options: [{ value: 'male', label: 'ชาย' }, { value: 'female', label: 'หญิง' }], value: profile.sex, onChange: () => recalc() });
  const age = numInput({ value: profile.age ?? '', placeholder: 'เช่น 30', inputmode: 'numeric', 'aria-label': 'อายุ' });
  const height = numInput({ value: profile.height_cm ?? '', placeholder: 'เช่น 170', 'aria-label': 'ส่วนสูง (ซม.)' });
  const weight = numInput({ value: profile.calc_weight_kg ?? latestW ?? '', placeholder: 'กก.', 'aria-label': 'น้ำหนักที่ใช้คำนวณ' });
  const activity = h('select', { class: 'input', value: String(profile.activity), 'aria-label': 'ระดับกิจกรรม', onchange: () => recalc() }, ACTIVITY_LEVELS.map((a) => h('option', { value: String(a.value) }, a.label)));
  const goal = chipGroup({ options: GOALS, value: profile.goal, onChange: () => recalc() });
  const rate = numInput({ value: profile.rate_kg_week ?? '', placeholder: 'เช่น 0.5', 'aria-label': 'อัตราที่ต้องการ (กก./สัปดาห์)' });
  const kcal = numInput({ value: profile.kcal ?? '', placeholder: 'เช่น 2200', inputmode: 'numeric', 'aria-label': 'เป้าแคลอรี่' });
  const tol = numInput({ value: profile.kcal_tolerance ?? 100, placeholder: 'เช่น 100', inputmode: 'numeric', 'aria-label': 'ช่วงที่ยอมรับได้' });
  const pMin = numInput({ value: profile.protein_min ?? '', placeholder: 'เช่น 120', inputmode: 'numeric', 'aria-label': 'โปรตีนต่ำสุด' });
  const pMax = numInput({ value: profile.protein_max ?? '', placeholder: 'เช่น 150', inputmode: 'numeric', 'aria-label': 'โปรตีนสูงสุด' });
  const fat = numInput({ value: profile.fat ?? '', placeholder: 'เช่น 60', inputmode: 'numeric', 'aria-label': 'ไขมัน' });
  const carb = numInput({ value: profile.carb ?? '', placeholder: 'เช่น 250', inputmode: 'numeric', 'aria-label': 'คาร์บ' });
  const perWeek = numInput({ value: profile.sessions_per_week ?? 4, inputmode: 'numeric', 'aria-label': 'เป้าฝึกต่อสัปดาห์' });
  const steps = numInput({ value: profile.step_goal ?? 8000, inputmode: 'numeric', 'aria-label': 'เป้าก้าวเดิน' });
  const water = numInput({ value: profile.water_goal_ml ?? 2000, inputmode: 'numeric', 'aria-label': 'เป้าน้ำดื่ม (มล.)' });
  const calcOut = h('div', { class: 'callout info', 'aria-live': 'polite' });
  const hint = h('p', { class: 'muted small-text' });
  let calcWeight = profile.calc_weight_kg;

  const current = () => ({ sex: sex.get(), age: readNum(age), height_cm: readNum(height), weight_kg: readNum(weight), activity: Number(activity.value), goal: goal.get(), rate_kg_week: readNum(rate) });
  const compute = () => {
    const p = current();
    const bmr = bmrMifflin(p);
    const tdee = tdeeFromBmr(bmr, p.activity);
    return { p, bmr, tdee, sug: bmr != null ? suggestTargets({ ...p, bmr, tdee }) : null };
  };
  function recalc() {
    const { bmr, tdee } = compute();
    calcOut.textContent = bmr == null ? 'กรอกอายุ ส่วนสูง และน้ำหนัก เพื่อคำนวณ BMR/TDEE (สูตร Mifflin-St Jeor)' : `BMR ≈ ${fmtInt(bmr)} kcal · TDEE ≈ ${fmtInt(tdee)} kcal/วัน`;
  }
  for (const el of [age, height, weight, rate]) el.addEventListener('input', recalc);
  recalc();

  const applySuggestion = () => {
    const { sug, p } = compute();
    if (!sug) return void (hint.textContent = 'กรอกอายุ ส่วนสูง น้ำหนัก ให้ครบก่อน');
    kcal.value = String(sug.kcal);
    pMin.value = String(sug.protein_min);
    pMax.value = String(sug.protein_max);
    fat.value = String(sug.fat);
    carb.value = String(sug.carb);
    calcWeight = p.weight_kg;
    hint.textContent = sug.clamped
      ? 'อัตราที่ตั้งทำให้แคลอรี่ต่ำกว่า BMR จึงปรับให้เท่า BMR — การกินต่ำกว่านี้นานๆ ไม่แนะนำ ลองลดอัตราลง'
      : 'ใส่เป้าแนะนำให้แล้ว (โปรตีน 1.7–2.0 ก./กก. · ไขมัน 0.8 ก./กก. · คาร์บคือส่วนที่เหลือ) ปรับเองได้ แล้วกด "บันทึก"';
  };

  return h(
    'section',
    { class: 'card' },
    h('h2', null, 'โปรไฟล์และเป้าหมาย'),
    h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          const p = current();
          await db.saveProfile({
            sex: p.sex,
            age: p.age,
            height_cm: p.height_cm,
            activity: p.activity,
            goal: p.goal,
            rate_kg_week: p.rate_kg_week,
            calc_weight_kg: calcWeight ?? p.weight_kg ?? null,
            kcal: readNum(kcal),
            kcal_tolerance: readNum(tol) ?? 100,
            protein_min: readNum(pMin),
            protein_max: readNum(pMax),
            fat: readNum(fat),
            carb: readNum(carb),
            sessions_per_week: readNum(perWeek) ?? 4,
            step_goal: readNum(steps) ?? 8000,
            water_goal_ml: readNum(water) ?? 2000,
          });
          toast('บันทึกโปรไฟล์แล้ว');
          refresh();
        },
      },
      field('เพศ (ใช้ในสูตร BMR)', sex.el),
      h('div', { class: 'grid3' }, field('อายุ (ปี)', age), field('ส่วนสูง (ซม.)', height), field('น้ำหนัก (กก.)', weight)),
      field('ระดับกิจกรรม', activity),
      field('เป้าหมาย', goal.el),
      field('อัตราที่ต้องการ (กก./สัปดาห์)', rate, 'ลดน้ำหนักที่ปลอดภัยทั่วไปไม่เกินราว 0.5–1 กก./สัปดาห์'),
      calcOut,
      h('button', { type: 'button', class: 'btn', onclick: applySuggestion }, 'คำนวณเป้าแนะนำให้'),
      hint,
      h('h3', null, 'เป้าต่อวัน'),
      h('div', { class: 'grid2' }, field('แคลอรี่ (kcal)', kcal), field('ยอมรับได้ ± (kcal)', tol), field('โปรตีนต่ำสุด (ก.)', pMin), field('โปรตีนสูงสุด (ก.)', pMax), field('ไขมัน (ก.)', fat), field('คาร์บ (ก.)', carb)),
      h('div', { class: 'grid3' }, field('ฝึกต่อสัปดาห์', perWeek), field('ก้าว/วัน', steps), field('น้ำ (มล.)', water)),
      h('button', { type: 'submit', class: 'btn primary' }, 'บันทึกโปรไฟล์')
    )
  );
}

// ---------- ธีม ----------

function appearanceCard() {
  const chips = chipGroup({
    options: [{ value: 'auto', label: 'ตามเครื่อง' }, { value: 'light', label: 'สว่าง' }, { value: 'dark', label: 'มืด' }],
    value: getTheme(),
    onChange: (v) => {
      if (v === 'auto') localStorage.removeItem('theme');
      else localStorage.setItem('theme', v);
      applyTheme(v);
    },
  });
  return h('section', { class: 'card' }, h('h2', null, 'หน้าตา'), chips.el);
}

// ---------- ข้อมูล ----------

function dataCard({ lastExport, refresh }) {
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, id: 'import-file' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) chooseImportMode(file, refresh);
  });
  const days = lastExport ? Math.floor((Date.now() - new Date(lastExport).getTime()) / 86400000) : null;
  return h(
    'section',
    { class: 'card' },
    h('h2', null, 'ข้อมูลของคุณ'),
    h('p', { class: 'muted' }, lastExport ? `สำรองล่าสุด ${days === 0 ? 'วันนี้' : `${days} วันก่อน`}` : 'ยังไม่เคยส่งออกข้อมูล'),
    h(
      'div',
      { class: 'stack' },
      h(
        'button',
        {
          class: 'btn primary',
          id: 'btn-export-json',
          onclick: async () => {
            const r = await exportJSON();
            if (r.result === 'saved') toast('ส่งออกข้อมูลทั้งหมดแล้ว');
            refresh();
          },
        },
        'ส่งออกทั้งหมด (JSON)'
      ),
      h('button', { class: 'btn', id: 'btn-import', onclick: () => fileInput.click() }, 'นำเข้าจากไฟล์ JSON…'),
      fileInput,
      h(
        'details',
        { class: 'details' },
        h('summary', null, 'ส่งออกเป็นตาราง CSV (เปิดใน Excel)'),
        h(
          'div',
          { class: 'stack' },
          TABLES.map((t) =>
            h(
              'button',
              {
                class: 'btn ghost left',
                'data-csv': t,
                onclick: async () => {
                  await exportCSV(t);
                },
              },
              `${TABLE_LABELS[t]} (${t}.csv)`
            )
          ),
          h('small', { class: 'muted' }, 'CSV ใช้ดู/วิเคราะห์ต่อ ไม่ใช้เป็นไฟล์สำรอง — สำรองให้ใช้ JSON')
        )
      )
    ),
    h('p', { class: 'muted small-text' }, `${syncEnabled ? (auth.getSession() ? 'ข้อมูลอยู่ในเครื่องนี้และซิงก์ไปยังบัญชีของคุณ' : 'ถ้าไม่ล็อกอิน ข้อมูลอยู่ในเครื่องนี้เท่านั้น ไม่ได้ส่งไปที่ไหน') : 'ข้อมูลทั้งหมดอยู่ในเครื่องนี้เท่านั้น ไม่ได้ส่งไปที่ไหน'} · ไฟล์ที่ส่งออกมีข้อมูลส่วนตัว อย่าอัปโหลดขึ้นที่สาธารณะ`)
  );
}

function chooseImportMode(file, refresh) {
  const run = async (replace, close) => {
    if (replace && !(await confirmSheet(`แทนที่จะล้างข้อมูลเดิมทั้งหมดในเครื่องนี้ก่อน แล้วใช้ข้อมูลจากไฟล์แทน${auth.getSession() ? '\n\nตอนนี้ล็อกอินซิงก์อยู่: รายการที่ไม่อยู่ในไฟล์จะถูกลบ และการลบนี้จะซิงก์ไปทุกเครื่องที่ล็อกอินบัญชีเดียวกัน' : ''}\n\nต้องการต่อไหม?`, { okText: 'แทนที่ทั้งหมด', danger: true }))) return;
    try {
      const stats = await importFile(file, { replace });
      const s = summarizeStats(stats);
      close();
      openSheet({
        title: 'นำเข้าเสร็จแล้ว',
        content: (c2) =>
          h(
            'div',
            { class: 'stack' },
            h('p', null, `เพิ่มใหม่ ${s.added} รายการ · อัปเดต ${s.updated} · ข้าม (มีอยู่แล้วและใหม่กว่า) ${s.skipped}`),
            h('button', { class: 'btn primary', onclick: () => c2() }, 'ตกลง')
          ),
        onClose: refresh,
      });
    } catch (err) {
      close();
      openSheet({ title: 'นำเข้าไม่สำเร็จ', content: (c2) => h('div', { class: 'stack' }, h('p', { class: 'bad-text' }, err.message || String(err)), h('p', { class: 'muted' }, 'ข้อมูลเดิมไม่ถูกเปลี่ยนแปลง'), h('button', { class: 'btn', onclick: c2 }, 'ปิด')) });
    }
  };
  openSheet({
    title: 'นำเข้าข้อมูล',
    content: (close) =>
      h(
        'div',
        { class: 'stack' },
        h('p', null, h('strong', null, file.name)),
        h('button', { class: 'btn primary', 'data-import': 'merge', onclick: () => run(false, close) }, 'รวมกับข้อมูลเดิม (แนะนำ)'),
        h('small', { class: 'muted' }, 'ถ้ามีรายการเดียวกัน (id ตรงกัน) จะเก็บอันที่แก้ไขล่าสุด ไม่ลบอะไรของเดิม'),
        h('button', { class: 'btn danger-outline', 'data-import': 'replace', onclick: () => run(true, close) }, 'แทนที่ข้อมูลเดิมทั้งหมด'),
        h('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก')
      ),
  });
}

// ---------- ที่เก็บข้อมูล ----------

function storageCard({ persisted, refresh }) {
  const usage = h('span', { class: 'muted' }, '');
  navigator.storage?.estimate?.().then((e) => {
    if (e?.usage != null) usage.textContent = `ใช้พื้นที่ ${(e.usage / 1024).toFixed(0)} KB`;
  });
  const supported = !!navigator.storage?.persist;
  return h(
    'section',
    { class: 'card' },
    h('h2', null, 'การเก็บข้อมูลในเครื่อง'),
    h('p', null, 'สถานะ: ', h('strong', null, !supported ? 'เบราว์เซอร์นี้ไม่รองรับการขอเก็บถาวร' : persisted ? 'เก็บแบบถาวรแล้ว' : 'ยังไม่ได้รับอนุญาตให้เก็บถาวร'), ' ', usage),
    supported && !persisted
      ? h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const ok = await navigator.storage.persist();
              await db.setMeta('persisted', ok);
              toast(ok ? 'เบราว์เซอร์จะไม่ล้างข้อมูลอัตโนมัติแล้ว' : 'เบราว์เซอร์ยังไม่อนุญาต — ติดตั้งลงหน้าจอโฮมและสำรองข้อมูลไว้เป็นระยะ');
              refresh();
            },
          },
          'ขอให้เก็บข้อมูลถาวร'
        )
      : null,
    h('p', { class: 'muted small-text' }, 'iPhone: ข้อมูลเว็บที่ไม่ได้เปิดนานอาจถูกล้างได้ ให้ติดตั้งลงหน้าจอโฮม และกดส่งออกสำรองเป็นประจำ')
  );
}

// ---------- เกี่ยวกับ ----------

function aboutCard({ refresh }) {
  return h(
    'section',
    { class: 'card' },
    h('h2', null, 'แอป'),
    h(
      'div',
      { class: 'stack' },
      isStandalone() ? h('p', { class: 'good-text' }, 'ติดตั้งเป็นแอปแล้ว') : h('button', { class: 'btn', id: 'btn-install-guide', onclick: () => openInstallGuide() }, isIOS() ? 'วิธีเพิ่มไปยังหน้าจอโฮม (iPhone)' : 'วิธีติดตั้งแอป'),
      deferredInstall
        ? h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                deferredInstall.prompt();
                await deferredInstall.userChoice;
                deferredInstall = null;
                refresh();
              },
            },
            'ติดตั้งแอปบนเครื่องนี้'
          )
        : null,
      h('p', { class: 'muted small-text' }, `เวอร์ชัน ${APP_VERSION} · ใช้ออฟไลน์ได้หลังเปิดครั้งแรก · ค่าอาหารตั้งต้นเป็นค่าประมาณ`),
      h(
        'button',
        {
          class: 'btn danger-outline',
          id: 'btn-wipe',
          onclick: async () => {
            if (await confirmSheet(`ลบข้อมูลทั้งหมดในเครื่องนี้ (ไม่สามารถกู้คืนได้ นอกจากมีไฟล์สำรอง${auth.getSession() ? ' หรือข้อมูลที่ซิงก์ไว้ในบัญชี ซึ่งจะถูกดึงกลับมาเมื่อซิงก์ครั้งถัดไป ถ้าต้องการล้างจริงให้ออกจากระบบแล้วเลือกล้างข้อมูลในเครื่อง' : ''}) ต้องการต่อไหม?`, { okText: 'ลบทั้งหมด', danger: true, title: 'ล้างข้อมูลทั้งหมด' })) {
              await db.clearAll();
              location.hash = '#/today';
              location.reload();
            }
          },
        },
        'ล้างข้อมูลทั้งหมด'
      )
    )
  );
}
