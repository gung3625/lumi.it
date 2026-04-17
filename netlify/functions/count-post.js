const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

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
    // strong 제거 — PAT 동시 호출 경합 완화 (CDN 캐시 경유)
    const store = getStore({ name: 'users', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });

    // 토큰 Blobs 검증 (5회 지수 백오프 — PAT rate-limit 대응)
    let tokenRaw = null;
    let tokenBlobError = false;
    const RETRY_DELAYS = [200, 400, 800, 1600, 3200];
    for (let i = 0; i < RETRY_DELAYS.length; i++) {
      tokenBlobError = false;
      try { tokenRaw = await store.get('token:' + bearerToken); }
      catch(e) { tokenBlobError = true; console.error('[count-post] token blob fetch error (attempt ' + (i+1) + '):', e.message); }
      if (tokenRaw) break;
      if (!tokenBlobError) break;
      if (i < RETRY_DELAYS.length - 1) await new Promise(r => setTimeout(r, RETRY_DELAYS[i]));
    }
    if (!tokenRaw) {
      if (tokenBlobError) {
        console.warn('[count-post] token blob error after 5 retries, bearer prefix:', bearerToken.substring(0, 8));
        return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: '일시적 서버 오류입니다. 잠시 후 다시 시도해주세요.' }) };
      }
      console.warn('[count-post] token not found, bearer prefix:', bearerToken.substring(0, 8));
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
    }
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
    const limits = { trial: 3, basic: 8, standard: 12, pro: 20 };
    const limit = limits[plan] || 3;

    // 트라이얼 만료 체크
    const createdAt = user.createdAt ? new Date(user.createdAt) : now;
    const diffDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
    const trialExpired = plan === 'trial' && !isNaN(diffDays) && diffDays >= 7;
    if (!isAdmin && trialExpired) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '무료 체험 기간이 종료됐어요.', code: 'TRIAL_EXPIRED' }) };
    }

    // 플랜 만료 체크 (standard + pro 모두)
    const planExpireAt = user.planExpireAt ? new Date(user.planExpireAt) : null;
    const planExpired = (plan === 'standard' || plan === 'pro') && planExpireAt && planExpireAt < now;
    if (!isAdmin && planExpired) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '구독이 만료됐어요.', code: 'PLAN_EXPIRED' }) };
    }

    // user.postCount를 신뢰 (select-and-post-background가 IG 성공 시점에 증가, 실패 시 롤백)
    // 월이 바뀌었으면 자동 리셋
    let postCount = 0;
    if (user.postCountMonth === thisMonth) {
      postCount = user.postCount || 0;
    } else {
      user.postCountMonth = thisMonth;
      user.postCount = 0;
      try { await store.set('user:' + email, JSON.stringify(user)); } catch(_) {}
    }

    // 게시 횟수 한도 체크
    if (!isAdmin && postCount >= limit) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '이번 달 게시 한도에 도달했어요.', code: 'POST_LIMIT_REACHED', limit, postCount }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        counted: false,
        postCount,
        limit,
        remaining: isAdmin ? 999999 : Math.max(0, limit - postCount),
      })
    };
  } catch (err) {
    console.error('count-post error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '카운팅 처리 중 오류가 발생했습니다.' }) };
  }
};
