// signup-skip-ig.js — 가입 마법사에서 IG 연동을 건너뛰고 대시보드로 진입하는 endpoint
// POST /api/signup-skip-ig
// 헤더: Authorization: Bearer <jwt>
//
// 효과: sellers.onboarded = true.
// 카카오 callback 라우팅이 onboarded=true 면 /dashboard 로 보내므로
// 다음 로그인 시 가입 마법사로 다시 들어가지 않음.

'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user || !user.id) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[signup-skip-ig] admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }

  const { error } = await admin
    .from('sellers')
    .update({ onboarded: true })
    .eq('id', user.id);

  if (error) {
    console.error('[signup-skip-ig] sellers UPDATE 실패:', error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장에 실패했습니다.' }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};
