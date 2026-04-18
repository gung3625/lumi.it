// IG 연동 해제 — Bearer 검증 + admin client (RLS 우회)
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

  try {
    const admin = getAdminClient();
    const { error } = await admin
      .from('ig_accounts')
      .delete()
      .eq('user_id', user.id);
    if (error) {
      console.error('[disconnect-ig] delete error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'IG 연동 해제 실패' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('[disconnect-ig] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
