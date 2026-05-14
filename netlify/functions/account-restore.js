// 회원 탈퇴 복구 (7일 유예 내)
// POST /api/account-restore
// 헤더: Authorization: Bearer <jwt>
// 응답: { ok: true }
//
// 동작:
//   1) JWT 검증 → seller 식별
//   2) 현재 deletion_requested_at IS NOT NULL AND deletion_cancelled_at IS NULL 인지 확인
//   3) UPDATE deletion_cancelled_at = now()
// 복구 안내·후속 알림은 모두 UI 배너로 대체 (이메일 발송 없음).

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

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
    console.error('[account-restore] admin client 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  let sellerQuery = null;
  try {
    const { data: supaAuthData } = await admin.auth.getUser(token);
    if (supaAuthData && supaAuthData.user && supaAuthData.user.email) {
      sellerQuery = { field: 'email', value: supaAuthData.user.email };
    }
  } catch (_) { /* fallthrough */ }

  if (!sellerQuery) {
    const { payload, error: authErr } = verifySellerToken(token);
    if (authErr || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 만료되었습니다. 다시 로그인해주세요.' }) };
    }
    sellerQuery = { field: 'id', value: payload.seller_id };
  }

  const { data: seller, error: selErr } = await admin
    .from('sellers')
    .select('id, owner_name, email, deletion_requested_at, deletion_cancelled_at')
    .eq(sellerQuery.field, sellerQuery.value)
    .maybeSingle();

  if (selErr) {
    console.error('[account-restore] seller select 오류:', selErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '회원 정보 조회에 실패했습니다.' }) };
  }
  if (!seller) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '회원을 찾을 수 없습니다.' }) };
  }
  if (!seller.deletion_requested_at) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '탈퇴 요청 상태가 아닙니다.' }) };
  }

  // 이미 복구된 상태여도 멱등 처리 — 단순 200 반환
  if (seller.deletion_cancelled_at) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, success: true, alreadyRestored: true }) };
  }

  const now = new Date();
  const { error: updErr } = await admin
    .from('sellers')
    .update({ deletion_cancelled_at: now.toISOString() })
    .eq('id', seller.id)
    .not('deletion_requested_at', 'is', null);

  if (updErr) {
    console.error('[account-restore] update 오류:', updErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '복구 처리에 실패했습니다.' }) };
  }

  console.log(`[account-restore] seller=${seller.id.slice(0, 8)} restored`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, success: true }),
  };
};
