// 반품·교환 처리 이력 조회
// GET /api/return-history?status=all|completed|rejected|failed&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=30
//
// 응답: { success, history: [...], total, summary: { completed, rejected, failed }, mocked? }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const VALID_STATUS = new Set(['all', 'completed', 'rejected', 'failed']);

function mockHistory(sellerId) {
  const base = new Date('2026-04-28T08:00:00Z').getTime();
  return [
    {
      id: 'mock-hist-1',
      request_id: 'mock-req-completed-1',
      order_id: 'mock-order-3',
      seller_id: sellerId,
      marketplace: 'coupang',
      type: 'refund',
      reason: '단순 변심',
      status: 'completed',
      amount: 39000,
      requested_at: new Date(base - 86400000).toISOString(),
      processed_at: new Date(base - 86000000).toISOString(),
      processed_by: sellerId,
      notes: null,
      audit_trail: [
        { at: new Date(base - 86400000).toISOString(), to: 'pending', actor_type: 'webhook' },
        { at: new Date(base - 86200000).toISOString(), to: 'approved', actor_type: 'seller' },
        { at: new Date(base - 86100000).toISOString(), to: 'processing', actor_type: 'system' },
        { at: new Date(base - 86000000).toISOString(), to: 'completed', actor_type: 'system' },
      ],
    },
    {
      id: 'mock-hist-2',
      request_id: 'mock-req-rejected-1',
      order_id: 'mock-order-7',
      seller_id: sellerId,
      marketplace: 'naver',
      type: 'refund',
      reason: '단순 변심 (수령 후 7일 초과)',
      status: 'rejected',
      amount: null,
      requested_at: new Date(base - 172800000).toISOString(),
      processed_at: new Date(base - 172000000).toISOString(),
      processed_by: sellerId,
      notes: '수령 후 7일 초과로 거절',
      audit_trail: [
        { at: new Date(base - 172800000).toISOString(), to: 'pending', actor_type: 'webhook' },
        { at: new Date(base - 172000000).toISOString(), to: 'rejected', actor_type: 'seller' },
      ],
    },
  ];
}

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
  const status = VALID_STATUS.has(q.status) ? q.status : 'all';
  const limit = Math.max(1, Math.min(100, parseInt(q.limit || '30', 10)));
  const fromDate = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : null;
  const toDate = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : null;
  const orderId = q.orderId || q.order_id || null;
  const requestId = q.requestId || q.request_id || null;

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  let admin = null;
  try { admin = getAdminClient(); } catch { /* */ }

  if (!admin && isSignupMock) {
    let all = mockHistory(payload.seller_id);
    if (status !== 'all') all = all.filter((h) => h.status === status);
    const summary = { completed: all.filter((h) => h.status === 'completed').length, rejected: all.filter((h) => h.status === 'rejected').length, failed: all.filter((h) => h.status === 'failed').length };
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, history: all.slice(0, limit), total: all.length, summary, mocked: true }),
    };
  }

  if (!admin) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  let query = admin
    .from('return_history')
    .select('id, request_id, order_id, marketplace, type, reason, status, amount, requested_at, processed_at, processed_by, notes, audit_trail', { count: 'exact' })
    .eq('seller_id', payload.seller_id)
    .order('processed_at', { ascending: false })
    .limit(limit);

  if (status !== 'all') query = query.eq('status', status);
  if (orderId) query = query.eq('order_id', orderId);
  if (requestId) query = query.eq('request_id', requestId);
  if (fromDate) query = query.gte('processed_at', `${fromDate}T00:00:00.000Z`);
  if (toDate) query = query.lte('processed_at', `${toDate}T23:59:59.999Z`);

  const { data, error: dbErr, count } = await query;
  if (dbErr) {
    console.error('[return-history] db error:', dbErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '이력을 불러오지 못했어요.' }) };
  }

  // 요약 카운트 (별도 head:exact 쿼리)
  let summary = { completed: 0, rejected: 0, failed: 0 };
  try {
    const [c1, c2, c3] = await Promise.all([
      admin.from('return_history').select('id', { count: 'exact', head: true }).eq('seller_id', payload.seller_id).eq('status', 'completed'),
      admin.from('return_history').select('id', { count: 'exact', head: true }).eq('seller_id', payload.seller_id).eq('status', 'rejected'),
      admin.from('return_history').select('id', { count: 'exact', head: true }).eq('seller_id', payload.seller_id).eq('status', 'failed'),
    ]);
    summary = { completed: c1.count || 0, rejected: c2.count || 0, failed: c3.count || 0 };
  } catch { /* best-effort */ }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, history: data || [], total: count || (data || []).length, summary }),
  };
};
