// Bearer token verification helper.
//
// 두 종류의 토큰을 모두 받아 단일 user 객체로 정착시킨다:
//   1. Supabase JWT (auth.users) — 옛 구글 가입자용. 라이브 사용자 0이지만 호환 보존.
//   2. seller-jwt (HS256, lumi 자체 발급) — 카카오 가입자.
//
// 둘 다 실패 시 { user: null, error }. 호출 측은 user.id 를 sellers.id 로
// 가정하면 된다 (seller-jwt 경로 보장, supabase 경로는 호환성).

const { createClient } = require('@supabase/supabase-js');
const { verifySellerToken } = require('./seller-jwt');
const { getAdminClient } = require('./supabase-admin');

let cached = null;

function getAuthClient() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Supabase 환경변수(SUPABASE_URL / SUPABASE_ANON_KEY)가 설정되지 않았습니다.');
  }
  cached = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Verify a Bearer token and return the associated user.
 * Supabase JWT 우선 시도, 실패 시 seller-jwt fallback (카카오 사용자).
 *
 * @param {string} token
 * @returns {Promise<{ user: object|null, error: Error|null }>}
 */
async function verifyBearerToken(token) {
  if (!token) return { user: null, error: new Error('토큰이 없습니다.') };

  // 1) Supabase JWT 시도
  try {
    const client = getAuthClient();
    const { data, error } = await client.auth.getUser(token);
    if (!error && data && data.user) return { user: data.user, error: null };
  } catch (_) {
    // Supabase JWT 형식이 아니면 throw 가능 — seller-jwt fallback 으로 진행
  }

  // 2) seller-jwt fallback (카카오 가입자)
  const { payload, error: sellerErr } = verifySellerToken(token);
  if (sellerErr || !payload || !payload.seller_id) {
    return { user: null, error: new Error('유효하지 않은 토큰입니다.') };
  }

  // sellers 행 조회 후 supabase user 와 호환되는 형태로 정착
  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return { user: null, error: e };
  }

  const { data: seller, error: dbErr } = await admin
    .from('sellers')
    .select('id, email, store_name, industry, onboarded, plan')
    .eq('id', payload.seller_id)
    .maybeSingle();

  if (dbErr || !seller) {
    return { user: null, error: new Error('계정을 찾을 수 없습니다.') };
  }

  return {
    user: {
      id: seller.id,
      email: seller.email || '',
      user_metadata: {
        onboarded: !!seller.onboarded,
        store_name: seller.store_name || '',
        industry: seller.industry || '',
        plan: seller.plan || null,
      },
    },
    error: null,
  };
}

/**
 * Extract Bearer token from Netlify event headers.
 * @param {object} event
 * @returns {string}
 */
function extractBearerToken(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  return auth.replace(/^Bearer\s+/i, '');
}

module.exports = { verifyBearerToken, extractBearerToken, getAuthClient };
