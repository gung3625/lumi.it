const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const { key, secret } = event.queryStringParameters || {};
  const authHeader = event.headers['authorization'] || '';

  if (!key) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'key 필수' }) };
  // Bearer 토큰 또는 LUMI_SECRET으로 인증
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const hasSecret = secret === process.env.LUMI_SECRET;

  if (!bearerToken && !hasSecret) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  // Bearer 토큰 Blobs 검증
  if (bearerToken && !hasSecret) {
    const userStore = getStore({ name: 'users', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    const tokenData = await userStore.get('token:' + bearerToken).catch(() => null);
    if (!tokenData) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 인증입니다.' }) };
    }
  }

  try {
    const store = getStore({
      name: 'reservations',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
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
        captionStatus: item.captionStatus || null,
        captionError: item.captionError || null,
        selectedCaptionIndex: item.selectedCaptionIndex ?? null,
        autoPostAt: item.autoPostAt || null,
        isSent: item.isSent || false,
        sentAt: item.sentAt || null,
        regenCount: item.regenCount || 0,
        postError: item.postError || null,
        imageKeys: (item.imageKeys || item.tempKeys || []).slice(0, 10),
        imageAnalysis: hasSecret ? (item.imageAnalysis || null) : undefined,
      }),
    };
  } catch (err) {
    console.error('get-reservation error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '오류가 발생했습니다.' }) };
  }
};
