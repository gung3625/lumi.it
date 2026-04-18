const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

// 👍👎 피드백 저장 함수
// 피드백에 따라 tone-like / tone-dislike 업데이트

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { captionId, feedback } = body; // feedback: 'like' | 'dislike'
  if (!captionId || !['like', 'dislike'].includes(feedback)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'captionId, feedback(like/dislike) 필수' }) };
  }

  try {
    const store = getStore({
      name: 'users', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    // 토큰으로 이메일 조회
    let tokenRaw;
    try { tokenRaw = await store.get('token:' + token); if (tokenRaw) { const td = JSON.parse(tokenRaw); if (td.expiresAt && new Date(td.expiresAt) < new Date()) { tokenRaw = null; } } } catch { tokenRaw = null; }
    if (!tokenRaw) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
    const { email } = JSON.parse(tokenRaw);

    // 1. caption-history에서 해당 캡션 찾아 피드백 업데이트
    let history = [];
    try {
      const raw = await store.get('caption-history:' + email);
      if (raw) history = JSON.parse(raw);
    } catch { history = []; }

    const entry = history.find(h => h.id === captionId);
    if (!entry) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '캡션을 찾을 수 없습니다.' }) };

    const prevFeedback = entry.feedback;
    entry.feedback = feedback;
    await store.set('caption-history:' + email, JSON.stringify(history));

    // 2. tone-like / tone-dislike 업데이트
    const likeKey = 'tone-like:' + email;
    const dislikeKey = 'tone-dislike:' + email;

    let likes = [];
    let dislikes = [];
    try { const r = await store.get(likeKey); if (r) likes = JSON.parse(r); } catch {}
    try { const r = await store.get(dislikeKey); if (r) dislikes = JSON.parse(r); } catch {}

    // 이전 피드백이 있으면 해당 목록에서 제거
    if (prevFeedback === 'like') likes = likes.filter(c => c.id !== captionId);
    if (prevFeedback === 'dislike') dislikes = dislikes.filter(c => c.id !== captionId);

    const captionObj = { id: captionId, caption: entry.caption, savedAt: new Date().toISOString() };

    // 새 피드백 목록에 추가 (최대 5개)
    if (feedback === 'like') {
      likes.unshift(captionObj);
      if (likes.length > 5) likes = likes.slice(0, 5);
      await store.set(likeKey, JSON.stringify(likes));
    } else {
      dislikes.unshift(captionObj);
      if (dislikes.length > 5) dislikes = dislikes.slice(0, 5);
      await store.set(dislikeKey, JSON.stringify(dislikes));
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, likes: likes.length, dislikes: dislikes.length })
    };
  } catch (err) {
    console.error('tone-feedback error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장 실패' }) };
  }
};
