// 카카오 OAuth 시작 핸들러
// GET /api/auth/kakao/start
// 1) crypto.randomBytes(16) nonce 생성
// 2) oauth_nonces 테이블에 INSERT (nonce='kakao_signup:'+hex, TTL 10분)
// 3) 카카오 OAuth 인증 URL로 302 리다이렉트
//
// 환경변수:
//   - KAKAO_REST_API_KEY

const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');

// Netlify env에는 KAKAO_CLIENT_ID로 등록됨 (REST API key 별칭). 둘 다 지원.
const KAKAO_REST_API_KEY = process.env.KAKAO_CLIENT_ID || process.env.KAKAO_REST_API_KEY;
const REDIRECT_URI = 'https://lumi.it.kr/api/auth/kakao/callback';
// 비즈 앱 검수 통과 — 닉네임·프로필 사진 제외, 실명·연령대 추가
const SCOPE = 'account_email,name,age_range,phone_number';

function redirect(location) {
  return {
    statusCode: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
    body: '',
  };
}

function jsonError(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: message }),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
  }

  if (!KAKAO_REST_API_KEY) {
    console.error('[auth-kakao-start] KAKAO_REST_API_KEY 환경변수 미설정');
    return jsonError(500, 'server_configuration_error');
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[auth-kakao-start] admin 초기화 실패:', e.message);
    return jsonError(500, 'server_error');
  }

  // nonce 생성 및 저장 (oauth_nonces TTL은 callback에서 created_at + 10분으로 검증)
  const nonce = crypto.randomBytes(16).toString('hex');
  const nonceKey = 'kakao_signup:' + nonce;

  const { error: insErr } = await admin.from('oauth_nonces').insert({
    nonce: nonceKey,
    created_at: new Date().toISOString(),
  });

  if (insErr) {
    console.error('[auth-kakao-start] nonce 저장 실패:', insErr.message);
    return jsonError(500, 'server_error');
  }

  // 카카오 OAuth 인증 URL 생성
  const authUrl =
    `https://kauth.kakao.com/oauth/authorize?` +
    `client_id=${encodeURIComponent(KAKAO_REST_API_KEY)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&state=${encodeURIComponent(nonce)}`;

  console.log('[auth-kakao-start] 카카오 OAuth 시작');
  return redirect(authUrl);
};
