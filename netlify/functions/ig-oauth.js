const { getStore } = require('@netlify/blobs');

const APP_ID = process.env.META_APP_ID || '1233639725586126';
const APP_SECRET = process.env.META_APP_SECRET;
const REDIRECT_URI = 'https://lumi.it.kr/.netlify/functions/ig-oauth';
const SITE_ID = process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc';
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

exports.handler = async (event) => {
  const params = new URLSearchParams(event.rawQuery || '');
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  if (error) {
    console.error('[lumi] OAuth 에러:', error);
    return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=1' } };
  }

  // code 없으면 OAuth 시작
  if (!code) {
    const lumiToken = params.get('token') || '';
    const authUrl = `https://www.facebook.com/dialog/oauth?` +
      `client_id=${APP_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=instagram_basic,instagram_content_publish,instagram_manage_comments,instagram_manage_messages,pages_show_list,pages_read_engagement,pages_manage_metadata` +
      `&response_type=code` +
      `&state=${encodeURIComponent(lumiToken)}`;
    return { statusCode: 302, headers: { Location: authUrl } };
  }

  try {
    // 1. code → access token 교환
    const tokenRes = await fetch(
      `https://graph.facebook.com/v25.0/oauth/access_token?` +
      `client_id=${APP_ID}&client_secret=${APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${code}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('[lumi] 토큰 교환 실패:', JSON.stringify(tokenData));
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=2' } };
    }

    // 2. 장기 토큰으로 교환 (60일)
    const longTokenRes = await fetch(
      `https://graph.facebook.com/v25.0/oauth/access_token?` +
      `grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}` +
      `&fb_exchange_token=${tokenData.access_token}`
    );
    const longTokenData = await longTokenRes.json();
    const longToken = longTokenData.access_token || tokenData.access_token;

    // 3. Instagram User ID 조회
    const igRes = await fetch(`https://graph.facebook.com/v25.0/me/accounts?access_token=${longToken}`);
    const igData = await igRes.json();

    let igUserId = null;
    let pageAccessToken = null;

    for (const page of (igData.data || [])) {
      const igAccountRes = await fetch(
        `https://graph.facebook.com/v25.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
      );
      const igAccountData = await igAccountRes.json();
      if (igAccountData.instagram_business_account?.id) {
        igUserId = igAccountData.instagram_business_account.id;
        pageAccessToken = page.access_token;
        break;
      }
    }

    if (!igUserId) {
      console.error('[lumi] Instagram 비즈니스 계정 없음');
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=3' } };
    }

    // 4. lumi 사용자 이메일 조회
    let email = '';
    if (state) {
      try {
        const tokenStore = getStore({ name: 'users', siteID: SITE_ID, token: NETLIFY_TOKEN });
        const td = await tokenStore.get('token:' + state);
        if (td) email = JSON.parse(td).email || '';
      } catch(e) { console.error('[lumi] 이메일 조회 실패:', e.message); }
    }

    // 5. Blobs에 저장
    const store = getStore({ name: 'users', siteID: SITE_ID, token: NETLIFY_TOKEN });
    await store.set('ig:' + igUserId, JSON.stringify({
      igUserId, accessToken: longToken, pageAccessToken,
      email, connectedAt: new Date().toISOString()
    }));
    if (email) await store.set('email-ig:' + email, igUserId);

    console.log('[lumi] Instagram OAuth 연동 완료:', igUserId, email);
    return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_success=1' } };

  } catch(e) {
    console.error('[lumi] OAuth 처리 오류:', e.message);
    return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=99' } };
  }
};
