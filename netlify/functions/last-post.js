const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 필요' }) };

  try {
    const userStore = getStore({ name: 'users', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });

    // 토큰 Blobs 검증 (5회 지수 백오프 — PAT rate-limit 대응)
    let tokenRaw = null;
    let tokenBlobError = false;
    const RETRY_DELAYS = [200, 400, 800, 1600, 3200];
    for (let i = 0; i < RETRY_DELAYS.length; i++) {
      tokenBlobError = false;
      try { tokenRaw = await userStore.get('token:' + token); }
      catch(e) { tokenBlobError = true; console.error('[last-post] token blob fetch error (attempt ' + (i+1) + '):', e.message); }
      if (tokenRaw) break;
      if (!tokenBlobError) break;
      if (i < RETRY_DELAYS.length - 1) await new Promise(r => setTimeout(r, RETRY_DELAYS[i]));
    }
    if (!tokenRaw) {
      if (tokenBlobError) {
        console.warn('[last-post] token blob error after 5 retries, bearer prefix:', token.substring(0, 8));
        return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: '일시적 서버 오류입니다. 잠시 후 다시 시도해주세요.' }) };
      }
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
    }
    const tokenData = JSON.parse(tokenRaw);
    if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '세션 만료' }) };
    }
    const { email } = tokenData;

    const reserveStore = getStore({ name: 'reservations', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    const { blobs } = await reserveStore.list({ prefix: 'reserve:' });
    // key는 'reserve:{timestamp}' — 내림차순 정렬 후 최근 60건만 fetch (성능)
    const sorted = (blobs || []).slice().sort((a, b) => (b.key || '').localeCompare(a.key || '')).slice(0, 60);
    const rawList = await Promise.all(sorted.map(b =>
      reserveStore.get(b.key).then(v => ({ key: b.key, raw: v })).catch(() => ({ key: b.key, raw: null }))
    ));

    let best = null;
    for (const { key, raw } of rawList) {
      if (!raw) continue;
      let it;
      try { it = JSON.parse(raw); } catch { continue; }
      const ownerEmail = (it.storeProfile && (it.storeProfile.ownerEmail || it.storeProfile.email)) || it.ownerEmail || null;
      if (ownerEmail !== email) continue;
      if (!it.isSent) continue;
      const sentAt = it.sentAt ? new Date(it.sentAt) : null;
      if (!sentAt || isNaN(sentAt.getTime())) continue;
      if (!best || sentAt > best.sentAtDate) {
        best = {
          key,
          sentAtDate: sentAt,
          caption: it.postedCaption || (it.captions && it.captions[0]) || (it.generatedCaptions && it.generatedCaptions[0]) || '',
          imageKey: (it.imageKeys && it.imageKeys[0]) || (it.tempKeys && it.tempKeys[0]) || null,
          imageUrl: (it.imageUrls && it.imageUrls[0]) || null,
          instagramPostId: it.instagramPostId || null,
          sentAt: it.sentAt,
          igUsername: (it.storeProfile && it.storeProfile.instagram) || null,
        };
      }
    }

    if (!best) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ post: null }) };
    }

    // last-post-images store에서 imageKeys 배열 조회
    let imageKeys = [];
    try {
      const lpStore = getStore({ name: 'last-post-images', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
      const { blobs: lpBlobs } = await lpStore.list({ prefix: 'last-post:' + email + ':' });
      if (lpBlobs && lpBlobs.length > 0) {
        imageKeys = lpBlobs
          .map(b => b.key)
          .sort((a, b) => {
            const ai = parseInt(a.split(':').pop(), 10) || 0;
            const bi = parseInt(b.split(':').pop(), 10) || 0;
            return ai - bi;
          });
      }
    } catch (e) {
      console.warn('[last-post] last-post-images 조회 실패:', e.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        post: {
          caption: best.caption,
          imageKeys: imageKeys,
          imageKey: imageKeys[0] || best.imageKey,
          imageUrl: imageKeys.length > 0 ? null : best.imageUrl,
          instagramPostId: best.instagramPostId,
          sentAt: best.sentAt,
          igUsername: best.igUsername,
        },
      }),
    };
  } catch (err) {
    console.error('[last-post] 오류:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '오류가 발생했습니다' }) };
  }
};
