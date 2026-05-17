// error-log.js — 사장님 device 의 JS 에러 / unhandled rejection 수집 (audit 후속)
//
// POST /api/error-log
// Body: { message, stack?, url?, line?, col?, userAgent? }
// 인증: Bearer (optional) — 로그인 사장님 에러는 seller_id 바인딩, 비로그인 anon
// 응답: { ok: true } (조용히 — 사용자 인지 X)
//
// 보안 / 안정성:
// - rate-limit: 분당 30건 per IP (악의적 spam 방어)
// - message / stack truncate (4KB / 8KB) — DB 보호
// - 인증 토큰 무효해도 anon 으로 받음 (저장 자체 실패 안 시키기)
// - 자체 에러 catch — error-log 가 또 에러 발생하면 무한 loop. try/catch 로 보호.

const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');

const MAX_MESSAGE = 4 * 1024;   // 4KB
const MAX_STACK   = 8 * 1024;   // 8KB
const MAX_URL     = 2 * 1024;
const MAX_UA      = 1024;
const RATE_LIMIT_PER_MIN = 30;

// 메모리 기반 in-process rate-limit (Netlify function 인스턴스별).
// production 에선 instance 여러 개라 부분 한정이나, abuse 차단 충분.
const rateBuckets = new Map();
function rateLimit(ip) {
  if (!ip) return true; // ip 모름 → 통과 (저장은 함)
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + 60 * 1000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60 * 1000;
  }
  bucket.count++;
  rateBuckets.set(ip, bucket);
  // 메모리 leak 방어: 1000개 넘으면 만료된 거 정리
  if (rateBuckets.size > 1000) {
    for (const [k, v] of rateBuckets) {
      if (now > v.resetAt) rateBuckets.delete(k);
    }
  }
  return bucket.count <= RATE_LIMIT_PER_MIN;
}

function truncate(s, max) {
  if (!s || typeof s !== 'string') return null;
  return s.length > max ? s.slice(0, max) : s;
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST 전용' }) };
  }

  const ip = (event.headers && (event.headers['x-forwarded-for'] || '').split(',')[0].trim()) || null;
  if (!rateLimit(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ ok: false, throttled: true }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    // 잘못된 JSON — 200 으로 응답 (사용자 에러 보호, DB insert 안 함)
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'invalid_json' }) };
  }

  const message = truncate(body.message, MAX_MESSAGE);
  if (!message) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'no_message' }) };
  }

  // 선택 인증 — 토큰 있고 유효하면 seller_id 바인딩
  let sellerId = null;
  try {
    const token = extractBearerToken(event);
    if (token) {
      const { payload } = verifySellerToken(token);
      if (payload && payload.seller_id) sellerId = payload.seller_id;
    }
  } catch (_) { /* 토큰 검증 실패 — anon 으로 진행 */ }

  try {
    const admin = getAdminClient();
    const { error } = await admin.from('client_errors').insert({
      seller_id: sellerId,
      message,
      stack:      truncate(body.stack, MAX_STACK),
      url:        truncate(body.url, MAX_URL),
      line:       Number.isFinite(body.line) ? Math.floor(body.line) : null,
      col:        Number.isFinite(body.col) ? Math.floor(body.col) : null,
      user_agent: truncate(body.userAgent || (event.headers && event.headers['user-agent']) || '', MAX_UA),
      ip_address: ip,
    });
    if (error) {
      // 자체 에러 — 사용자에게 노출 안 함, server console 에만
      console.error('[error-log] insert 실패:', error.message);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'db_error' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('[error-log] 예외:', e && e.message);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
