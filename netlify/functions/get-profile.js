// 프로필 조회 — Bearer 검증 + admin client (RLS 우회)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { corsHeaders, getOrigin } = require('./_shared/auth');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('users')
      .select('id, name, email, phone, store_name, instagram_handle, biz_category, caption_tone, tag_style, plan, region, auto_story, auto_festival')
      .eq('id', user.id)
      .single();
    if (error) {
      console.error('[get-profile] select error:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '프로필 조회 실패' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ user: data }) };
  } catch (err) {
    console.error('[get-profile] unexpected:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
