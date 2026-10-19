// ค่าเชื่อมต่อ Supabase ฝั่งเว็บ (ใช้ในซิงก์ระหว่างเครื่อง — js/auth.js และ js/sync.js)
//
// publishableKey เป็น "publishable key" ซึ่ง Supabase ออกแบบให้อยู่ในโค้ดฝั่งเว็บได้ ใครเห็นก็ทำอะไรไม่ได้
// ความปลอดภัยของข้อมูลมาจาก Row Level Security ที่เซิร์ฟเวอร์ (ผู้ล็อกอินเห็น/แก้ได้เฉพาะแถวของตัวเอง ไม่มีสิทธิ์ลบ)
// ห้ามใส่ service_role หรือ secret key ในไฟล์นี้เด็ดขาด (tests/ จะตรวจและล้มถ้าเจอ)
// ถ้าจะปิดซิงก์: ตั้ง url หรือ publishableKey เป็นสตริงว่าง แอปจะซ่อนส่วนบัญชีและทำงานแบบในเครื่องล้วน

export const SYNC_CONFIG = {
  url: 'https://tjmjqcqdesctuduzmqmf.supabase.co',
  publishableKey: 'sb_publishable_yscr6NbQ5kR3Prn4E86Y5A_DJp0fMuN',
};
