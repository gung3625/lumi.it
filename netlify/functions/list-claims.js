// list-claims.js — 클레임 목록 조회 + 탭별 카운트
// GET /api/list-claims?type=cancel|return|exchange|inquiry&status=pending&page=1&limit=20

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const VALID_TYPES = new Set(['cancel', 'return', 'exchange', 'inquiry']);
const VALID_STATUSES = new Set(['pending', 'in_progress', 'approved', 'rejected', 'completed']);

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error } = verifySellerToken(token);
  if (error || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  const q = event.queryStringParameters || {};
  const claimType = VALID_TYPES.has(q.type) ? q.type : null;
  const statusFilter = VALID_STATUSES.has(q.status) ? q.status : null;
  const page = Math.max(1, parseInt(q.page || '1', 10));
  const limit = Math.max(1, Math.min(100, parseInt(q.limit || '20', 10)));
  const offset = (page - 1) * limit;

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[list-claims] supabase init error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  try {
    // 탭별 카운트 — 4개 타입 × 전체 상태
    const { data: countsData, error: cErr } = await admin
      .from('marketplace_claims')
      .select('claim_type, status')
      .eq('seller_id', payload.seller_id);

    if (cErr) {
      console.error('[list-claims] count query error:', cErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '클레임을 불러오지 못했어요.' }) };
    }

    const counts = { cancel: 0, return: 0, exchange: 0, inquiry: 0 };
    const pendingCounts = { cancel: 0, return: 0, exchange: 0, inquiry: 0 };
    for (const row of (countsData || [])) {
      if (counts[row.claim_type] !== undefined) {
        counts[row.claim_type]++;
        if (row.status === 'pending' || row.status === 'in_progress') {
          pendingCounts[row.claim_type]++;
        }
      }
    }

    // 본 목록 쿼리
    let query = admin
      .from('marketplace_claims')
      .select(
        'id, market, market_claim_id, claim_type, status, reason, buyer_message, seller_response, refund_amount, return_tracking_number, exchange_tracking_number, collected_at, resolved_at, created_at, updated_at, marketplace_order_id',
        { count: 'exact' }
      )
      .eq('seller_id', payload.seller_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (claimType) query = query.eq('claim_type', claimType);
    if (statusFilter) query = query.eq('status', statusFilter);

    const { data, error: lerr, count } = await query;
    if (lerr) {
      console.error('[list-claims] list query error:', lerr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '클레임을 불러오지 못했어요.' }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        claims: data || [],
        total: count || 0,
        page,
        limit,
        type: claimType,
        status: statusFilter,
        counts,
        pendingCounts,
      }),
    };
  } catch (e) {
    console.error('[list-claims] unexpected error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류가 발생했어요.' }) };
  }
};
