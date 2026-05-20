// quota-status.js — OpenAI 일일 quota 사용량 조회 (사용자 가시화).
//
// 2026-05-20 prevention #5: 사장님이 사진 업로드 후에야 quota 초과 알게 되는 상황
// 차단. register-product 페이지에서 사전 조회 → 한도 임박/초과 시 사장님에게 경고.
//
// GET /api/quota-status
// Auth: Bearer 토큰 (anonymous 노출 금지 — 서비스 한도 정보)
// 응답: { used, limit, remaining, percentUsed, status: 'ok'|'warn'|'critical'|'exceeded' }
//
// 캐시: 응답 자체 짧은 TTL (Cache-Control no-cache, 호출자가 30초 정도 메모리 캐시 권장)

'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { getServiceDailyUsage } = require('./_shared/openai-quota');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };
  }

  // 인증 — supabase JWT 또는 seller-jwt 둘 다 허용 (둘 다 사장님 식별 OK).
  const token = extractBearerToken(event);
  const { user } = await verifyBearerToken(token);
  let authed = !!(user && user.id);
  if (!authed) {
    const { payload } = verifySellerToken(token);
    authed = !!(payload && payload.seller_id);
  }
  if (!authed) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const { used, count, limit, error } = await getServiceDailyUsage();
    if (error) {
      console.warn('[quota-status] usage 조회 실패:', error);
    }
    const remaining = Math.max(0, limit - used);
    const percentUsed = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    let status = 'ok';
    if (percentUsed >= 100) status = 'exceeded';
    else if (percentUsed >= 90) status = 'critical';
    else if (percentUsed >= 70) status = 'warn';

    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ used, count, limit, remaining, percentUsed, status }),
    };
  } catch (e) {
    console.error('[quota-status] 예외:', e && e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '조회 실패' }) };
  }
};
