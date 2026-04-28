// 카카오 OAuth 시작 핸들러
// GET /api/auth/kakao/start?intent=login|signup
// 1) crypto.randomBytes(16) nonce 생성 → oauth_nonces 테이블 INSERT (nonce='kakao:'+hex)
// 2) state=<nonce>로 kauth.kakao.com authorize URL 생성 후 302
// callback (auth-kakao-callback.js)에서 state 매칭·일회용 삭제. CSRF 방어.
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');

const KAKAO_CLIENT_ID = process.env.KAKAO_CLIENT_ID || '161f7b8767d792c3fabde651653ac6b3';
const REDIRECT_URI = 'https://lumi.it.kr/api/auth/kakao/callback';
const SCOPE = 'account_email,phone_number';

function errorRedirect(message) {
  const encoded = encodeURIComponent(message);
  return {
    statusCode: 302,
    headers: { Location: `/?error=${encoded}` },
    body: '',
  };
}

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const intent = params.intent === 'signup' ? 'signup' : 'login';

    const nonce = crypto.randomBytes(16).toString('hex');

    let admin;
    try { admin = getAdminClient(); } catch (e) {
      console.error('[auth-kakao-start] admin init 실패:', e.message);
      return errorRedirect('카카오 로그인 준비 중 오류가 발생했어요.');
    }

    // oauth_nonces INSERT (callback에서 매칭 후 삭제)
    // intent는 lumi_token 컬럼에 JSON 문자열로 저장 (콜백이 signup 흐름 분기 가능)
    const { error: insErr } = await admin.from('oauth_nonces').insert({
      nonce: 'kakao:' + nonce,
      user_id: null,
      lumi_token: JSON.stringify({ intent }),
    });
    if (insErr) {
      console.error('[auth-kakao-start] nonce 저장 실패:', insErr.message);
      return errorRedirect('카카오 로그인 준비 중 오류가 발생했어요.');
    }

    const authUrl =
      `https://kauth.kakao.com/oauth/authorize?` +
      `client_id=${encodeURIComponent(KAKAO_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(SCOPE)}` +
      `&state=${encodeURIComponent(nonce)}`;

    return {
      statusCode: 302,
      headers: { Location: authUrl },
      body: '',
    };
  } catch (e) {
    console.error('[auth-kakao-start] 예외:', e.message);
    return errorRedirect('카카오 로그인 준비 중 오류가 발생했어요.');
  }
};
