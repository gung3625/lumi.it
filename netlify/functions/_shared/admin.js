// 관리자 이메일 판정 — 환경변수 LUMI_ADMIN_EMAILS (쉼표 구분) + 하드코딩 폴백
const FALLBACK_ADMINS = ['gung3625@gmail.com'];

function getAdminEmails() {
  const env = (process.env.LUMI_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const fallback = FALLBACK_ADMINS.map(s => s.toLowerCase());
  return Array.from(new Set([...fallback, ...env]));
}

function isAdminEmail(email) {
  if (!email) return false;
  return getAdminEmails().includes(String(email).toLowerCase());
}

module.exports = { isAdminEmail, getAdminEmails };
