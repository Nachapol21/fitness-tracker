// ค่าคงที่ที่ใช้ร่วมกันทั้งแอป (ไม่มี DOM จึงใช้ใน Node ได้)

export const APP_VERSION = '0.4.0';
export const DATA_FORMAT = 'fitness-tracker';
// v2: เพิ่มตารางเกม (game_settings, rewards, redemptions) — แอปรุ่นเก่าจะปฏิเสธไฟล์นี้แทนที่จะทิ้งข้อมูลเกมเงียบๆ
export const DATA_VERSION = 2;

// โปรไฟล์มีเรคคอร์ดเดียว ใช้ UUID คงที่ เพื่อให้หลายเครื่องซิงก์แล้วไม่เกิดโปรไฟล์ซ้ำ
export const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
// การตั้งค่าเกมก็มีเรคคอร์ดเดียวเช่นกัน
// เพิ่มเลขนี้ทุกครั้งที่เพิ่ม collection ใหม่ที่ซิงก์: เครื่องที่ซิงก์ไปแล้วจะดึงใหม่ทั้งหมดจาก epoch หนึ่งครั้ง (merge เป็น LWW ปลอดภัย)
// เพราะแอปรุ่นก่อนข้ามแถวของ collection ที่ไม่รู้จักแล้วเลื่อน cursor ผ่านไป
export const SYNC_TABLES_VERSION = 2;
export const GAME_SETTINGS_ID = '00000000-0000-4000-8000-000000000002';
// ค่าปุ่มกะขนาดมื้อที่ผู้ใช้แก้ (จดการกินแบบกะเอา): เรคคอร์ดตั้งค่าที่ id คงที่ในตาราง profile ที่มีอยู่แล้ว (ไม่เพิ่ม collection จึงไม่ต้องขึ้น SYNC_TABLES_VERSION)
// แยกจากเรคคอร์ดโปรไฟล์ (…001) เพื่อไม่ให้การแก้ปุ่มบนเครื่องที่ยังไม่ได้ซิงก์ไปทับเป้าหมายของโปรไฟล์ตอนรวมข้อมูล
export const FOOD_PRESETS_ID = '00000000-0000-4000-8000-000000000003';

// ตารางข้อมูลที่ซิงก์/export ได้ (meta เป็นของเครื่องนั้นๆ ไม่รวม)
export const TABLES = [
  'profile',
  'body_logs',
  'exercises',
  'sessions',
  'sets',
  'cardio',
  'foods',
  'food_logs',
  'water_logs',
  'templates',
  'game_settings',
  'rewards',
  'redemptions',
];

export const TABLE_LABELS = {
  profile: 'โปรไฟล์และเป้าหมาย',
  body_logs: 'ร่างกาย (น้ำหนัก/รอบเอว/ก้าว)',
  exercises: 'คลังท่า',
  sessions: 'ครั้งที่ฝึก',
  sets: 'เซ็ต',
  cardio: 'คาร์ดิโอ',
  foods: 'คลังอาหาร',
  food_logs: 'บันทึกการกิน',
  water_logs: 'น้ำดื่ม',
  templates: 'เทมเพลตโปรแกรม',
  game_settings: 'ตั้งค่าเกม coin',
  rewards: 'รางวัลในร้าน',
  redemptions: 'ประวัติการแลกรางวัล',
};

export const MUSCLES = ['อก', 'หลัง', 'ไหล่', 'แขน', 'ขา', 'ก้น', 'ท้อง'];
export const CATEGORIES = ['ดัน', 'ดึง', 'ขา', 'core'];
export const EQUIPMENT = ['บาร์', 'ดัมเบล', 'เคเบิล', 'เครื่อง', 'น้ำหนักตัว'];
export const MEALS = ['เช้า', 'กลางวัน', 'เย็น', 'ของว่าง', 'หลังฝึก'];
export const DAY_NAMES = ['Upper A', 'Lower A', 'Upper B', 'Lower B', 'อื่นๆ'];
export const CARDIO_TYPES = ['เดินชัน', 'วิ่ง', 'ปั่น', 'อื่นๆ'];

export const GOALS = [
  { value: 'lose', label: 'ลดน้ำหนัก' },
  { value: 'maintain', label: 'คงน้ำหนัก' },
  { value: 'gain', label: 'เพิ่มน้ำหนัก' },
];

export const ACTIVITY_LEVELS = [
  { value: 1.2, label: 'นั่งเป็นหลัก แทบไม่ออกกำลัง (×1.2)' },
  { value: 1.375, label: 'ขยับบ้าง 1–3 วัน/สัปดาห์ (×1.375)' },
  { value: 1.55, label: 'ฝึก 3–5 วัน/สัปดาห์ (×1.55)' },
  { value: 1.725, label: 'ฝึกหนัก 6–7 วัน/สัปดาห์ (×1.725)' },
];

export const DEFAULT_PROFILE = {
  sex: 'male',
  age: null,
  height_cm: null,
  activity: 1.375,
  goal: 'lose',
  rate_kg_week: 0.5,
  calc_weight_kg: null, // น้ำหนักที่ใช้ตอนคำนวณเป้าครั้งล่าสุด
  kcal: null,
  kcal_tolerance: 100,
  protein_min: null,
  protein_max: null,
  fat: null,
  carb: null,
  sessions_per_week: 4,
  step_goal: 8000,
  water_goal_ml: 2000,
};

/**
 * ค่าเริ่มต้นของเกม coin + streak (ทุกตัวเลขแก้ได้ในตั้งค่า → เก็บใน game_settings)
 * เป้าแคลอรี่/โปรตีนขั้นต่ำ/เป้าก้าว ใช้ค่าจากโปรไฟล์ ไม่ซ้ำที่นี่
 */
export const DEFAULT_GAME_SETTINGS = {
  coin_workout: 10, // ฝึกครบ 1 ครั้ง (วันละไม่เกิน 1 ครั้ง)
  workout_min_exercises: 4, // ... อย่างน้อย 4 ท่า
  workout_min_sets: 8, // ... หรืออย่างน้อย 8 เซ็ตทำงาน (ไม่นับวอร์มอัพ)
  coin_cardio: 3,
  cardio_min_minutes: 15,
  coin_pr: 5, // ต่อท่า
  pr_cap_per_day: 15,
  coin_kcal: 5,
  kcal_below: null, // ช่วงที่ถือว่าอยู่ในเป้า: ว่าง (null) = ใช้ ± จากโปรไฟล์ (kcal_tolerance) · ใส่ตัวเลข = ใช้แทน
  kcal_above: null,
  kcal_min_meals: 2, // ต้องจดอย่างน้อย 2 มื้อที่ต่างกัน
  coin_protein: 5,
  coin_steps: 2,
  coin_weigh: 1,
  coin_week_bonus: 30,
  week_target: 4, // ฝึกครบกี่ครั้งต่อสัปดาห์ (ทั้งโบนัสและไฟรายสัปดาห์)
  training_days: [1, 2, 4, 5], // วันฝึกตามแผน 0 = อาทิตย์ (ค่าเริ่มต้น จ อ พฤ ศ)
  max_rest_days: 3, // วันที่ไม่ได้ฝึกนับเป็นวันพักได้ไม่เกินกี่วันต่อสัปดาห์ (จ–อา)
  allowed_per_week: 1, // วัน "ได้รับอนุญาต" (แลกของกิน) ที่ไม่ตัดไฟ ต่อสัปดาห์
  tier1_days: 7,
  tier1_mult: 1.2,
  tier2_days: 14,
  tier2_mult: 1.5,
  tier3_days: 30,
  tier3_mult: 2,
  freeze_price: 30,
  backdate_days: 2, // แก้ข้อมูลย้อนหลังเกินกี่วันแล้วไม่ได้ coin
  big_meal_kcal: 800, // แลกของกินตั้งแต่เท่านี้ → ขึ้นคำแนะนำลดวันอื่น
  start_date: null, // coin นับเฉพาะวันที่ ≥ วันนี้ (YYYY-MM-DD) · ตั้งเป็นวันนี้ตามเวลาไทยตอนสร้างการตั้งค่าครั้งแรก · null = นับทุกวัน (ไฟนับจากประวัติทั้งหมดเสมอ)
};
