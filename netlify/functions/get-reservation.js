const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': 'https://lumi.it.kr',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const { key } = event.queryStringParameters || {};
  const authHeader = event.headers['authorization'] || '';
  const headerSecret = event.headers['x-lumi-secret'] || '';

  if (!key) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'key 필수' }) };
  // Bearer 토큰 또는 LUMI_SECRET (헤더로만)
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const hasSecret = headerSecret === process.env.LUMI_SECRET;

  if (!bearerToken && !hasSecret) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  // Bearer 토큰 Blobs 검증 + 만료 체크
  let tokenEmail = null;
  if (bearerToken && !hasSecret) {
    const userStore = getStore({ name: 'users', consistency: 'strong' });
    const tokenRaw = await userStore.get('token:' + bearerToken).catch(() => null);
    if (!tokenRaw) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 인증입니다.' }) };
    }
    const tokenData = JSON.parse(tokenRaw);
    if (tokenData.expiresAt && Date.now() > tokenData.expiresAt) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '토큰이 만료되었습니다.' }) };
    }
    tokenEmail = tokenData.email || null;
  }

  try {
    const store = getStore({
      name: 'reservations',
      consistency: 'strong'
    });

    const raw = await store.get(key);
    if (!raw) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '예약 없음' }) };

    const item = JSON.parse(raw);

    // C1: IDOR 방지 — Bearer 토큰 사용자는 자신의 예약만 조회 가능
    if (tokenEmail && item.storeProfile?.ownerEmail && tokenEmail !== item.storeProfile.ownerEmail) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '접근 권한이 없습니다.' }) };
    }

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
        relayMode: item.relayMode === true,
        imageKeys: (item.imageKeys || item.tempKeys || []).slice(0, 10),
        imageAnalysis: hasSecret ? (item.imageAnalysis || null) : undefined,
      }),
    };
  } catch (err) {
    console.error('get-reservation error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '오류가 발생했습니다.' }) };
  }
};
