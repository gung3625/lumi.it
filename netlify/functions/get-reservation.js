const { corsHeaders, getOrigin } = require('./_shared/auth');
// 예약 단건 조회 — Bearer 토큰 검증 후 본인 예약만 반환.
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  const params = new URLSearchParams(event.queryStringParameters || {});
  let rKey = params.get('reserveKey') || params.get('reserve_key');
  if (!rKey && event.body) {
    try { const b = JSON.parse(event.body); rKey = b.reserveKey || b.reserve_key; } catch {}
  }
  if (!rKey) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'reserveKey가 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('reservations')
      .select('*')
      .eq('reserve_key', rKey)
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) {
      console.error('[get-reservation] select error:', error.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '예약 조회 실패' }) };
    }
    if (!data) {
      return { statusCode: 404, headers: headers, body: JSON.stringify({ error: '예약 없음' }) };
    }
    return { statusCode: 200, headers: headers, body: JSON.stringify({ reservation: data }) };
  } catch (err) {
    console.error('[get-reservation] unexpected:', err && err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
