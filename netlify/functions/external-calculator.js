// external-calculator.js — 마진/VAT/수수료 자체 계산 endpoint (Tier 0, ₩0)
// POST /api/external-calculator
// Body: { input: "마진 50000 30000" }

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { interpret } = require('./_shared/external-apis/calculator');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식' }) };
  }
  const input = String(body.input || '').slice(0, 200);
  try {
    const r = interpret(input);
    return { statusCode: 200, headers: CORS, body: JSON.stringify(r) };
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, summary: '계산 오류' }),
    };
  }
};
