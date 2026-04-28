// external-currency.js — 환율 endpoint (Tier 0, 캐싱 6시간)
// GET /api/external-currency?base=USD&target=KRW

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getRate } = require('./_shared/external-apis/currency');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const q = event.queryStringParameters || {};
  const base = (q.base || 'USD').toUpperCase();
  const target = (q.target || 'KRW').toUpperCase();
  try {
    const r = await getRate({ base, target });
    return { statusCode: 200, headers: CORS, body: JSON.stringify(r) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, summary: '환율을 불러오지 못했어요' }) };
  }
};
