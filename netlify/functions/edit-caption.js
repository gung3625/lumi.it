const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const authHeader = event.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 필요' }) };
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청' }) };
  }

  const { reservationKey, captionIndex, newCaption } = body;
  if (!reservationKey || captionIndex === undefined || !newCaption) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'reservationKey, captionIndex, newCaption 필수' }) };
  }

  try {
    // 토큰 → 이메일 검증
    const userStore = getStore({ name: 'users', consistency: 'strong' });
    let tokenRaw;
    try { tokenRaw = await userStore.get('token:' + bearerToken); } catch { tokenRaw = null; }
    if (!tokenRaw) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
    const { email } = JSON.parse(tokenRaw);

    const store = getStore({
      name: 'reservations',
      consistency: 'strong'
    });

    const raw = await store.get(reservationKey);
    if (!raw) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '예약 없음' }) };

    const item = JSON.parse(raw);

    // 소유자 검증
    if (item.storeProfile?.ownerEmail !== email) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '권한이 없습니다.' }) };
    if (item.isSent) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이미 게시된 항목입니다.' }) };

    const captions = item.generatedCaptions || item.captions || [];
    if (captionIndex < 0 || captionIndex >= captions.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 캡션 인덱스' }) };
    }

    captions[captionIndex] = newCaption.trim();
    item.generatedCaptions = captions;
    item.captions = captions;
    item.captionEditedAt = new Date().toISOString();
    await store.set(reservationKey, JSON.stringify(item));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, captions }),
    };
  } catch (err) {
    console.error('edit-caption error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '오류가 발생했습니다.' }) };
  }
};
