// external-holiday.js — 공휴일 endpoint (Tier 0, 캐싱 30일)
// GET /api/external-holiday?upcoming=3
// GET /api/external-holiday?name=어린이날

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getUpcoming, findByName } = require('./_shared/external-apis/holiday');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const q = event.queryStringParameters || {};
  try {
    if (q.name) {
      const r = await findByName(q.name);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(r) };
    }
    const count = Math.max(1, Math.min(10, Number(q.upcoming || 3)));
    const r = await getUpcoming({ count });
    return { statusCode: 200, headers: CORS, body: JSON.stringify(r) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, summary: '공휴일을 불러오지 못했어요' }) };
  }
};
