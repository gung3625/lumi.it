// 최근 게시물 1건 조회 — Bearer 토큰 검증.
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
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('reservations')
      .select('*')
      .eq('user_id', user.id)
      .eq('caption_status', 'posted')
      .order('posted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[last-post] select error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '최근 게시물 조회 실패' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ post: data || null }) };
  } catch (err) {
    console.error('[last-post] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
