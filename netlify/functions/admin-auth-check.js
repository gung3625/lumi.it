// admin-auth-check.js — Supabase JWT 검증 후 users.is_admin 조회.
// POST /api/admin-auth-check
// Response: { is_admin: true } | 401
// 향후 admin API들의 공용 인증 체크로 재사용 가능.
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

    const { data, error: dbErr } = await admin
      .from('users')
      .select('is_admin')
      .eq('id', user.id)
      .single();

    if (dbErr || !data) {
      console.error('[admin-auth-check] users select error:', dbErr && dbErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '사용자 조회 실패' }) };
    }

    if (!data.is_admin) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '관리자 권한이 없습니다.' }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ is_admin: true }),
    };
  } catch (err) {
    console.error('[admin-auth-check] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
