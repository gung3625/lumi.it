const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function makeStore(name) {
  return getStore({
    name,
    consistency: 'strong'
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 필요' }) };

  try {
    const userStore = makeStore('users');
    const tokenRaw = await userStore.get('token:' + token).catch(() => null);
    if (!tokenRaw) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
    const tokenData = JSON.parse(tokenRaw);
    if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '세션 만료' }) };
    }
    const { email } = tokenData;

    const reserveStore = makeStore('reservations');
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

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        post: {
          caption: best.caption,
          imageKey: best.imageKey,
          imageUrl: best.imageUrl,
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
