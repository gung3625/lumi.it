// 택배사 목록 — Sprint 3 (모바일 송장 입력 드롭다운용)
// GET /api/list-couriers

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { listCouriers } = require('./_shared/courier-codes');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, couriers: listCouriers() }),
  };
};
