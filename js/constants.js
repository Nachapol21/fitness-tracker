// ค่าคงที่ที่ใช้ร่วมกันทั้งแอป (ไม่มี DOM จึงใช้ใน Node ได้)

export const APP_VERSION = '0.2.0';
export const DATA_FORMAT = 'fitness-tracker';
export const DATA_VERSION = 1;

// โปรไฟล์มีเรคคอร์ดเดียว ใช้ UUID คงที่ เพื่อให้หลายเครื่องซิงก์แล้วไม่เกิดโปรไฟล์ซ้ำ
export const PROFILE_ID = '00000000-0000-4000-8000-000000000001';

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
