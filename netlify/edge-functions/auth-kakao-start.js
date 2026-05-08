// 카카오 OAuth 시작 — Netlify Edge Function (Deno 런타임)
// GET /api/auth/kakao/start
//
// Node Function → Edge Function 이전:
//   - 한국 PoP에서 실행되어 kauth.kakao.com / Supabase(서울) 까지 왕복 단축
//   - cold start 거의 0
//
// 흐름:
//   1) crypto.getRandomValues(16바이트) → hex nonce
//   2) Supabase REST (PostgREST) 로 oauth_nonces INSERT (nonce='kakao_signup:'+hex)
//   3) 카카오 OAuth 인증 URL로 302 redirect
//
// 환경변수:
//   - KAKAO_CLIENT_ID (또는 KAKAO_REST_API_KEY)
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY

const REDIRECT_URI = 'https://lumi.it.kr/api/auth/kakao/callback';
// 비즈 앱 검수 통과 — 닉네임·프로필 사진 제외, 실명·연령대 추가
const SCOPE = 'account_email,name,age_range,phone_number';

function envGet(name) {
  // Netlify.env.get 우선, fallback to Deno.env.get
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

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function jsonError(statusCode, message) {
  return new Response(JSON.stringify({ error: message }), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function redirect(location) {
  return new Response('', {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
    },
  });
}

export default async (request, _context) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  const KAKAO_REST_API_KEY = envGet('KAKAO_CLIENT_ID') || envGet('KAKAO_REST_API_KEY');
  const SUPABASE_URL = envGet('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = envGet('SUPABASE_SERVICE_ROLE_KEY');

  if (!KAKAO_REST_API_KEY) {
    console.error('[auth-kakao-start] KAKAO_REST_API_KEY 환경변수 미설정');
    return jsonError(500, 'server_configuration_error');
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[auth-kakao-start] Supabase 환경변수 미설정');
    return jsonError(500, 'server_configuration_error');
  }

  // nonce 생성 (16바이트 → 32-char hex)
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  const nonce = bytesToHex(rand);
  const nonceKey = 'kakao_signup:' + nonce;

  // Supabase REST INSERT (PostgREST)
  try {
    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/oauth_nonces`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        nonce: nonceKey,
        created_at: new Date().toISOString(),
      }),
    });

    if (!insRes.ok) {
      const txt = await insRes.text().catch(() => '');
      console.error('[auth-kakao-start] nonce 저장 실패:', insRes.status, txt);
      return jsonError(500, 'server_error');
    }
  } catch (e) {
    console.error('[auth-kakao-start] nonce 저장 예외:', e && e.message);
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

  console.log('[auth-kakao-start] 카카오 OAuth 시작 (Edge)');
  return redirect(authUrl);
};

export const config = {
  path: '/api/auth/kakao/start',
};
