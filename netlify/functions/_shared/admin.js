// 관리자 판정 — 환경변수 LUMI_ADMIN_EMAILS (쉼표 구분) + 하드코딩 이메일/ID 폴백
const FALLBACK_ADMINS = ['gung3625@gmail.com'];
const FALLBACK_ADMIN_IDS = ['47baf39a-a959-4431-9da9-0ef65a5e9465'];

function getAdminEmails() {
  const env = (process.env.LUMI_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const fallback = FALLBACK_ADMINS.map(s => s.toLowerCase());
  return Array.from(new Set([...fallback, ...env]));
}

function isAdminEmail(email) {
  if (!email) return false;
  return getAdminEmails().includes(String(email).toLowerCase());
}

function isAdminUserId(id) {
  if (!id) return false;
  return FALLBACK_ADMIN_IDS.includes(String(id));
}

module.exports = { isAdminEmail, isAdminUserId, getAdminEmails };
