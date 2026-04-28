// CS 스레드 리스트·상세 조회 — Sprint 3
// GET /api/cs-threads               — 리스트 (filter)
// GET /api/cs-threads?id=<uuid>     — 상세 + 메시지 동봉

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const VALID_FILTERS = new Set(['all', 'pending', 'in_progress', 'resolved']);

function mockThreads(sellerId) {
  const now = Date.now();
  return [
    { id: `mock-cs-${now}-1`, seller_id: sellerId, market: 'coupang', market_thread_id: 'CP_CS_1', status: 'pending', category: 'shipping', buyer_name_masked: '김**', preview_text: '주문한 원피스 언제 발송되나요?', ai_suggested_response: null, created_at: new Date(now - 600000).toISOString() },
    { id: `mock-cs-${now}-2`, seller_id: sellerId, market: 'naver',   market_thread_id: 'NV_CS_2', status: 'pending', category: 'exchange', buyer_name_masked: '박**', preview_text: '사이즈 교환 가능한가요?', ai_suggested_response: '박** 고객님,\n사이즈 교환 요청 잘 접수했어요. 회수 후 새 상품 발송까지 보통 3~5일 소요돼요.', ai_confidence: 0.74, created_at: new Date(now - 1200000).toISOString() },
    { id: `mock-cs-${now}-3`, seller_id: sellerId, market: 'coupang', market_thread_id: 'CP_CS_3', status: 'resolved', category: 'shipping', buyer_name_masked: '이**', preview_text: '발송 됐나요?', seller_response: '오늘 출고됐어요!', created_at: new Date(now - 86400000).toISOString() },
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
  const filter = VALID_FILTERS.has(q.filter) ? q.filter : 'all';
  const limit = Math.max(1, Math.min(100, parseInt(q.limit || '30', 10)));
  const threadId = q.id || null;

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  let admin = null;
  try { admin = getAdminClient(); } catch { /* */ }

  if (!admin && isSignupMock) {
    const all = mockThreads(payload.seller_id);
    if (threadId) {
      const t = all.find((x) => x.id === threadId);
      if (!t) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '문의를 찾을 수 없어요.' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, thread: t, messages: [{ sender_type: 'buyer', content: t.preview_text, created_at: t.created_at }], mocked: true }) };
    }
    let filtered = all;
    if (filter !== 'all') filtered = all.filter((t) => t.status === filter);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, threads: filtered.slice(0, limit), total: filtered.length, mocked: true }) };
  }

  if (!admin) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  if (threadId) {
    const { data: t } = await admin
      .from('cs_threads')
      .select('*')
      .eq('id', threadId)
      .eq('seller_id', payload.seller_id)
      .single();
    if (!t) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '문의를 찾을 수 없어요.' }) };
    const { data: msgs } = await admin
      .from('cs_messages')
      .select('id, sender_type, content, created_at, metadata')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, thread: t, messages: msgs || [] }) };
  }

  let query = admin
    .from('cs_threads')
    .select('id, market, market_thread_id, status, category, buyer_name_masked, preview_text, ai_suggested_response, ai_confidence, seller_response, responded_at, created_at', { count: 'exact' })
    .eq('seller_id', payload.seller_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (filter !== 'all') query = query.eq('status', filter);

  const { data, error: lerr, count } = await query;
  if (lerr) {
    console.error('[cs-threads] error:', lerr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '문의를 불러오지 못했어요.' }) };
  }
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, threads: data || [], total: count || (data || []).length, filter }) };
};
