// 카카오 OAuth 콜백 — Node Function (GCP self-host용)
// GET /api/auth/kakao/callback?code=...&state=...  (server.js 가 슬래시 경로를 명시적으로 라우팅)
//
// 기존 Netlify Edge Function(netlify/edge-functions/auth-kakao-callback.js, Deno)을
// GCP server.js 가 마운트할 수 있는 Node 형식으로 포팅. JWT/refresh 는 _shared/seller-jwt
// 재사용 → me.js 검증과 100% 호환.
//
// 흐름:
//   1) state nonce 형식 검증
//   2) [병렬] nonce DELETE returning + 카카오 token 교환
//   3) nonce 검증(없거나 10분 초과 거절) + token 검증
//   4) 카카오 사용자 정보 조회
//   5) sellers OR 조회 → INSERT or UPDATE
//   6) seller-jwt 서명 + refresh token 발급
//   7) 302 redirect (#kakao=callback&lumi_token=...&lumi_refresh=...&onboarded=1?)
//
// 환경변수: KAKAO_CLIENT_ID(또는 KAKAO_REST_API_KEY), KAKAO_CLIENT_SECRET,
//          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET(32자+)
const { getAdminClient } = require('./_shared/supabase-admin');
const { signSellerToken, generateRefreshToken } = require('./_shared/seller-jwt');

const REDIRECT_URI = 'https://lumi.it.kr/api/auth/kakao/callback';
const KAKAO_TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const KAKAO_USER_URL = 'https://kapi.kakao.com/v2/user/me';

function redirect(location, extraHeaders = {}) {
  return {
    statusCode: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', ...extraHeaders },
    body: '',
  };
}

function errorRedirect(code) {
  return redirect(`/signup?kakao_error=${encodeURIComponent(code)}`);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }

  const KAKAO_REST_API_KEY = process.env.KAKAO_CLIENT_ID || process.env.KAKAO_REST_API_KEY;
  const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET;

  const q = event.queryStringParameters || {};
  const code = q.code;
  const state = q.state;
  const errParam = q.error;
  const errorDescription = q.error_description;

  if (errParam) {
    console.log('[auth-kakao-callback] 카카오 거부:', errParam, errorDescription || '');
    return errorRedirect(errParam);
  }
  if (!code) return errorRedirect('missing_code');

  if (!KAKAO_REST_API_KEY || !KAKAO_CLIENT_SECRET) {
    console.error('[auth-kakao-callback] KAKAO 환경변수 미설정');
    return errorRedirect('server_configuration_error');
  }

  // 1) state 형식 검증
  if (!state || !/^[a-f0-9]{32}$/i.test(state)) {
    console.error('[auth-kakao-callback] state 형식 오류 또는 누락');
    return errorRedirect('invalid_state');
  }
  const nonceKey = 'kakao_signup:' + state;

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[auth-kakao-callback] Supabase admin 초기화 실패:', e && e.message);
    return errorRedirect('server_error');
  }

  // 2) [병렬] nonce DELETE...returning + 카카오 token 교환
  const noncePromise = admin
    .from('oauth_nonces')
    .delete()
    .eq('nonce', nonceKey)
    .select('nonce,created_at');

  const tokenPromise = fetch(KAKAO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KAKAO_REST_API_KEY,
      client_secret: KAKAO_CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const [nonceSettled, tokenSettled] = await Promise.allSettled([noncePromise, tokenPromise]);

  // 3) nonce 결과 처리
  if (nonceSettled.status !== 'fulfilled') {
    console.error('[auth-kakao-callback] nonce 조회 예외:', nonceSettled.reason && nonceSettled.reason.message);
    return errorRedirect('server_error');
  }
  const { data: nonceRows, error: nonceErr } = nonceSettled.value;
  if (nonceErr) {
    console.error('[auth-kakao-callback] nonce DELETE 오류:', nonceErr.message);
    return errorRedirect('server_error');
  }
  if (!Array.isArray(nonceRows) || nonceRows.length === 0) {
    console.error('[auth-kakao-callback] nonce not found:', nonceKey);
    return errorRedirect('invalid_state');
  }
  const expiry = new Date(nonceRows[0].created_at).getTime() + 10 * 60 * 1000;
  if (Date.now() > expiry) {
    console.error('[auth-kakao-callback] nonce 만료');
    return errorRedirect('state_expired');
  }

  // 4) token 결과 처리
  if (tokenSettled.status !== 'fulfilled') {
    console.error('[auth-kakao-callback] 토큰 교환 예외:', tokenSettled.reason && tokenSettled.reason.message);
    return errorRedirect('token_exchange_failed');
  }
  const tokenRes = tokenSettled.value;
  if (!tokenRes.ok) {
    const txt = await tokenRes.text().catch(() => '');
    console.error('[auth-kakao-callback] 토큰 교환 HTTP 오류:', tokenRes.status, txt);
    return errorRedirect('token_exchange_failed');
  }
  let tokenData;
  try {
    tokenData = await tokenRes.json();
  } catch (_) {
    tokenData = null;
  }
  if (!tokenData || tokenData.error) {
    console.error('[auth-kakao-callback] 토큰 교환 오류:', tokenData && tokenData.error);
    return errorRedirect('token_exchange_failed');
  }
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    console.error('[auth-kakao-callback] access_token 누락');
    return errorRedirect('no_access_token');
  }

  // 5) 카카오 사용자 정보 조회
  let userData;
  try {
    const userRes = await fetch(KAKAO_USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) {
      const txt = await userRes.text().catch(() => '');
      console.error('[auth-kakao-callback] 사용자 정보 조회 실패:', userRes.status, txt);
      return errorRedirect('user_info_failed');
    }
    userData = await userRes.json();
  } catch (e) {
    console.error('[auth-kakao-callback] 사용자 정보 조회 예외:', e && e.message);
    return errorRedirect('user_info_failed');
  }

  const kakaoId = String(userData.id || '');
  const kakaoAccount = userData.kakao_account || {};
  const email = kakaoAccount.email || null;
  const realName = kakaoAccount.name || null;
  const ageRange = kakaoAccount.age_range || null;

  let phone = null;
  const rawPhone = kakaoAccount.phone_number || '';
  if (rawPhone) {
    const digits = rawPhone.replace(/[\s\-]/g, '').replace(/^\+82/, '0');
    if (/^010\d{7,8}$/.test(digits)) phone = digits;
  }

  if (!kakaoId) {
    console.error('[auth-kakao-callback] kakao_id 누락');
    return errorRedirect('user_info_failed');
  }

  // 6) sellers OR 조회 — kakao_id OR email 단일 호출
  let existingSeller = null;
  try {
    let query = admin.from('sellers').select('id,onboarded,email');
    if (email) query = query.or(`kakao_id.eq.${kakaoId},email.eq.${email}`);
    else query = query.eq('kakao_id', kakaoId);
    const { data: arr, error: selErr } = await query.limit(1);
    if (selErr) {
      console.error('[auth-kakao-callback] sellers 조회 실패:', selErr.message);
      return errorRedirect('server_error');
    }
    if (Array.isArray(arr) && arr.length > 0) existingSeller = arr[0];
  } catch (e) {
    console.error('[auth-kakao-callback] sellers 조회 예외:', e && e.message);
    return errorRedirect('server_error');
  }

  // 7) INSERT or UPDATE
  const nowIso = new Date().toISOString();
  let sellerId;
  let onboarded = false;

  if (existingSeller) {
    sellerId = existingSeller.id;
    onboarded = Boolean(existingSeller.onboarded);
    const updatePayload = {
      kakao_id: kakaoId,
      display_name: realName,
      signup_method: 'kakao',
      updated_at: nowIso,
    };
    if (phone) updatePayload.phone = phone;
    if (ageRange) updatePayload.age_range = ageRange;
    const { error: updErr } = await admin.from('sellers').update(updatePayload).eq('id', sellerId);
    if (updErr) console.warn('[auth-kakao-callback] sellers UPDATE 실패(무시):', updErr.message);
  } else {
    const insertPayload = {
      kakao_id: kakaoId,
      email,
      display_name: realName,
      signup_method: 'kakao',
      onboarded: false,
      created_at: nowIso,
      updated_at: nowIso,
    };
    if (phone) insertPayload.phone = phone;
    if (ageRange) insertPayload.age_range = ageRange;
    const { data: inserted, error: insErr } = await admin
      .from('sellers')
      .insert(insertPayload)
      .select('id,onboarded')
      .single();
    if (insErr || !inserted || !inserted.id) {
      console.error('[auth-kakao-callback] sellers INSERT 실패:', insErr && insErr.message);
      return errorRedirect('account_save_failed');
    }
    sellerId = inserted.id;
    onboarded = Boolean(inserted.onboarded);
  }

  // 8) seller-jwt 서명 (me.js 와 동일 _shared 헬퍼)
  let sellerJwt;
  try {
    sellerJwt = signSellerToken({ seller_id: sellerId });
  } catch (e) {
    console.error('[auth-kakao-callback] JWT 발급 실패:', e && e.message);
    return errorRedirect('jwt_error');
  }

  const cookieVal =
    `lumi_session=${sellerJwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 14}`;

  // 8.5) refresh token 발급 — 30일, sha256 hash 만 DB 저장(평문은 클라이언트에 1회 전달)
  let refreshPlain = '';
  try {
    const { plain, hash, expiresAt } = generateRefreshToken();
    const userAgent = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || null;
    const ipAddress = (event.headers && (event.headers['x-forwarded-for'] || '').split(',')[0].trim()) || null;
    const { error: rtErr } = await admin.from('seller_refresh_tokens').insert({
      seller_id: sellerId,
      token_hash: hash,
      expires_at: expiresAt.toISOString(),
      user_agent: userAgent,
      ip_address: ipAddress,
    });
    if (rtErr) {
      console.error('[auth-kakao-callback] refresh token 저장 실패:', rtErr.message);
      refreshPlain = '';
    } else {
      refreshPlain = plain;
    }
  } catch (e) {
    console.error('[auth-kakao-callback] refresh token 생성 실패:', e && e.message);
    refreshPlain = '';
  }

  console.log('[auth-kakao-callback] 카카오 로그인 완료(node). seller_id:', sellerId, 'onboarded:', onboarded);

  // 9) hash 에 onboarded flag + lumi_refresh 추가
  let frag = `#kakao=callback&lumi_token=${encodeURIComponent(sellerJwt)}`;
  if (refreshPlain) frag += `&lumi_refresh=${encodeURIComponent(refreshPlain)}`;
  if (onboarded) frag += '&onboarded=1';
  // 상세페이지가 lumi 메인 — 로그인 후 상세페이지 작업실(/studio)로. (인스타 대시보드는 /dashboard 직접 접근)
  const destination = `/studio${frag}`;

  return redirect(destination, { 'Set-Cookie': cookieVal });
};
