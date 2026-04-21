// admin-list-testers.js — 베타 테스터 신청 목록 조회 (admin-only).
// GET /api/admin-list-testers
// Response: { testers: [{ id, name, email, tester_ig_handle, tester_invite_status, tester_submitted_at }] }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

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
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    await requireAdmin(event);
  } catch (err) {
    return { statusCode: err.statusCode || 401, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('users')
      .select('id, name, email, tester_ig_handle, tester_invite_status, tester_submitted_at')
      .not('tester_ig_handle', 'is', null)
      .order('tester_submitted_at', { ascending: false });

    if (error) {
      console.error('[admin-list-testers] select error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회 실패' }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ testers: data || [] }) };
  } catch (err) {
    console.error('[admin-list-testers] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
