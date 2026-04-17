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

    // 토큰 Blobs 검증 — 3회 재시도 (동시 호출 시 Blobs 401 throw → 프론트 자동 로그아웃 방지)
    let tokenRaw = null;
    let tokenBlobError = false;
    for (let i = 0; i < 3; i++) {
      tokenBlobError = false;
      try { tokenRaw = await store.get('token:' + bearerToken); }
      catch(e) { tokenBlobError = true; console.error('[check-plan] token blob fetch error:', e.message); }
      if (tokenRaw) break;
      if (!tokenBlobError) break;
      if (i < 2) await new Promise(r => setTimeout(r, 300));
    }
    if (!tokenRaw) {
      if (tokenBlobError) return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: '일시적 서버 오류입니다. 잠시 후 다시 시도해주세요.' }) };
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
    }
    const tokenData = JSON.parse(tokenRaw);
    if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '세션이 만료됐습니다. 다시 로그인해주세요.' }) };
    }
    const email = tokenData.email;
    let raw = null;
    let userBlobError = false;
    for (let i = 0; i < 3; i++) {
      userBlobError = false;
      try { raw = await store.get('user:' + email); }
      catch(e) { userBlobError = true; console.error('[check-plan] user blob fetch error:', e.message); }
      if (raw) break;
      if (!userBlobError) break;
      if (i < 2) await new Promise(r => setTimeout(r, 300));
    }
    if (!raw) {
      if (userBlobError) return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: '일시적 서버 오류입니다. 잠시 후 다시 시도해주세요.' }) };
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '사용자를 찾을 수 없습니다.' }) };
    }

    const user = JSON.parse(raw);
    const now = new Date();
    const thisMonth = now.getFullYear() + '-' + (now.getMonth() + 1);

    // 권위적 카운트: reservations를 스캔해서 이번 달 실제 성공 게시만 카운트
    // (count-post 사전 증가가 실패건까지 부풀린 이슈를 해결)
    let authoritativeCount = 0;
    try {
      const reserveStore = getStore({ name: 'reservations', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
      const { blobs } = await reserveStore.list({ prefix: 'reserve:' });
      const records = await Promise.all((blobs || []).map(b => reserveStore.get(b.key).catch(() => null)));
      for (const r of records) {
        if (!r) continue;
        try {
          const it = JSON.parse(r);
          const ownerEmail = (it.storeProfile && (it.storeProfile.ownerEmail || it.storeProfile.email)) || it.ownerEmail || null;
          if (ownerEmail !== email) continue;
          if (!it.isSent) continue;
          const sentAt = it.sentAt ? new Date(it.sentAt) : null;
          if (!sentAt || isNaN(sentAt.getTime())) continue;
          const recMonth = sentAt.getFullYear() + '-' + (sentAt.getMonth() + 1);
          if (recMonth === thisMonth) authoritativeCount++;
        } catch(_) {}
      }
      // user store도 동기화 (한도 체크가 authoritative와 일치하도록)
      if (user.postCountMonth !== thisMonth || (user.postCount || 0) !== authoritativeCount) {
        user.postCountMonth = thisMonth;
        user.postCount = authoritativeCount;
        try { await store.set('user:' + email, JSON.stringify(user)); } catch(_) {}
      }
    } catch (e) {
      console.error('[check-plan] 권위적 카운트 실패, user.postCount 사용:', e.message);
      authoritativeCount = user.postCountMonth === thisMonth ? (user.postCount || 0) : 0;
    }
    const postCount = authoritativeCount;
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
