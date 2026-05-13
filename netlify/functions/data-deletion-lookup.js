// Meta 데이터 삭제 status URL 의 백엔드 — confirmation_code 로 처리 상태 조회.
// GET /api/data-deletion-lookup?code=<hex>
// 응답: { status, channel, createdAt, completedAt, errorMessage }
// 공개 endpoint — 인증 X (사장님이 url 클릭만으로 확인 가능해야 함).
//   confirmation_code 가 unguessable (32hex) 이라 token 역할.

'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const qs = event.queryStringParameters || {};
  const code = String(qs.code || '').trim();
  if (!code || !/^[a-f0-9]{8,64}$/i.test(code)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid code' }) };
  }

  let admin;
  try { admin = getAdminClient(); }
  catch (e) {
    console.error('[data-deletion-lookup] admin client 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류' }) };
  }

  try {
    const { data, error } = await admin
      .from('data_deletion_requests')
      .select('status, channel, created_at, completed_at, error_message')
      .eq('confirmation_code', code)
      .maybeSingle();
    if (error) {
      console.error('[data-deletion-lookup] select 오류:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회 실패' }) };
    }
    if (!data) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'not_found' }) };
    }
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: data.status,
        channel: data.channel,
        createdAt: data.created_at,
        completedAt: data.completed_at,
        errorMessage: data.error_message,
      }),
    };
  } catch (e) {
    console.error('[data-deletion-lookup] 예외:', e && e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
