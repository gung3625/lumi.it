// 30일 유예 회원 탈퇴 요청
// POST /api/account-delete
// 헤더: Authorization: Bearer <jwt> (Supabase JWT or seller-jwt)
// 응답: { ok: true, deletionScheduledAt: '<ISO>' }
//
// 동작:
//   1) JWT 검증 → seller 행 식별 (Supabase JWT 우선, seller-jwt fallback)
//   2) sellers UPDATE: deletion_requested_at = now(),
//                      deletion_scheduled_at = now() + interval '30 days',
//                      deletion_cancelled_at = NULL
//
// 클라이언트 측에서는 응답 후 logout 처리 + index.html 로 redirect.
// 30일 내 다시 로그인하면 auth-guard 가 배너로 복구 옵션 노출.
// 안내·reminder·최종 알림은 모두 UI 배너로 대체 (이메일 발송 없음).

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const GRACE_DAYS = 30;

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[account-delete] admin client 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  // 1) Supabase JWT 우선 (OAuth 사용자)
  let sellerQuery = null;
  try {
    const { data: supaAuthData } = await admin.auth.getUser(token);
    if (supaAuthData && supaAuthData.user && supaAuthData.user.email) {
      sellerQuery = { field: 'email', value: supaAuthData.user.email };
    }
  } catch (_) { /* fallthrough */ }

  // 2) seller-jwt fallback
  if (!sellerQuery) {
    const { payload, error: authErr } = verifySellerToken(token);
    if (authErr || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 만료되었습니다. 다시 로그인해주세요.' }) };
    }
    sellerQuery = { field: 'id', value: payload.seller_id };
  }

  // 현재 행 조회 (이름·이메일 + 이미 요청 중인지 확인)
  const { data: seller, error: selErr } = await admin
    .from('sellers')
    .select('id, owner_name, email, deletion_requested_at, deletion_cancelled_at')
    .eq(sellerQuery.field, sellerQuery.value)
    .maybeSingle();

  if (selErr) {
    console.error('[account-delete] seller select 오류:', selErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '회원 정보 조회에 실패했습니다.' }) };
  }
  if (!seller) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '회원을 찾을 수 없습니다.' }) };
  }

  const now = new Date();
  const scheduled = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);

  const { error: updErr } = await admin
    .from('sellers')
    .update({
      deletion_requested_at: now.toISOString(),
      deletion_scheduled_at: scheduled.toISOString(),
      deletion_cancelled_at: null,
    })
    .eq('id', seller.id);

  if (updErr) {
    console.error('[account-delete] update 오류:', updErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '탈퇴 요청 처리에 실패했습니다.' }) };
  }

  console.log(`[account-delete] seller=${seller.id.slice(0, 8)} scheduled=${scheduled.toISOString()}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      success: true,
      deletionScheduledAt: scheduled.toISOString(),
      graceDays: GRACE_DAYS,
    }),
  };
};
