// reservation-status.js — 단건 예약 상태 조회 (폴링용).
// GET /api/reservation-status?key=reserve:1234567890
// 헤더: Authorization: Bearer <jwt>
//
// 응답: { ok: true, status: { caption_status, is_sent, cancelled, caption_error,
//                             selected_caption_index, captions, post_mode } }
// register-product 페이지가 업로드 직후 1~2초 간격으로 폴링해서 사장님께
// "사진 분석 중 → 캡션 만드는 중 → 게시 중 → 완료" 단계를 표시할 때 사용.

'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user || !user.id) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  const params = new URLSearchParams(event.rawQuery || '');
  const reserveKey = params.get('key') || '';
  if (!reserveKey) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'key 가 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[reservation-status] admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }

  const { data, error } = await admin
    .from('reservations')
    .select('reserve_key, user_id, caption_status, is_sent, cancelled, caption_error, selected_caption_index, captions, post_mode, ig_permalink')
    .eq('reserve_key', reserveKey)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[reservation-status] 조회 실패:', error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회 실패' }) };
  }
  if (!data) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '해당 예약을 찾을 수 없습니다.' }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, status: data }) };
};
