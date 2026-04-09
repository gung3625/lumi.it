const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': 'https://lumi.it.kr', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

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

    // 토큰 Blobs 검증
    let tokenRaw;
    try { tokenRaw = await store.get('token:' + bearerToken); } catch { tokenRaw = null; }
    if (!tokenRaw) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
    const tokenData = JSON.parse(tokenRaw);
    if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '세션이 만료됐습니다.' }) };
    }
    const email = tokenData.email;
    let raw;
    try { raw = await store.get('user:' + email); } catch(e) { raw = null; }
    if (!raw) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '사용자를 찾을 수 없습니다.' }) };

    const user = JSON.parse(raw);
    const now = new Date();
    const thisMonth = now.getFullYear() + '-' + (now.getMonth() + 1);

    // 플랜 체크
    const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
    const isAdmin = email === ADMIN_EMAIL;
    const plan = isAdmin ? 'pro' : (user.plan || 'trial');
    const limits = { trial: 3, basic: 8, standard: 16, pro: 20 };
    const limit = limits[plan] || 3;

    // 트라이얼 만료 체크
    const createdAt = new Date(user.createdAt);
    const diffDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
    const trialExpired = plan === 'trial' && diffDays >= 7;
    if (!isAdmin && trialExpired) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '무료 체험 기간이 종료됐어요.', code: 'TRIAL_EXPIRED' }) };
    }

    // 플랜 만료 체크
    const planExpireAt = user.planExpireAt ? new Date(user.planExpireAt) : null;
    const standardExpired = plan === 'standard' && planExpireAt && planExpireAt < now;
    if (!isAdmin && standardExpired) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '구독이 만료됐어요.', code: 'PLAN_EXPIRED' }) };
    }

    // 게시 횟수 체크 및 카운팅
    if (user.postCountMonth !== thisMonth) { user.postCountMonth = thisMonth; user.postCount = 0; }
    const postCount = user.postCount || 0;
    if (!isAdmin && postCount >= limit) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '이번 달 게시 한도에 도달했어요.', code: 'POST_LIMIT_REACHED', limit, postCount }) };
    }

    // 카운팅
    user.postCount = postCount + 1;
    user.lastPostedAt = now.toISOString();
    await store.set('user:' + email, JSON.stringify(user));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        counted: true,
        postCount: user.postCount,
        limit,
        remaining: isAdmin ? 999999 : Math.max(0, limit - user.postCount),
      })
    };
  } catch (err) {
    console.error('count-post error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '카운팅 처리 중 오류가 발생했습니다.' }) };
  }
};
