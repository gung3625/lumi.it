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
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { normalizePhone, isValidPhone } = require('./_shared/onboarding-utils');

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

  // verifyBearerToken 이 supabase JWT / seller-jwt 둘 다 처리하고 user.id 를 sellers.id 로 정착시켜준다.
  const { user, error: authErr } = await verifyBearerToken(rawToken);
  if (authErr || !user || !user.id) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  const sellerId = user.id;
  // 옛 구글 사용자(=auth.users) 는 user.id 가 sellers.id 와 다를 수 있어 user_metadata 동기화 분기 보존.
  // 카카오 사용자는 user.user_metadata 가 sellers 에서 채운 값이라 별도 동기화 불필요.
  const supaUserId = user.email && !user.user_metadata?.store_name ? user.id : null;

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

  // phone: 카카오에서 이미 받았으면 body 에서 안 보내도 됨. body 에 있으면 검증 후 사용.
  let phone = null;
  if (body.phone) {
    const normalized = normalizePhone(body.phone);
    if (!isValidPhone(normalized)) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: '휴대폰 번호를 010으로 시작하는 11자리 숫자로 입력해주세요.' }),
      };
    }
    phone = normalized;
  } else {
    // body 에 phone 없으면 DB 에 저장된 값 확인 (카카오 callback 이 채웠을 것)
    const { data: existing } = await admin
      .from('sellers')
      .select('phone')
      .eq('id', sellerId)
      .maybeSingle();
    if (!existing?.phone || !isValidPhone(existing.phone)) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: '휴대폰 번호를 010으로 시작하는 11자리 숫자로 입력해주세요.' }),
      };
    }
  }

  // ──────────────────────────────────────────────
  // 3) sellers UPDATE
  // ──────────────────────────────────────────────
  try {
    // 기본 정보(매장/업종/폰)만 저장 — onboarded 는 IG 연동 또는 명시적 skip 후 셋.
    const updatePayload = {
      store_name: store_name.trim(),
      industry: industry.trim(),
      signup_completed_at: new Date().toISOString(),
    };
    if (phone) updatePayload.phone = phone;

    const { error: updErr } = await admin
      .from('sellers')
      .update(updatePayload)
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
