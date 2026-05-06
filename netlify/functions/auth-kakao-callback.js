// 카카오 OAuth 콜백 핸들러
// GET /api/auth/kakao/callback?code=...&state=...
//
// 흐름:
//   1) state nonce 검증 (oauth_nonces, 'kakao_signup:' prefix, 10분 TTL, 일회용)
//   2) code → access_token 교환 (kauth.kakao.com/oauth/token)
//   3) 사용자 정보 조회 (kapi.kakao.com/v2/user/me)
//   4) sellers UPSERT (kakao_id 또는 email 기준)
//   5) seller-jwt 발급 (HS256, JWT_SECRET)
//   6) lumi_session 쿠키로 JWT 전달
//   7) onboarded 상태에 따라 redirect
//
// 환경변수:
//   - KAKAO_REST_API_KEY
//   - KAKAO_CLIENT_SECRET
//   - JWT_SECRET (seller-jwt.js와 공유)

const { getAdminClient } = require('./_shared/supabase-admin');
const { signSellerToken } = require('./_shared/seller-jwt');

const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET;
const REDIRECT_URI = 'https://lumi.it.kr/api/auth/kakao/callback';
const KAKAO_TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const KAKAO_USER_URL = 'https://kapi.kakao.com/v2/user/me';

function redirect(location) {
  return {
    statusCode: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
    body: '',
  };
}

function errorRedirect(code) {
  return redirect(`/signup?kakao_error=${encodeURIComponent(code)}`);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
  }

  const q = event.queryStringParameters || {};
  const { code, state, error: errParam, error_description } = q;

  // 카카오가 오류를 반환한 경우
  if (errParam) {
    console.log('[auth-kakao-callback] 카카오 거부:', errParam, error_description || '');
    return errorRedirect(errParam);
  }

  if (!code) {
    return errorRedirect('missing_code');
  }

  if (!KAKAO_REST_API_KEY || !KAKAO_CLIENT_SECRET) {
    console.error('[auth-kakao-callback] KAKAO_REST_API_KEY / KAKAO_CLIENT_SECRET 미설정');
    return errorRedirect('server_configuration_error');
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[auth-kakao-callback] admin 초기화 실패:', e.message);
    return errorRedirect('server_error');
  }

  // ──────────────────────────────────────────────
  // 1) state nonce 검증 (일회용 + TTL 10분)
  // ──────────────────────────────────────────────
  if (!state || !/^[a-f0-9]{32}$/i.test(state)) {
    console.error('[auth-kakao-callback] state 형식 오류 또는 누락');
    return errorRedirect('invalid_state');
  }

  const nonceKey = 'kakao_signup:' + state;

  try {
    const { data: nonceRow } = await admin
      .from('oauth_nonces')
      .select('nonce, created_at, expires_at')
      .eq('nonce', nonceKey)
      .maybeSingle();

    if (!nonceRow) {
      console.error('[auth-kakao-callback] nonce not found:', nonceKey);
      return errorRedirect('invalid_state');
    }

    // 일회용: 즉시 삭제
    await admin.from('oauth_nonces').delete().eq('nonce', nonceKey);

    // TTL 검사 (expires_at 컬럼 또는 created_at + 10분 fallback)
    const expiry = nonceRow.expires_at
      ? new Date(nonceRow.expires_at).getTime()
      : new Date(nonceRow.created_at).getTime() + 10 * 60 * 1000;

    if (Date.now() > expiry) {
      console.error('[auth-kakao-callback] nonce 만료');
      return errorRedirect('state_expired');
    }
  } catch (e) {
    console.error('[auth-kakao-callback] nonce 조회 예외:', e.message);
    return errorRedirect('server_error');
  }

  try {
    // ──────────────────────────────────────────────
    // 2) code → access_token 교환
    // ──────────────────────────────────────────────
    const tokenRes = await fetch(KAKAO_TOKEN_URL, {
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

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => '');
      console.error('[auth-kakao-callback] 토큰 교환 HTTP 오류:', tokenRes.status, body);
      return errorRedirect('token_exchange_failed');
    }

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error('[auth-kakao-callback] 토큰 교환 오류:', tokenData.error, tokenData.error_description || '');
      return errorRedirect('token_exchange_failed');
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) {
      console.error('[auth-kakao-callback] access_token 누락');
      return errorRedirect('no_access_token');
    }

    // ──────────────────────────────────────────────
    // 3) 사용자 정보 조회
    // ──────────────────────────────────────────────
    const userRes = await fetch(KAKAO_USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userRes.ok) {
      const body = await userRes.text().catch(() => '');
      console.error('[auth-kakao-callback] 사용자 정보 조회 실패:', userRes.status, body);
      return errorRedirect('user_info_failed');
    }

    const userData = await userRes.json();

    // 카카오 응답 구조:
    // { id, kakao_account: { email, phone_number, profile: { nickname, profile_image_url } } }
    const kakaoId = String(userData.id || '');
    const kakaoAccount = userData.kakao_account || {};
    const kakaoProfile = kakaoAccount.profile || {};
    const email = kakaoAccount.email || null;
    const displayName = kakaoProfile.nickname || null;
    const avatarUrl = kakaoProfile.profile_image_url || null;

    // 카카오 phone_number 형식: "+82 10-1234-5678" → Solapi 형식 "01012345678"
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

    // ──────────────────────────────────────────────
    // 4) sellers UPSERT (kakao_id 기준, email fallback)
    // ──────────────────────────────────────────────
    const nowIso = new Date().toISOString();

    // kakao_id로 기존 행 확인
    let { data: existingSeller } = await admin
      .from('sellers')
      .select('id, onboarded, email')
      .eq('kakao_id', kakaoId)
      .maybeSingle();

    // kakao_id 없으면 email로 재확인
    if (!existingSeller && email) {
      const { data: byEmail } = await admin
        .from('sellers')
        .select('id, onboarded, email')
        .eq('email', email)
        .maybeSingle();
      existingSeller = byEmail || null;
    }

    let sellerId;
    let onboarded = false;

    if (existingSeller) {
      // UPDATE: kakao_id + 프로필 동기화
      sellerId = existingSeller.id;
      onboarded = Boolean(existingSeller.onboarded);

      const updatePayload = {
        kakao_id: kakaoId,
        display_name: displayName,
        avatar_url: avatarUrl,
        signup_method: 'kakao',
        updated_at: nowIso,
      };
      if (phone) updatePayload.phone = phone;

      const { error: updErr } = await admin
        .from('sellers')
        .update(updatePayload)
        .eq('id', sellerId);

      if (updErr) {
        console.warn('[auth-kakao-callback] sellers UPDATE 실패 (무시하고 진행):', updErr.message);
      }
    } else {
      // INSERT: 신규 카카오 가입
      const insertPayload = {
        kakao_id: kakaoId,
        email,
        display_name: displayName,
        avatar_url: avatarUrl,
        signup_method: 'kakao',
        onboarded: false,
        created_at: nowIso,
        updated_at: nowIso,
      };
      if (phone) insertPayload.phone = phone;

      const { data: inserted, error: insErr } = await admin
        .from('sellers')
        .insert(insertPayload)
        .select('id, onboarded')
        .single();

      if (insErr || !inserted) {
        console.error('[auth-kakao-callback] sellers INSERT 실패:', insErr && insErr.message);
        return errorRedirect('account_save_failed');
      }

      sellerId = inserted.id;
      onboarded = false;
    }

    // ──────────────────────────────────────────────
    // 5) seller-jwt 발급 (HS256, JWT_SECRET)
    // ──────────────────────────────────────────────
    let sellerJwt;
    try {
      sellerJwt = signSellerToken({ seller_id: sellerId });
    } catch (e) {
      console.error('[auth-kakao-callback] JWT 발급 실패:', e.message);
      return errorRedirect('jwt_error');
    }

    // ──────────────────────────────────────────────
    // 6) HttpOnly Secure 쿠키로 JWT 전달
    // ──────────────────────────────────────────────
    const cookieVal =
      `lumi_session=${sellerJwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 14}`;

    console.log('[auth-kakao-callback] 카카오 로그인 완료. seller_id:', sellerId, 'onboarded:', onboarded);

    // ──────────────────────────────────────────────
    // 7) onboarded 상태에 따라 redirect
    // ──────────────────────────────────────────────
    const destination = onboarded ? '/dashboard' : '/signup';

    return {
      statusCode: 302,
      headers: {
        Location: destination,
        'Set-Cookie': cookieVal,
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  } catch (e) {
    console.error('[auth-kakao-callback] 예외:', e.message);
    return errorRedirect('server_error');
  }
};
