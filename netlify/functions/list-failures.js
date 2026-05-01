// 실패 통합 조회 — Sprint 5 실패 추적
// GET /api/list-failures
// 쿼리: category, resolved, from (ISO date), to (ISO date), limit
//
// 응답: { failures: [...], counts: { total, product_register, product_update, order_collect, tracking_send, claim_process, mapping } }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const VALID_CATEGORIES = new Set([
  'product_register', 'product_update', 'order_collect',
  'tracking_send', 'claim_process', 'mapping',
]);

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error } = verifySellerToken(token);
  if (error || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  const q = event.queryStringParameters || {};
  const category = (q.category && VALID_CATEGORIES.has(q.category)) ? q.category : null;
  const resolved = q.resolved === 'true' ? true : q.resolved === 'false' ? false : false;
  const from = q.from || null;
  const to = q.to || null;
  const limit = Math.max(1, Math.min(200, parseInt(q.limit || '50', 10)));

  let admin = null;
  try { admin = getAdminClient(); } catch (_) { /* */ }

  if (!admin) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'DB 연결 실패' }) };
  }

  try {
    // 카운트 쿼리 (카테고리별 미해결 수)
    const { data: countRows, error: countErr } = await admin
      .from('failure_log')
      .select('category')
      .eq('seller_id', payload.seller_id)
      .eq('resolved', false);

    if (countErr) throw countErr;

    const counts = {
      total: 0,
      product_register: 0,
      product_update: 0,
      order_collect: 0,
      tracking_send: 0,
      claim_process: 0,
      mapping: 0,
    };
    for (const row of (countRows || [])) {
      counts.total++;
      if (counts[row.category] !== undefined) counts[row.category]++;
    }

    // 리스트 쿼리
    let query = admin
      .from('failure_log')
      .select('id, category, market, target_type, target_id, target_summary, error_code, error_message, retry_count, last_retry_at, resolved, resolved_at, created_at')
      .eq('seller_id', payload.seller_id)
      .eq('resolved', resolved)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (category) query = query.eq('category', category);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data: failures, error: listErr } = await query;
    if (listErr) throw listErr;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, failures: failures || [], counts }),
    };
  } catch (err) {
    console.error('[list-failures]', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '실패 목록을 가져올 수 없어요.' }),
    };
  }
};
