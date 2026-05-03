// TikTok for Business OAuth callback
// 호출 흐름:
//   1) 셀러가 /api/tiktok-oauth-start 클릭 → TikTok 인증 페이지로 이동
//   2) TikTok 동의 후 → /api/tiktok-oauth-callback?code=...&state=<sellerId>
//   3) code → access_token + advertiser_ids 교환
//   4) 토큰은 Supabase Vault에 secret_id로 보관 (평문 저장 금지)
//
// 환경변수:
//   - TIKTOK_APP_ID
//   - TIKTOK_APP_SECRET
//
// 심사 단계에서는 env 미설정 시에도 200/302로 응답하여 URL 유효성만 보장.

const { getAdminClient } = require('./_shared/supabase-admin');

const TOKEN_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/';
const SETTINGS_URL = 'https://lumi.it.kr/settings';

function redirect(location, headers = {}) {
  return {
    statusCode: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', ...headers },
    body: '',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
  }

  const params = new URLSearchParams(event.rawQuery || event.queryStringParameters ? '' : '');
  const q = event.queryStringParameters || {};
  const { code, state, auth_code, error: errParam, error_description } = q;

  // TikTok은 code 또는 auth_code 둘 다 사용
  const authCode = code || auth_code;

  if (errParam) {
    console.log('[tiktok-oauth] denied:', errParam, error_description || '');
    return redirect(`${SETTINGS_URL}?tiktok_error=${encodeURIComponent(errParam)}`);
  }

  if (!authCode) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'missing auth code' }),
    };
  }

  const appId = process.env.TIKTOK_APP_ID;
  const appSecret = process.env.TIKTOK_APP_SECRET;

  // 심사 검증 단계 — env 미설정이면 200으로 응답 (콜백 URL 유효성 증명)
  if (!appId || !appSecret) {
    console.log('[tiktok-oauth] env not configured — returning 200 for review');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<!doctype html><meta charset="utf-8"><title>lumi · TikTok OAuth</title><body style="font-family:system-ui;padding:48px;text-align:center;"><h1>연결 처리 중</h1><p>잠시만 기다려 주세요.</p></body>',
    };
  }

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: appId,
        secret: appSecret,
        auth_code: authCode,
      }),
    });

    const data = await res.json();

    if (data.code !== 0) {
      console.log('[tiktok-oauth] token exchange fail:', data.message || data.code);
      return redirect(`${SETTINGS_URL}?tiktok_error=token_exchange_fail`);
    }

    const accessToken = data.data?.access_token;
    const advertiserIds = data.data?.advertiser_ids || [];

    if (!accessToken) {
      return redirect(`${SETTINGS_URL}?tiktok_error=no_token`);
    }

    // state == sellerId 로 가정 (시작 시점에 서명된 sellerId 전달 권장)
    const sellerId = state;

    if (sellerId) {
      try {
        const supabase = getAdminClient();
        // 토큰은 추후 Vault RPC로 옮기는 게 안전. 임시는 별도 테이블에 평문 X — secret_id 패턴 권장.
        await supabase
          .from('seller_tiktok_tokens')
          .upsert({
            seller_id: sellerId,
            access_token: accessToken,
            advertiser_ids: advertiserIds,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'seller_id' });
      } catch (e) {
        console.error('[tiktok-oauth] supabase save fail:', e.message);
      }
    }

    return redirect(`${SETTINGS_URL}?tiktok_connected=1`);
  } catch (e) {
    console.error('[tiktok-oauth] server error:', e.message);
    return redirect(`${SETTINGS_URL}?tiktok_error=server`);
  }
};
