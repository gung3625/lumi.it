// 카카오 OAuth 시작 — Node Function (GCP self-host용)
// GET /api/auth/kakao/start  (server.js 가 슬래시 경로를 명시적으로 라우팅)
//
// 기존 Netlify Edge Function(netlify/edge-functions/auth-kakao-start.js, Deno)을
// GCP server.js 가 마운트할 수 있는 Node 형식으로 포팅. 검증된 _shared 헬퍼 재사용.
//
// 흐름:
//   1) crypto.randomBytes(16) → 32-char hex nonce
//   2) Supabase oauth_nonces INSERT (nonce='kakao_signup:'+hex)
//   3) 카카오 OAuth 인증 URL로 302 redirect
//
// 환경변수: KAKAO_CLIENT_ID(또는 KAKAO_REST_API_KEY), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');

const REDIRECT_URI = 'https://lumi.it.kr/api/auth/kakao/callback';
// 비즈 앱 검수 통과 — 닉네임·프로필 사진 제외, 실명·연령대 추가
const SCOPE = 'account_email,name,age_range,phone_number';

function jsonError(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: message }),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }

  const KAKAO_REST_API_KEY = process.env.KAKAO_CLIENT_ID || process.env.KAKAO_REST_API_KEY;
  if (!KAKAO_REST_API_KEY) {
    console.error('[auth-kakao-start] KAKAO_CLIENT_ID 환경변수 미설정');
    return jsonError(500, 'server_configuration_error');
  }

  // nonce 생성 (16바이트 → 32-char hex)
  const nonce = crypto.randomBytes(16).toString('hex');
  const nonceKey = 'kakao_signup:' + nonce;

  try {
    const admin = getAdminClient();
    const { error } = await admin
      .from('oauth_nonces')
      .insert({ nonce: nonceKey, created_at: new Date().toISOString() });
    if (error) {
      console.error('[auth-kakao-start] nonce 저장 실패:', error.message);
      return jsonError(500, 'server_error');
    }
  } catch (e) {
    console.error('[auth-kakao-start] nonce 저장 예외:', e && e.message);
    return jsonError(500, 'server_error');
  }

  // 카카오 OAuth 인증 URL
  const authUrl =
    `https://kauth.kakao.com/oauth/authorize?` +
    `client_id=${encodeURIComponent(KAKAO_REST_API_KEY)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&state=${encodeURIComponent(nonce)}`;

  console.log('[auth-kakao-start] 카카오 OAuth 시작 (node)');
  return {
    statusCode: 302,
    headers: { Location: authUrl, 'Cache-Control': 'no-store' },
    body: '',
  };
};
