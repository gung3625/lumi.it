// 프로필 조회 — Bearer 검증 + admin client (RLS 우회)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();
    if (error) {
      console.error('[get-profile] select error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '프로필 조회 실패' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ user: data }) };
  } catch (err) {
    console.error('[get-profile] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
