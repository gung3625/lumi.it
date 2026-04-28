// insight-on-demand.js — 셀러 수동 요청 보고서 (사용자 지정 기간)
//
// POST /api/insight-on-demand
//   Header: Authorization: Bearer <seller_jwt>
//   Body: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', refresh?: boolean, mock?: boolean }
//
// 비용 한도(₩200/월)는 동일하게 적용되며, 캐시 24시간.

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { buildReport } = require('./_shared/insight-builder');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_PERIOD_DAYS = 90;

function parseBody(event) {
  if (!event.body) return {};
  try { return JSON.parse(event.body); } catch (_) { return {}; }
}

function isValidDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: jwtErr }) };
  }

  const body = parseBody(event);
  const { start, end, refresh, mock } = body;

  if (!isValidDateString(start) || !isValidDateString(end)) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'start, end은 YYYY-MM-DD 형식이어야 해요.' }),
    };
  }
  const sd = new Date(start);
  const ed = new Date(end);
  if (sd > ed) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'start는 end보다 빨라야 해요.' }) };
  }
  const days = Math.ceil((ed.getTime() - sd.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (days > MAX_PERIOD_DAYS) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: `최대 ${MAX_PERIOD_DAYS}일까지 조회할 수 있어요.` }),
    };
  }

  let admin;
  try { admin = getAdminClient(); }
  catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase 초기화 실패' }) };
  }

  try {
    const result = await buildReport({
      admin,
      sellerId: payload.seller_id,
      reportType: 'on_demand',
      forceRefresh: !!refresh,
      mock: !!mock,
      customStart: start,
      customEnd: end,
    });
    if (!result.ok) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: result.error || '보고서 생성 실패' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
  } catch (e) {
    console.error('[insight-on-demand] 핸들러 에러:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '인사이트 생성 중 오류가 발생했어요.' }),
    };
  }
};
