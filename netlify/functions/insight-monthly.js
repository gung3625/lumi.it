// insight-monthly.js — 월간 AI 인사이트 보고서 (셀러 본인 조회)
//
// GET /api/insight-monthly
//   Header: Authorization: Bearer <seller_jwt>
//   Query: refresh=true / mock=true

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { buildReport } = require('./_shared/insight-builder');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
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
      reportType: 'monthly',
      forceRefresh,
      mock,
    });
    if (!result.ok) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: result.error || '보고서 생성 실패' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
  } catch (e) {
    console.error('[insight-monthly] 핸들러 에러:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '월간 인사이트를 불러오지 못했어요.' }),
    };
  }
};
