const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }
  const { email } = body;
  if (!email) return { statusCode: 400, body: JSON.stringify({ error: '이메일이 필요합니다.' }) };

  try {
    const store = getStore({ name: 'users', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    let raw;
    try { raw = await store.get('user:' + email); } catch(e) { raw = null; }
    if (!raw) return { statusCode: 404, body: JSON.stringify({ error: '사용자를 찾을 수 없습니다.' }) };

    const user = JSON.parse(raw);
    const now = new Date();
    const thisMonth = now.getFullYear() + '-' + (now.getMonth() + 1);
    const postCount = user.postCountMonth === thisMonth ? (user.postCount || 0) : 0;
    const limits = { trial: 3, standard: 16, pro: 20 };
    const plan = user.plan || 'trial';
    const limit = limits[plan] || 3;
    const createdAt = new Date(user.createdAt);
    const diffDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
    const trialExpired = plan === 'trial' && diffDays >= 7;
    const canPost = !trialExpired && postCount < limit;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan, postCount, limit, remaining: Math.max(0, limit - postCount),
        canPost, trialExpired, autoRenew: user.autoRenew !== false,
        trialDaysLeft: plan === 'trial' ? Math.max(0, 7 - diffDays) : null,
        user: { name: user.name, storeName: user.storeName, instagram: user.instagram, bizCategory: user.bizCategory, captionTone: user.captionTone, tagStyle: user.tagStyle, storeDesc: user.storeDesc, region: user.region }
      })
    };
  } catch (err) {
    console.error('check-plan error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: '플랜 확인 중 오류가 발생했습니다.' }) };
  }
};
