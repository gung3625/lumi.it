// external-weather.js — 날씨 endpoint (Tier 0, 캐싱 1시간)
// GET /api/external-weather?city=서울

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getWeather } = require('./_shared/external-apis/weather');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const city = (event.queryStringParameters || {}).city || '서울';
  try {
    const r = await getWeather({ city });
    return { statusCode: 200, headers: CORS, body: JSON.stringify(r) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, summary: '날씨를 불러오지 못했어요' }) };
  }
};
