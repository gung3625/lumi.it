const { corsHeaders, getOrigin } = require('./_shared/auth');
// 예약 목록 — Bearer 토큰 검증 후 본인 예약 반환.
// Supabase JWT (OAuth) 우선, seller-jwt (HS256, 카카오 가입자) fallback.
// invariant: sellers.id = auth.users.id = reservations.user_id (UUID 동일)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
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

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('reservations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      console.error('[list-reservations] select error:', error.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '예약 목록 조회 실패' }) };
    }
    return { statusCode: 200, headers: headers, body: JSON.stringify({ items: data || [] }) };
  } catch (err) {
    console.error('[list-reservations] unexpected:', err && err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
