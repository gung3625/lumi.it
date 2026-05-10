// 가입 플로우 공용 헬퍼
// - 휴대폰/이메일 마스킹 (로그 표시용)
// - 추천 코드 생성

/**
 * 휴대폰 번호 정규화 (숫자만)
 */
function normalizePhone(input) {
  if (!input || typeof input !== 'string') return '';
  return input.replace(/\D/g, '');
}

/**
 * 휴대폰 형식 검증 (01[016789]xxxxxxxx)
 */
function isValidPhone(input) {
  const num = normalizePhone(input);
  return /^01[016789]\d{7,8}$/.test(num);
}

/**
 * 휴대폰 번호 마스킹 — '010-***-1234'
 */
function maskPhone(input) {
  const num = normalizePhone(input);
  if (num.length < 9) return '***';
  return `${num.slice(0, 3)}-***-${num.slice(-4)}`;
}

/**
 * 이메일 마스킹 — 'k***@example.com'
 */
function maskEmail(input) {
  if (!input || typeof input !== 'string') return '';
  const [local, domain] = input.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

/**
 * 생년월일 정규화 (YYYY-MM-DD 또는 YYYYMMDD → YYYY-MM-DD)
 */
function normalizeBirthDate(input) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6)}`;
  }
  return '';
}

/**
 * referral_code 6자리 영숫자 — seed(seller_id 등) + 시각 해시 기반
 */
function generateReferralCode(seed) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(String(seed) + Date.now()).digest('hex');
  // base36 6자리 (대문자)
  return hash.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 6);
}

module.exports = {
  normalizePhone,
  isValidPhone,
  maskPhone,
  maskEmail,
  normalizeBirthDate,
  generateReferralCode,
};
