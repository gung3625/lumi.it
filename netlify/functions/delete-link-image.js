const { corsHeaders, getOrigin } = require('./_shared/auth');
// delete-link-image — POST, Bearer 인증
// body: { path: "<user_id>/<uuid>.<ext>" }
// 경로의 첫 세그먼트가 호출자 user_id와 일치하는 경우에만 삭제
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Bad JSON' }) };
  }

  const rawPath = String(body.path || '').trim();
  if (!rawPath || rawPath.includes('..')) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'path가 잘못되었습니다.' }) };
  }

  const parts = rawPath.split('/');
  if (parts.length < 2 || parts[0] !== user.id) {
    return { statusCode: 403, headers: headers, body: JSON.stringify({ error: '권한이 없어요.' }) };
  }

  try {
    const admin = getAdminClient();
    const { error: delErr } = await admin.storage.from('link-assets').remove([rawPath]);
    if (delErr) {
      console.error('[delete-link-image] remove error:', delErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '삭제 실패' }) };
    }
    return { statusCode: 200, headers: headers, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('[delete-link-image] unexpected:', err && err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
