// 카카오 OAuth 콜백 — Netlify Edge Function (Deno 런타임)
// GET /api/auth/kakao/callback?code=...&state=...
//
// Node Function → Edge Function 이전 + 직렬 I/O 최적화:
//   1) nonce select+delete 를 PostgREST DELETE...returning=representation 단일 호출로 병합
//   2) sellers 조회를 .or('kakao_id.eq.X,email.eq.Y') 단일 호출로 병합 (기존 2회 select)
//   3) nonce 검증 RTT 와 token 교환 RTT 를 Promise.all 로 병렬화
//   4) 클라이언트 hash 에 onboarded=1 flag 추가 → /api/me 추가 호출 생략
//
// 흐름:
//   1) state nonce 형식 검증
//   2) [병렬] nonce DELETE returning + token POST
//   3) nonce 검증 (없거나 만료면 400)
//   4) token 검증
//   5) 카카오 사용자 정보 조회
//   6) sellers OR 조회 → INSERT or UPDATE
//   7) seller-jwt 서명 (HMAC SHA-256, Web Crypto)
//   8) 302 redirect (#kakao=callback&lumi_token=...&onboarded=1?)
//
// 환경변수:
//   - KAKAO_CLIENT_ID (또는 KAKAO_REST_API_KEY)
//   - KAKAO_CLIENT_SECRET
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
//   - JWT_SECRET (32자 이상)

const REDIRECT_URI = 'https://lumi.it.kr/api/auth/kakao/callback';
const KAKAO_TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const KAKAO_USER_URL = 'https://kapi.kakao.com/v2/user/me';
const JWT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14일

function envGet(name) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.get === 'function') {
      const v = Netlify.env.get(name);
      if (v) return v;
    }
  } catch (_) {}
  try {
    if (typeof Deno !== 'undefined' && Deno.env && typeof Deno.env.get === 'function') {
      return Deno.env.get(name) || null;
    }
  } catch (_) {}
  return null;
}

function redirect(location, extraHeaders = {}) {
  return new Response('', {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function errorRedirect(code) {
  return redirect(`/signup?kakao_error=${encodeURIComponent(code)}`);
}

// base64url for Web Crypto / btoa
function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8ToBase64Url(str) {
  // UTF-8 안전 인코딩
  const bytes = new TextEncoder().encode(str);
  return bytesToBase64Url(bytes);
}

async function signSellerToken(sellerId, secret) {
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET 환경변수가 설정되지 않았거나 32자 미만입니다.');
  }
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = {
    seller_id: sellerId,
    iat: now,
    exp: now + JWT_TTL_SECONDS,
    iss: 'lumi-onboarding',
  };
  const encHeader = utf8ToBase64Url(JSON.stringify(header));
  const encBody = utf8ToBase64Url(JSON.stringify(body));
  const signingInput = `${encHeader}.${encBody}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  const sig = bytesToBase64Url(new Uint8Array(sigBuf));
  return `${signingInput}.${sig}`;
}

// Supabase REST helper
function sbHeaders(serviceKey, prefer) {
  const h = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  if (prefer) h['Prefer'] = prefer;
  return h;
}

export default async (request, _context) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  const KAKAO_REST_API_KEY = envGet('KAKAO_CLIENT_ID') || envGet('KAKAO_REST_API_KEY');
  const KAKAO_CLIENT_SECRET = envGet('KAKAO_CLIENT_SECRET');
  const SUPABASE_URL = envGet('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = envGet('SUPABASE_SERVICE_ROLE_KEY');
  const JWT_SECRET = envGet('JWT_SECRET');

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errParam = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  if (errParam) {
    console.log('[auth-kakao-callback] 카카오 거부:', errParam, errorDescription || '');
    return errorRedirect(errParam);
  }
  if (!code) return errorRedirect('missing_code');

  if (!KAKAO_REST_API_KEY || !KAKAO_CLIENT_SECRET) {
    console.error('[auth-kakao-callback] KAKAO 환경변수 미설정');
    return errorRedirect('server_configuration_error');
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[auth-kakao-callback] Supabase 환경변수 미설정');
    return errorRedirect('server_error');
  }

  // 1) state 형식 검증
  if (!state || !/^[a-f0-9]{32}$/i.test(state)) {
    console.error('[auth-kakao-callback] state 형식 오류 또는 누락');
    return errorRedirect('invalid_state');
  }
  const nonceKey = 'kakao_signup:' + state;

  // 2) [최적화] nonce DELETE...returning + token 교환 병렬 시작
  // PostgREST DELETE with Prefer: return=representation 은 삭제된 row 를 반환하므로
  // SELECT + DELETE 두 번 RTT 를 단 한 번으로 합칠 수 있다.
  const noncePromise = fetch(
    `${SUPABASE_URL}/rest/v1/oauth_nonces?nonce=eq.${encodeURIComponent(nonceKey)}&select=nonce,created_at`,
    {
      method: 'DELETE',
      headers: sbHeaders(SUPABASE_SERVICE_ROLE_KEY, 'return=representation'),
    },
  );

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

  // 두 요청 모두 settle 까지 기다린 뒤 결과 처리
  const [nonceSettled, tokenSettled] = await Promise.allSettled([noncePromise, tokenPromise]);

  // 3) nonce 결과 처리
  if (nonceSettled.status !== 'fulfilled') {
    console.error('[auth-kakao-callback] nonce 조회 예외:', nonceSettled.reason && nonceSettled.reason.message);
    return errorRedirect('server_error');
  }
  const nonceRes = nonceSettled.value;
  if (!nonceRes.ok) {
    const txt = await nonceRes.text().catch(() => '');
    console.error('[auth-kakao-callback] nonce DELETE HTTP 오류:', nonceRes.status, txt);
    return errorRedirect('server_error');
  }
  let nonceRows;
  try {
    nonceRows = await nonceRes.json();
  } catch (_) {
    nonceRows = [];
  }
  if (!Array.isArray(nonceRows) || nonceRows.length === 0) {
    console.error('[auth-kakao-callback] nonce not found:', nonceKey);
    return errorRedirect('invalid_state');
  }
  const nonceRow = nonceRows[0];
  const expiry = new Date(nonceRow.created_at).getTime() + 10 * 60 * 1000;
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
    console.error('[auth-kakao-callback] 토큰 교환 오류:', tokenData && tokenData.error, tokenData && tokenData.error_description || '');
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

  // 6) [최적화] sellers OR 쿼리 — kakao_id OR email 단일 호출
  let existingSeller = null;
  try {
    const orParts = [`kakao_id.eq.${encodeURIComponent(kakaoId)}`];
    if (email) orParts.push(`email.eq.${encodeURIComponent(email)}`);
    const orFilter = orParts.join(',');

    const sellerSelectUrl =
      `${SUPABASE_URL}/rest/v1/sellers?select=id,onboarded,email&or=(${orFilter})&limit=1`;
    const sellerRes = await fetch(sellerSelectUrl, {
      headers: sbHeaders(SUPABASE_SERVICE_ROLE_KEY),
    });
    if (!sellerRes.ok) {
      const txt = await sellerRes.text().catch(() => '');
      console.error('[auth-kakao-callback] sellers 조회 실패:', sellerRes.status, txt);
      return errorRedirect('server_error');
    }
    const arr = await sellerRes.json();
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

    try {
      const updRes = await fetch(
        `${SUPABASE_URL}/rest/v1/sellers?id=eq.${encodeURIComponent(sellerId)}`,
        {
          method: 'PATCH',
          headers: sbHeaders(SUPABASE_SERVICE_ROLE_KEY, 'return=minimal'),
          body: JSON.stringify(updatePayload),
        },
      );
      if (!updRes.ok) {
        const txt = await updRes.text().catch(() => '');
        console.warn('[auth-kakao-callback] sellers UPDATE 실패 (무시하고 진행):', updRes.status, txt);
      }
    } catch (e) {
      console.warn('[auth-kakao-callback] sellers UPDATE 예외 (무시):', e && e.message);
    }
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

    try {
      const insRes = await fetch(`${SUPABASE_URL}/rest/v1/sellers`, {
        method: 'POST',
        headers: sbHeaders(SUPABASE_SERVICE_ROLE_KEY, 'return=representation'),
        body: JSON.stringify(insertPayload),
      });
      if (!insRes.ok) {
        const txt = await insRes.text().catch(() => '');
        console.error('[auth-kakao-callback] sellers INSERT 실패:', insRes.status, txt);
        return errorRedirect('account_save_failed');
      }
      const insArr = await insRes.json();
      const inserted = Array.isArray(insArr) ? insArr[0] : null;
      if (!inserted || !inserted.id) {
        console.error('[auth-kakao-callback] sellers INSERT 결과 누락');
        return errorRedirect('account_save_failed');
      }
      sellerId = inserted.id;
      onboarded = Boolean(inserted.onboarded);
    } catch (e) {
      console.error('[auth-kakao-callback] sellers INSERT 예외:', e && e.message);
      return errorRedirect('account_save_failed');
    }
  }

  // 8) seller-jwt 서명 (Web Crypto)
  let sellerJwt;
  try {
    sellerJwt = await signSellerToken(sellerId, JWT_SECRET);
  } catch (e) {
    console.error('[auth-kakao-callback] JWT 발급 실패:', e && e.message);
    return errorRedirect('jwt_error');
  }

  const cookieVal =
    `lumi_session=${sellerJwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 14}`;

  console.log('[auth-kakao-callback] 카카오 로그인 완료(Edge). seller_id:', sellerId, 'onboarded:', onboarded);

  // 9) hash 에 onboarded flag 추가 — 클라이언트에서 /api/me 한 번 생략 가능
  let hash = `#kakao=callback&lumi_token=${encodeURIComponent(sellerJwt)}`;
  if (onboarded) hash += '&onboarded=1';
  const destination = onboarded ? `/dashboard${hash}` : `/signup${hash}`;

  return redirect(destination, { 'Set-Cookie': cookieVal });
};

export const config = {
  path: '/api/auth/kakao/callback',
};
