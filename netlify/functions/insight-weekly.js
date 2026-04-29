// insight-weekly.js — 주간 AI 인사이트 보고서 (셀러 본인 조회)
//
// GET /api/insight-weekly
//   Header: Authorization: Bearer <seller_jwt>
//   Query (optional):
//     - refresh=true  → 캐시 무시, 강제 재생성 (월 ₩200 한도 차감)
//     - mock=true     → LLM 호출 생략, fallback 보고서 즉시 반환
//
// 응답:
//   { ok: true, period, report: {...}, cached, cost_krw, reportId }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { buildReport } = require('./_shared/insight-builder');

const { corsHeaders, getOrigin } = require('./_shared/auth');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: jwtErr }) };
  }

  const params = new URLSearchParams(event.rawQuery || '');
  const forceRefresh = params.get('refresh') === 'true';
  const mock = params.get('mock') === 'true';

  let admin;
  try { admin = getAdminClient(); }
  catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase 초기화 실패' }) };
  }

  try {
    const result = await buildReport({
      admin,
      sellerId: payload.seller_id,
      reportType: 'weekly',
      forceRefresh,
      mock,
    });
    if (!result.ok) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: result.error || '보고서 생성 실패' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
  } catch (e) {
    console.error('[insight-weekly] 핸들러 에러:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '주간 인사이트를 불러오지 못했어요.' }),
    };
  }
};
