// 매핑 목록 조회 — GET /api/list-mappings
// Query: ?market=coupang&page=1&limit=50
// 응답: { mappings: [...], total: number }
// 인증: verifySellerToken

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const PAGE_LIMIT_MAX = 100;
const PAGE_LIMIT_DEFAULT = 50;
const VALID_MARKETS = new Set(['coupang', 'naver', 'toss']);

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

  const qs = event.queryStringParameters || {};
  const market = qs.market || null;
  if (market && !VALID_MARKETS.has(market)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '지원하지 않는 마켓이에요.' }) };
  }

  const page = Math.max(1, parseInt(qs.page, 10) || 1);
  const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, parseInt(qs.limit, 10) || PAGE_LIMIT_DEFAULT));
  const offset = (page - 1) * limit;

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  try {
    let query = admin
      .from('order_mappings')
      .select(
        'id, market, market_option_name, master_product_id, master_option_name, use_count, last_applied_at, created_at, updated_at, products(id, title)',
        { count: 'exact' }
      )
      .eq('seller_id', payload.seller_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (market) query = query.eq('market', market);

    const { data, error: dbErr, count } = await query;

    if (dbErr) {
      console.error('[list-mappings] DB error:', dbErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'DB 조회 오류예요.' }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        mappings: data || [],
        total: count ?? 0,
        page,
        limit,
      }),
    };
  } catch (err) {
    console.error('[list-mappings] unexpected error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류예요.' }) };
  }
};
