const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 인증: Bearer 토큰 검증
  const authHeader = event.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!bearerToken) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const store = getStore({ name: 'users', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });

    // 토큰 Blobs 검증 — email을 토큰에서 가져옴 (body 무시)
    let tokenRaw;
    try { tokenRaw = await store.get('token:' + bearerToken); } catch { tokenRaw = null; }
    if (!tokenRaw) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
    const tokenData = JSON.parse(tokenRaw);
    if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '세션이 만료됐습니다. 다시 로그인해주세요.' }) };
    }
    const email = tokenData.email;
    let raw;
    try { raw = await store.get('user:' + email); } catch(e) { raw = null; }
    if (!raw) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '사용자를 찾을 수 없습니다.' }) };

    const user = JSON.parse(raw);
    const now = new Date();
    const thisMonth = now.getFullYear() + '-' + (now.getMonth() + 1);
    const postCount = user.postCountMonth === thisMonth ? (user.postCount || 0) : 0;
    const limits = { trial: 3, basic: 8, standard: 16, pro: 20 };
    // 대표님 계정 - 프로 플랜 전체 기능 사용
    const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
    const isAdmin = email === ADMIN_EMAIL;
    const plan = isAdmin ? 'pro' : (user.plan || 'trial');
    const limit = limits[plan] || 3;
    const createdAt = new Date(user.createdAt);
    const diffDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
    const trialExpired = plan === 'trial' && diffDays >= 7;
    const planExpireAt = user.planExpireAt ? new Date(user.planExpireAt) : null;
    const standardExpired = plan === 'standard' && planExpireAt && planExpireAt < now;
    const canPost = isAdmin || (!trialExpired && !standardExpired && postCount < limit);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        plan, postCount, limit, remaining: isAdmin ? 999999 : Math.max(0, limit - postCount),
        canPost, trialExpired, autoRenew: user.autoRenew !== false,
        billingCycle: user.billingCycle || 'monthly',
        planExpireAt: user.planExpireAt || null,
        daysUntilExpire: (plan === 'standard' && planExpireAt && planExpireAt > now) ? Math.ceil((planExpireAt - now) / (1000 * 60 * 60 * 24)) : null,
        planExpired: standardExpired || false,
        trialDaysLeft: plan === 'trial' ? Math.max(0, 7 - diffDays) : null,
        user: { name: user.name, storeName: user.storeName, instagram: user.instagram, bizCategory: user.bizCategory, captionTone: user.captionTone, tagStyle: user.tagStyle, storeDesc: user.storeDesc, region: user.region, autoStory: user.autoStory, autoFestival: user.autoFestival, sidoCode: user.sidoCode, sigunguCode: user.sigunguCode }
      })
    };
  } catch (err) {
    console.error('check-plan error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '플랜 확인 중 오류가 발생했습니다.' }) };
  }
};
