// 온보딩 완료 — 매장 정보 저장
// POST /api/signup-complete
//
// 입력: Authorization: Bearer <jwt> (seller-jwt 또는 Supabase JWT)
//       body: { store_name: string, industry: string }
//
// 동작:
//   1) JWT 검증 → seller_id 추출
//   2) 입력 검증 (store_name 1~50자, industry 필수)
//   3) sellers UPDATE SET store_name, industry, signup_completed_at, onboarded=true
//   4) 응답: { ok: true, redirect: '/dashboard' }
//
// 환경변수:
//   - JWT_SECRET (seller-jwt.js)
//   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { verifyBearerToken } = require('./_shared/supabase-auth');
const { corsHeaders, getOrigin } = require('./_shared/auth');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ──────────────────────────────────────────────
  // 1) JWT 검증 → seller_id 추출
  //    seller-jwt(HS256) 우선, 실패 시 Supabase JWT(ES256) fallback
  // ──────────────────────────────────────────────
  const rawToken = extractBearerToken(event);
  if (!rawToken) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[signup-complete] admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
  }

  let sellerId = null;
  let supaUserId = null; // Supabase Auth user.id (user_metadata 동기화용, 카카오 사용자는 null)

  // seller-jwt 우선 시도 (카카오 로그인 사용자)
  const { payload: sellerPayload, error: sellerErr } = verifySellerToken(rawToken);
  if (!sellerErr && sellerPayload && sellerPayload.seller_id) {
    sellerId = sellerPayload.seller_id;
    console.log('[signup-complete] seller-jwt 검증 성공');
  } else {
    // Supabase JWT fallback (Google 로그인 사용자)
    const { user: supaUser, error: supaErr } = await verifyBearerToken(rawToken);
    if (supaErr || !supaUser) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
    }

    supaUserId = supaUser.id || null;

    // Supabase user → sellers에서 id 조회
    const { data: found } = await admin
      .from('sellers')
      .select('id')
      .eq('email', supaUser.email)
      .maybeSingle();

    if (!found) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '계정을 찾을 수 없습니다.' }) };
    }

    sellerId = found.id;
    console.log('[signup-complete] Supabase JWT 검증 성공');
  }

  // ──────────────────────────────────────────────
  // 2) 입력 검증
  // ──────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식입니다.' }) };
  }

  const { store_name, industry } = body;

  if (!store_name || typeof store_name !== 'string' || store_name.trim().length < 1 || store_name.trim().length > 50) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: '매장 이름은 1~50자 사이로 입력해주세요.' }),
    };
  }

  if (!industry || typeof industry !== 'string' || !industry.trim()) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: '업종을 선택해주세요.' }),
    };
  }

  // ──────────────────────────────────────────────
  // 3) sellers UPDATE
  // ──────────────────────────────────────────────
  try {
    const { error: updErr } = await admin
      .from('sellers')
      .update({
        store_name: store_name.trim(),
        industry: industry.trim(),
        signup_completed_at: new Date().toISOString(),
        onboarded: true,
      })
      .eq('id', sellerId);

    if (updErr) {
      console.error('[signup-complete] sellers UPDATE 실패:', updErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '정보 저장에 실패했습니다.' }) };
    }

    // Supabase Auth user_metadata도 동기화 (auth-guard 호환)
    // 카카오 가입자는 supaUserId가 null이므로 스킵
    if (supaUserId) {
      try {
        await admin.auth.admin.updateUserById(supaUserId, {
          user_metadata: { onboarded: true, store_name: store_name.trim(), industry: industry.trim() },
        });
      } catch (e) {
        console.warn('[signup-complete] user_metadata 갱신 실패 (무시):', e.message);
      }
    }

    console.log('[signup-complete] 온보딩 완료. seller_id:', sellerId);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, redirect: '/dashboard' }),
    };
  } catch (e) {
    console.error('[signup-complete] 예외:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
  }
};
