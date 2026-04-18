// 이번 달 게시(예약 포함) 횟수 조회 — Bearer 토큰으로 본인 카운트 반환.
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const admin = getAdminClient();
    const { count, error } = await admin
      .from('reservations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('created_at', monthStart);
    if (error) {
      console.error('[count-posts] select error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '게시 횟수 조회 실패' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ count: count || 0 }) };
  } catch (err) {
    console.error('[count-posts] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
