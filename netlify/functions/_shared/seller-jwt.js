// 셀러 전용 JWT 발급/검증 헬퍼
// - HS256, JWT_SECRET 환경변수 사용
// - 14일 유효, payload = { seller_id }
// - 기존 Supabase Auth와 별도, 향후 통합 예정
const crypto = require('crypto');

const JWT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14일

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input) {
  const pad = 4 - (input.length % 4 || 4);
  const padded = input + '='.repeat(pad % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET 환경변수가 설정되지 않았거나 32자 미만입니다.');
  }
  return secret;
}

/**
 * 셀러 JWT 발급
 * @param {{ seller_id: string }} payload
 * @returns {string} JWT 토큰
 */
function signSellerToken(payload) {
  const secret = getSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + JWT_TTL_SECONDS,
    iss: 'lumi-onboarding',
  };

  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encBody = base64UrlEncode(JSON.stringify(body));
  const signingInput = `${encHeader}.${encBody}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

/**
 * 셀러 JWT 검증
 * @param {string} token
 * @returns {{ payload: object|null, error: string|null }}
 */
function verifySellerToken(token) {
  if (!token || typeof token !== 'string') {
    return { payload: null, error: '토큰이 없습니다.' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { payload: null, error: '잘못된 토큰 형식입니다.' };

  let secret;
  try { secret = getSecret(); } catch (e) {
    return { payload: null, error: e.message };
  }

  const [encHeader, encBody, providedSig] = parts;
  const signingInput = `${encHeader}.${encBody}`;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // timing-safe 비교
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return { payload: null, error: '서명이 일치하지 않습니다.' };
  if (!crypto.timingSafeEqual(a, b)) return { payload: null, error: '서명이 일치하지 않습니다.' };

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encBody).toString('utf8'));
  } catch (_) {
    return { payload: null, error: '페이로드 디코드 실패' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    return { payload: null, error: '만료된 토큰입니다.' };
  }
  if (payload.iss !== 'lumi-onboarding') {
    return { payload: null, error: '발급자가 일치하지 않습니다.' };
  }
  if (!payload.seller_id) {
    return { payload: null, error: 'seller_id 누락' };
  }
  return { payload, error: null };
}

/**
 * Bearer 헤더에서 토큰 추출
 */
function extractBearerToken(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

// === refresh token (audit #2) ===
// 사장님 결정 2026-05-17: access JWT 14일 만료 시 매번 카카오 재로그인 불편.
// refresh token 도입 — 30일 TTL, sha256 hash 저장, 사용 시 rotation (옛 토큰 revoke).
//
// 동작:
//   1) callback (kakao 등) → access JWT + refresh token plain 동시 발급. DB 에 hash 저장.
//   2) 클라이언트 access 만료 임박 또는 401 → /api/auth-refresh 호출 (refresh plain 전달).
//   3) 서버: hash 조회 → revoked_at NULL + expires_at 미래면 통과 → 새 access + 새 refresh 발급.
//      옛 row revoked_at = now, replaced_by_id = 새 row (rotation chain — 도난 forensic).
//   4) 사장님 재로그인 / 로그아웃 시 옛 refresh row 전부 revoke.

const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30일

/**
 * 신규 refresh token 생성 — 32바이트 random hex + sha256 hash.
 * 평문은 클라이언트에 1번만 전달, DB 에는 hash 만 저장 (도난 방어).
 * @returns {{ plain: string, hash: string, expiresAt: Date }}
 */
function generateRefreshToken() {
  const plain = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(plain).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  return { plain, hash, expiresAt };
}

/**
 * 평문 refresh token → sha256 hash (DB lookup 용).
 */
function hashRefreshToken(plain) {
  if (!plain || typeof plain !== 'string') return null;
  return crypto.createHash('sha256').update(plain).digest('hex');
}

module.exports = {
  signSellerToken,
  verifySellerToken,
  extractBearerToken,
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
};
