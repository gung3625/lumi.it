const { corsHeaders, getOrigin } = require('./_shared/auth');
// IG 연동 해제 — Bearer 검증 + admin client (RLS 우회)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();
    const { error } = await admin
      .from('ig_accounts')
      .delete()
      .eq('user_id', user.id);
    if (error) {
      console.error('[disconnect-ig] delete error:', error.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'IG 연동 해제 실패' }) };
    }
    return { statusCode: 200, headers: headers, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('[disconnect-ig] unexpected:', err && err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
