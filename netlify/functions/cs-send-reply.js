// CS 답변 전송 — Sprint 3
// POST /api/cs-send-reply
// Body: { thread_id, content }  또는 일괄 { items: [{ thread_id, content }] }
//
// 동작:
// 1. cs_threads + 셀러 검증
// 2. 마켓 어댑터.sendCsReply 호출
// 3. 실패 시 retry_queue 적재
// 4. cs_messages insert + cs_threads 갱신

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { translateMarketError } = require('./_shared/market-errors');
const retryEngine = require('./_shared/retry-engine');
const coupangOrders = require('./_shared/market-adapters/coupang-orders-adapter');
const naverOrders = require('./_shared/market-adapters/naver-orders-adapter');

const ADAPTERS = { coupang: coupangOrders, naver: naverOrders };

async function processOne(admin, sellerId, item, mock) {
  if (!item.thread_id || !item.content || String(item.content).trim().length < 2) {
    return { thread_id: item.thread_id, success: false, error: '답변 내용을 입력해주세요.' };
  }
  let thread = null;
  if (admin) {
    const { data, error } = await admin
      .from('cs_threads')
      .select('id, seller_id, market, market_thread_id, status')
      .eq('id', item.thread_id)
      .eq('seller_id', sellerId)
      .single();
    if (error || !data) {
      return { thread_id: item.thread_id, success: false, error: '문의를 찾을 수 없어요.' };
    }
    thread = data;
  } else {
    thread = { id: item.thread_id, seller_id: sellerId, market: item.market || 'coupang', market_thread_id: item.market_thread_id || `CP_CS_${item.thread_id}`, status: 'pending' };
  }

  const adapter = ADAPTERS[thread.market];
  if (!adapter) {
    return { thread_id: thread.id, success: false, error: '지원하지 않는 마켓이에요.' };
  }

  let creds = null;
  if (admin) {
    const { data } = await admin
      .from('market_credentials')
      .select('credentials_encrypted, access_token_encrypted, token_expires_at, market_seller_id')
      .eq('seller_id', sellerId)
      .eq('market', thread.market)
      .single();
    creds = data || null;
  }

  const result = await adapter.sendCsReply({
    market_thread_id: thread.market_thread_id,
    content: String(item.content).trim(),
    credentials: creds?.credentials_encrypted,
    access_token_encrypted: creds?.access_token_encrypted,
    token_expires_at: creds?.token_expires_at,
    market_seller_id: creds?.market_seller_id,
    mock,
  });

  if (admin) {
    if (result.ok) {
      // cs_messages 기록 + thread 갱신
      await admin.from('cs_messages').insert({
        thread_id: thread.id,
        sender_type: 'seller',
        content: String(item.content).trim(),
        metadata: { market_response_id: result.market_response_id || null, mocked: !!result.mocked },
      });
      await admin.from('cs_threads').update({
        status: 'resolved',
        seller_response: String(item.content).trim(),
        responded_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
      }).eq('id', thread.id);
    } else if (result.retryable) {
      await retryEngine.enqueue(admin, {
        seller_id: sellerId,
        task_type: 'cs_response',
        market: thread.market,
        payload: { thread_id: thread.id, content: String(item.content).trim() },
        last_error: { message: result.error, status: result.status },
      });
    }
  }

  const friendly = result.ok ? null : translateMarketError(thread.market, result.status || 500, result.error);
  return {
    thread_id: thread.id,
    success: !!result.ok,
    market: thread.market,
    mocked: !!result.mocked,
    error: friendly,
  };
}

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

  const items = Array.isArray(body.items) && body.items.length > 0
    ? body.items
    : (body.thread_id ? [{ thread_id: body.thread_id, content: body.content }] : []);
  if (items.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '입력값이 없어요.' }) };
  }
  if (items.length > 100) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '한 번에 최대 100건까지 처리할 수 있어요.' }) };
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  const adapterMock = (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  let admin = null;
  try { admin = getAdminClient(); } catch {
    if (!isSignupMock) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
    }
  }

  const results = [];
  for (const item of items) {
    results.push(await processOne(admin, payload.seller_id, item, adapterMock));
  }

  if (admin) {
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'cs_send_reply',
      resource_type: 'cs_threads',
      resource_id: items.map((i) => i.thread_id).join(','),
      metadata: { count: items.length, success: results.filter((r) => r.success).length },
      event,
    });
  }

  console.log(`[cs-send-reply] seller=${payload.seller_id.slice(0,8)} count=${items.length} success=${results.filter((r)=>r.success).length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: results.some((r) => r.success),
      total: results.length,
      results,
      mocked: adapterMock || isSignupMock,
    }),
  };
};
