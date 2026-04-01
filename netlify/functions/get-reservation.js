const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const { key, secret } = event.queryStringParameters || {};

  if (!key) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'key 필수' }) };
  if (secret !== process.env.LUMI_SECRET) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 실패' }) };

  try {
    const store = getStore({
      name: 'reservations',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });

    const raw = await store.get(key);
    if (!raw) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '예약 없음' }) };

    const item = JSON.parse(raw);

    // 민감 정보 제거 후 반환
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        reservationKey: key,
        generatedCaptions: item.generatedCaptions || null,
        captionsGeneratedAt: item.captionsGeneratedAt || null,
        isSent: item.isSent || false,
        sentAt: item.sentAt || null,
        regenCount: item.regenCount || 0,
      }),
    };
  } catch (err) {
    console.error('get-reservation error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '오류가 발생했습니다.' }) };
  }
};
