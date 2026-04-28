// CS AI 답변 초안 생성 — Sprint 3
// POST /api/cs-suggest-reply
// Body: { thread_id?, message, category?, buyer_name_masked?, product_title?, courier?, tracking_number? }
// thread_id 있으면 DB에서 컨텍스트 조회해서 자동 채움.

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { suggestReply } = require('./_shared/cs-suggester');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error } = verifySellerToken(token);
  if (error || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식이에요.' }) };
  }

  let context = {
    message: body.message || '',
    category: body.category || null,
    buyer_name_masked: body.buyer_name_masked || null,
    product_title: body.product_title || null,
    courier: body.courier || null,
    tracking_number: body.tracking_number || null,
  };

  // thread_id 있으면 DB 컨텍스트 보강
  let admin = null;
  try { admin = getAdminClient(); } catch { /* */ }
  if (admin && body.thread_id) {
    const { data: thread } = await admin
      .from('cs_threads')
      .select('id, seller_id, category, buyer_name_masked, order_id, market, market_order_id')
      .eq('id', body.thread_id)
      .eq('seller_id', payload.seller_id)
      .single();
    if (!thread) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '문의를 찾을 수 없어요.' }) };
    }
    // 메시지 동봉
    const { data: msgs } = await admin
      .from('cs_messages')
      .select('content, sender_type')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: true });
    const buyerLast = (msgs || []).filter((m) => m.sender_type === 'buyer').slice(-1)[0]?.content;
    context.message = context.message || buyerLast || '';
    context.category = context.category || thread.category;
    context.buyer_name_masked = context.buyer_name_masked || thread.buyer_name_masked;

    if (thread.order_id) {
      const { data: order } = await admin
        .from('orders')
        .select('product_title, courier_code, tracking_number')
        .eq('id', thread.order_id)
        .single();
      if (order) {
        context.product_title = context.product_title || order.product_title;
        context.tracking_number = context.tracking_number || order.tracking_number;
        if (order.courier_code) {
          const { getCourier } = require('./_shared/courier-codes');
          const c = getCourier(order.courier_code);
          context.courier = context.courier || c?.display_name || order.courier_code;
        }
      }
    }
  }

  if (!context.message) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '문의 내용이 필요해요.' }) };
  }

  const result = await suggestReply({ ...context, mock: undefined });

  // thread_id 있으면 ai_suggested_response 저장
  if (admin && body.thread_id) {
    await admin.from('cs_threads').update({
      ai_suggested_response: result.response,
      ai_confidence: result.confidence,
      ai_generated_at: new Date().toISOString(),
      ai_model: result.model,
    }).eq('id', body.thread_id);
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      ...result,
    }),
  };
};
