// 아직 평가되지 않은 최근 자동응답 로그 목록
// GET /api/pending-auto-reply-rating?limit=20 — Bearer 토큰 인증 필수
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 1. Bearer 토큰 검증
  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  // 2. limit 파싱
  const qs = event.queryStringParameters || {};
  const rawLimit = parseInt(qs.limit, 10);
  const limit = Math.min(
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  const admin = getAdminClient();

  try {
    // 3. 평가되지 않은 최근 로그 조회
    const { data: items, error: itemsErr } = await admin
      .from('auto_reply_log')
      .select('id, received_text, reply_text, category, sub_category, sentiment, confidence, shadow_mode, created_at')
      .eq('user_id', user.id)
      .is('rating', null)
      .eq('replied', true)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (itemsErr) {
      console.error('[pending-auto-reply-rating] 조회 오류:', itemsErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '목록 조회 실패' }) };
    }

    // 4. 지금까지 평가한 개수 카운트
    const { count: ratedCount, error: countErr } = await admin
      .from('auto_reply_log')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .not('rating', 'is', null);

    if (countErr) {
      console.error('[pending-auto-reply-rating] 카운트 오류:', countErr.message);
    }

    const itemsCount = Array.isArray(items) ? items.length : 0;
    console.log(`[pending-auto-reply-rating] user=${user.id} pending=${itemsCount} rated=${ratedCount || 0}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        items: items || [],
        rated_count: ratedCount || 0,
      }),
    };
  } catch (err) {
    console.error('[pending-auto-reply-rating] 예외:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || '서버 오류' }) };
  }
};
