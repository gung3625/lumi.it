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
    // 토큰 → 이메일 검증 (5회 지수 백오프)
    const userStore = getStore({ name: 'users', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    let tokenRaw = null;
    let tokenBlobError = false;
    const RETRY_DELAYS = [200, 400, 800, 1600, 3200];
    for (let i = 0; i < RETRY_DELAYS.length; i++) {
      tokenBlobError = false;
      try { tokenRaw = await userStore.get('token:' + bearerToken); }
      catch(e) { tokenBlobError = true; console.error('[edit-caption] token blob fetch error (attempt ' + (i+1) + '):', e.message); }
      if (tokenRaw) break;
      if (!tokenBlobError) break;
      if (i < RETRY_DELAYS.length - 1) await new Promise(r => setTimeout(r, RETRY_DELAYS[i]));
    }
    if (!tokenRaw) {
      if (tokenBlobError) {
        console.warn('[edit-caption] token blob error after 5 retries, bearer prefix:', bearerToken.substring(0, 8));
        return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: '일시적 서버 오류입니다. 잠시 후 다시 시도해주세요.' }) };
      }
      console.warn('[edit-caption] token not found, bearer prefix:', bearerToken.substring(0, 8));
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
    }
    const { email } = JSON.parse(tokenRaw);

    const store = getStore({
      name: 'reservations',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
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
