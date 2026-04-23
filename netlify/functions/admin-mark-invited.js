const { corsHeaders, getOrigin } = require('./_shared/auth');
// admin-mark-invited.js — 베타 테스터 초대 상태 토글 (admin-only).
// POST /api/admin-mark-invited
// body: { user_id: string, status: 'invited' | 'pending' }
// Response: { success: true, status }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');


async function requireAdmin(event) {
  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) throw Object.assign(new Error('인증이 필요합니다.'), { statusCode: 401 });

  const admin = getAdminClient();
  const { data, error: dbErr } = await admin.from('users').select('is_admin').eq('id', user.id).single();
  if (dbErr || !data) throw Object.assign(new Error('사용자 조회 실패'), { statusCode: 500 });
  if (!data.is_admin) throw Object.assign(new Error('관리자 권한이 없습니다.'), { statusCode: 401 });

  return { userId: user.id };
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    await requireAdmin(event);
  } catch (err) {
    return { statusCode: err.statusCode || 401, headers: headers, body: JSON.stringify({ error: err.message }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}

  const targetId = String(body.user_id || '').trim();
  const nextStatus = body.status === 'pending' ? 'pending' : 'invited';
  if (!targetId) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'user_id 필수' }) };
  }

  try {
    const admin = getAdminClient();
    const { error } = await admin
      .from('users')
      .update({ tester_invite_status: nextStatus })
      .eq('id', targetId);

    if (error) {
      console.error('[admin-mark-invited] update error:', error.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '업데이트 실패' }) };
    }

    return { statusCode: 200, headers: headers, body: JSON.stringify({ success: true, status: nextStatus }) };
  } catch (err) {
    console.error('[admin-mark-invited] unexpected:', err && err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
