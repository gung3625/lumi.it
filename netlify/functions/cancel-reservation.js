// 예약 취소 — Bearer 토큰 검증 후 본인 예약만 cancelled=true 로 업데이트.
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청' }) };
  }
  const rKey = body.reserveKey || body.reserve_key || body.reservationKey;
  if (!rKey) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'reserveKey가 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('reservations')
      .update({ cancelled: true })
      .eq('reserve_key', rKey)
      .eq('user_id', user.id)
      .select()
      .maybeSingle();
    if (error) {
      console.error('[cancel-reservation] update error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '예약 취소 실패' }) };
    }
    if (!data) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '예약을 찾을 수 없습니다.' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('[cancel-reservation] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
