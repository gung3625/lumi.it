const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }
  const { email, success } = body;
  if (!email || !success) {
    return { statusCode: 200, body: JSON.stringify({ counted: false, reason: '게시 실패 — 카운팅 안 함' }) };
  }

  try {
    const store = getStore({ name: 'users', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    let raw;
    try { raw = await store.get('user:' + email); } catch(e) { raw = null; }
    if (!raw) return { statusCode: 404, body: JSON.stringify({ error: '사용자를 찾을 수 없습니다.' }) };

    const user = JSON.parse(raw);
    const now = new Date();
    const thisMonth = now.getFullYear() + '-' + (now.getMonth() + 1);
    if (user.postCountMonth !== thisMonth) { user.postCountMonth = thisMonth; user.postCount = 0; }
    user.postCount = (user.postCount || 0) + 1;
    user.lastPostedAt = now.toISOString();
    await store.set('user:' + email, JSON.stringify(user));

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ counted: true, postCount: user.postCount, postCountMonth: user.postCountMonth }) };
  } catch (err) {
    console.error('count-post error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: '카운팅 처리 중 오류가 발생했습니다.' }) };
  }
};
