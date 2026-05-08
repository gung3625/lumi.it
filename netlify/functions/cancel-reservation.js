const { corsHeaders, getOrigin } = require('./_shared/auth');
// 예약 취소 — Bearer 토큰 검증 후 본인 예약만 cancelled=true 로 업데이트.
// Supabase JWT (OAuth) 우선, seller-jwt (HS256, 카카오 가입자) fallback.
// invariant: sellers.id = auth.users.id = reservations.user_id (UUID 동일)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  // 1) Supabase JWT 우선 검증
  let userId = null;
  const { user } = await verifyBearerToken(token);
  if (user && user.id) {
    userId = user.id;
  } else {
    // 2) seller-jwt fallback (카카오 가입자)
    const { payload } = verifySellerToken(token);
    if (payload && payload.seller_id) userId = payload.seller_id;
  }
  if (!userId) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: '잘못된 요청' }) };
  }
  const rKey = body.reserveKey || body.reserve_key || body.reservationKey;
  if (!rKey) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'reserveKey가 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('reservations')
      .update({ cancelled: true })
      .eq('reserve_key', rKey)
      .eq('user_id', userId)
      .select()
      .maybeSingle();
    if (error) {
      console.error('[cancel-reservation] update error:', error.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '예약 취소 실패' }) };
    }
    if (!data) {
      return { statusCode: 404, headers: headers, body: JSON.stringify({ error: '예약을 찾을 수 없습니다.' }) };
    }
    return { statusCode: 200, headers: headers, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('[cancel-reservation] unexpected:', err && err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
