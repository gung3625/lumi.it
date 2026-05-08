// tiktok-disconnect.js — TikTok 연결 해제 API
// DELETE /api/tiktok-disconnect
// - JWT 검증
// - tiktok_accounts row 삭제 (vault 트리거가 시크릿도 자동 삭제)
// - sellers 테이블 tiktok_connected = false, tiktok_disconnected_at = now()
// - return { ok: true }
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'DELETE, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'DELETE') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 1. Bearer 토큰 검증 — Supabase JWT 우선, seller-jwt fallback (카카오 가입자)
  // invariant: sellers.id = auth.users.id = tiktok_accounts.user_id (UUID 동일)
  const token = extractBearerToken(event);
  let userId = null;
  const { user } = await verifyBearerToken(token);
  if (user && user.id) {
    userId = user.id;
  } else {
    const { payload } = verifySellerToken(token);
    if (payload && payload.seller_id) userId = payload.seller_id;
  }
  if (!userId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  const admin = getAdminClient();

  try {
    // 2. tiktok_accounts row 삭제 (vault 트리거가 시크릿도 자동 삭제)
    const { error: taErr } = await admin
      .from('tiktok_accounts')
      .delete()
      .eq('user_id', userId);
    if (taErr) {
      console.error('[tiktok-disconnect] tiktok_accounts 삭제 실패:', taErr.message);
    }

    // 3. sellers 테이블 tiktok_connected = false, tiktok_disconnected_at = now()
    const { error: selErr } = await admin
      .from('sellers')
      .update({ tiktok_connected: false, tiktok_disconnected_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (selErr) {
      console.error('[tiktok-disconnect] sellers 업데이트 실패:', selErr.message);
    }

    console.log('[tiktok-disconnect] 완료 user_id=' + userId);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error('[tiktok-disconnect] 예외:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '연결 해제 처리 중 오류가 발생했습니다.' }),
    };
  }
};
