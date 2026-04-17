const { getStore } = require('@netlify/blobs');
const busboy = require('busboy');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 인증: Bearer 토큰 필수 + Blobs 검증
  const authHeader = event.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ') || authHeader.length < 10) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  const bearerToken = authHeader.slice(7).trim();
  try {
    const tokenStore = getStore({
      name: 'users', consistency: 'strong'
    });
    const tokenRaw = await tokenStore.get('token:' + bearerToken);
    if (!tokenRaw) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 인증입니다.' }) };
    }
    const tokenData = JSON.parse(tokenRaw);
    if (new Date(tokenData.expiresAt) < new Date()) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 만료됐습니다. 다시 로그인해주세요.' }) };
    }
  } catch(e) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 확인 중 오류가 발생했습니다.' }) };
  }

  const headers = event.headers;
  const isBase64Encoded = event.isBase64Encoded;
  const bodyBuffer = Buffer.from(event.body, isBase64Encoded ? 'base64' : 'utf8');

  return new Promise((resolve) => {
    const bb = busboy({ headers });
    const fields = {};
    const photos = [];

    const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
    bb.on('file', (name, file, info) => {
      if (!ALLOWED_MIME.includes(info.mimeType)) {
        file.resume(); // 스트림 소비 후 무시
        return;
      }
      const chunks = [];
      file.on('data', (d) => chunks.push(d));
      file.on('end', () => {
        photos.push({
          fileName: info.filename,
          mimeType: info.mimeType,
          base64: Buffer.concat(chunks).toString('base64')
        });
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('finish', async () => {
      if (photos.length === 0) {
        return resolve({ statusCode: 400, headers: CORS, body: JSON.stringify({ error: '사진이 없습니다.' }) });
      }
      if (!fields.scheduledAt) {
        return resolve({ statusCode: 400, headers: CORS, body: JSON.stringify({ error: '예약 시간이 없습니다.' }) });
      }

      try {
        let weather = {};
        let trends = [];
        let storeProfile = {};
        try { weather = JSON.parse(fields.weather || '{}'); } catch(e) {}
        try { trends = JSON.parse(fields.trends || '[]'); } catch(e) {}
        try { storeProfile = JSON.parse(fields.storeProfile || '{}'); } catch(e) {}

        const reservationId = 'reserve:' + Date.now() + ':' + Math.random().toString(36).substr(2, 6);

        const item = {
          id: reservationId,
          photos,
          photoCount: photos.length,
          userMessage: fields.userMessage || '',
          bizCategory: fields.bizCategory || 'cafe',
          captionTone: fields.captionTone || '',
          tagStyle: fields.tagStyle || 'mid',
          weather,
          trends,
          storeProfile,
          submittedAt: fields.submittedAt || new Date().toISOString(),
          scheduledAt: fields.scheduledAt,
          isSent: false
        };

        const store = getStore({
          name: 'reservations', consistency: 'strong'
        });

        await store.set(reservationId, JSON.stringify(item));

        resolve({
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ success: true, id: reservationId, scheduledAt: fields.scheduledAt })
        });

      } catch(err) {
        console.error('save-reservation error:', err);
        resolve({ statusCode: 500, headers: CORS, body: JSON.stringify({ error: '예약 저장 중 오류가 발생했습니다.' }) });
      }
    });

    bb.end(bodyBuffer);
  });
};
