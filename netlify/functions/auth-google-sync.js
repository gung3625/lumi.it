// Google OAuth 후처리 — sellers 동기화
// POST /api/auth/google/sync
//
// Google OAuth는 Supabase Auth가 처리. 클라이언트가 Supabase 세션을 받은 후
// 이 함수를 호출하여 sellers 테이블을 동기화한다.
//
// 입력: Authorization: Bearer <supabase_access_token>
// 응답: { ok: true, onboarded: bool, redirect: '/signup' | '/dashboard' }
//
// 환경변수:
//   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (supabase-admin.js)
//   - SUPABASE_ANON_KEY (supabase-auth.js)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { signSellerToken } = require('./_shared/seller-jwt');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Bearer 토큰 추출 및 Supabase JWT 검증
  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    console.error('[auth-google-sync] 토큰 검증 실패:', authErr && authErr.message);
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰입니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[auth-google-sync] admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
  }

  // Supabase user 객체에서 Google 프로필 정보 추출
  // user.user_metadata: { full_name, avatar_url, sub (=google_id), ... }
  const email = user.email || null;
  const meta = user.user_metadata || {};
  const googleId = meta.sub || meta.provider_id || null;
  const displayName = meta.full_name || meta.name || null;
  const avatarUrl = meta.avatar_url || meta.picture || null;

  if (!email && !googleId) {
    console.error('[auth-google-sync] user 정보 부족 — email/google_id 모두 없음');
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '사용자 정보가 부족합니다.' }) };
  }

  try {
    const nowIso = new Date().toISOString();

    // google_id 기준으로 기존 행 확인
    let existingSeller = null;

    if (googleId) {
      const { data: byGoogleId } = await admin
        .from('sellers')
        .select('id, onboarded')
        .eq('google_id', googleId)
        .maybeSingle();
      existingSeller = byGoogleId || null;
    }

    // google_id 없으면 email로 재확인
    if (!existingSeller && email) {
      const { data: byEmail } = await admin
        .from('sellers')
        .select('id, onboarded')
        .eq('email', email)
        .maybeSingle();
      existingSeller = byEmail || null;
    }

    let sellerId;
    let onboarded = false;

    if (existingSeller) {
      sellerId = existingSeller.id;
      onboarded = Boolean(existingSeller.onboarded);

      // 기존 행 UPDATE: google_id + 프로필 동기화
      const { error: updErr } = await admin
        .from('sellers')
        .update({
          google_id: googleId,
          display_name: displayName,
          avatar_url: avatarUrl,
          signup_method: 'google',
          updated_at: nowIso,
        })
        .eq('id', sellerId);

      if (updErr) {
        console.warn('[auth-google-sync] sellers UPDATE 실패 (무시하고 진행):', updErr.message);
      }
    } else {
      // 신규 Google 가입: INSERT
      const { data: inserted, error: insErr } = await admin
        .from('sellers')
        .insert({
          google_id: googleId,
          email,
          display_name: displayName,
          avatar_url: avatarUrl,
          signup_method: 'google',
          onboarded: false,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select('id, onboarded')
        .single();

      if (insErr || !inserted) {
        console.error('[auth-google-sync] sellers INSERT 실패:', insErr && insErr.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '계정 저장에 실패했습니다.' }) };
      }

      sellerId = inserted.id;
      onboarded = false;
    }

    console.log('[auth-google-sync] Google 동기화 완료. seller_id:', sellerId, 'onboarded:', onboarded);

    let sellerToken = null;
    try {
      sellerToken = signSellerToken({ seller_id: sellerId });
    } catch (e) {
      console.error('[auth-google-sync] sellerToken 발급 실패:', e.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        onboarded,
        redirect: onboarded ? '/dashboard' : '/signup',
        sellerToken,
      }),
    };
  } catch (e) {
    console.error('[auth-google-sync] 예외:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
  }
};
