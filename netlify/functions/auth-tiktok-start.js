// TikTok Login Kit / Content Posting OAuth 시작 핸들러
// GET /api/auth/tiktok/start
// 1) Authorization 헤더 또는 쿠키에서 Bearer 토큰으로 seller_id 확인
// 2) crypto.randomBytes(16) nonce 생성 → oauth_nonces 테이블 INSERT (nonce='tiktok_login:'+hex)
// 3) nonce 컬럼의 lumi_token 필드에 seller_id 저장 (콜백에서 복원)
// 4) TikTok OAuth 시작 URL로 302 리다이렉트
//
// 환경변수:
//   - TIKTOK_LOGIN_CLIENT_KEY   (Login Kit / Content Posting용 — Marketing API와 별개)
//
// Marketing API 콜백(tiktok-oauth-callback.js)과 환경변수 완전 분리.
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CLIENT_KEY = process.env.TIKTOK_LOGIN_CLIENT_KEY;
const REDIRECT_URI = 'https://lumi.it.kr/api/auth/tiktok/login/callback';
const SCOPES = 'video.publish,video.upload,user.info.basic';

function errorRedirect(msg) {
  return {
    statusCode: 302,
    headers: { Location: `/settings.html?tiktok_error=${encodeURIComponent(msg)}` },
    body: '',
  };
}

exports.handler = async (event) => {
  if (!CLIENT_KEY) {
    console.error('[auth-tiktok-start] TIKTOK_LOGIN_CLIENT_KEY 환경변수 미설정');
    return errorRedirect('tiktok_not_configured');
  }

  // Bearer 토큰 추출 (헤더 또는 쿼리 파라미터 token= 지원)
  let token = extractBearerToken(event);
  if (!token) {
    const q = event.queryStringParameters || {};
    token = q.token || '';
  }

  if (!token) {
    console.error('[auth-tiktok-start] 인증 토큰 없음');
    return { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  const { user, error: authError } = await verifyBearerToken(token);
  if (authError || !user) {
    console.error('[auth-tiktok-start] 토큰 검증 실패:', authError?.message);
    return { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'invalid_token' }) };
  }

  const sellerId = user.id;
  const nonce = crypto.randomBytes(16).toString('hex');

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[auth-tiktok-start] admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'server_error' }) };
  }

  const { error: insErr } = await admin.from('oauth_nonces').insert({
    nonce: 'tiktok_login:' + nonce,
    user_id: sellerId,
    lumi_token: JSON.stringify({ seller_id: sellerId }),
  });

  if (insErr) {
    console.error('[auth-tiktok-start] nonce 저장 실패:', insErr.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'nonce_insert_failed' }) };
  }

  const authUrl =
    `https://www.tiktok.com/v2/auth/authorize/?` +
    `client_key=${encodeURIComponent(CLIENT_KEY)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${encodeURIComponent(nonce)}`;

  console.log('[auth-tiktok-start] TikTok OAuth 시작. seller_id:', sellerId);
  return {
    statusCode: 302,
    headers: { Location: authUrl },
    body: '',
  };
};
