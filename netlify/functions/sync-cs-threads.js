// CS 문의 자동 수집 — Sprint 3 (cron 또는 수동)
// POST /api/sync-cs-threads
// Body: { since_minutes? }
// 동작: 마켓별 어댑터.fetchCsThreads → cs_threads upsert + cs_messages insert
//       AI 답변 자동 생성 (suggester) → ai_suggested_response 저장

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { maskName } = require('./_shared/privacy-mask');
const { suggestReply, classifyCategory } = require('./_shared/cs-suggester');
const coupangOrders = require('./_shared/market-adapters/coupang-orders-adapter');
const naverOrders = require('./_shared/market-adapters/naver-orders-adapter');

const ADAPTERS = { coupang: coupangOrders, naver: naverOrders };

async function syncForSeller(admin, seller, sinceMinutes, mock) {
  const sinceDate = new Date(Date.now() - sinceMinutes * 60 * 1000);
  const collected = [];

  let credsByMarket = {};
  if (admin) {
    const { data } = await admin
      .from('market_credentials')
      .select('market, credentials_encrypted, access_token_encrypted, token_expires_at, market_seller_id, market_store_name, verified')
      .eq('seller_id', seller.id);
    if (Array.isArray(data)) {
      for (const c of data) credsByMarket[c.market] = c;
    }
  }

  for (const market of Object.keys(ADAPTERS)) {
    const creds = credsByMarket[market];
    if (!creds && !mock) continue;
    const adapter = ADAPTERS[market];
    const result = await adapter.fetchCsThreads({
      credentials: creds?.credentials_encrypted,
      access_token_encrypted: creds?.access_token_encrypted,
      token_expires_at: creds?.token_expires_at,
      market_seller_id: creds?.market_seller_id,
      since: sinceDate,
      mock,
    });
    if (!result.ok) {
      collected.push({ market, ok: false, count: 0, error: result.error });
      continue;
    }

    let inserted = 0;
    for (const t of result.threads) {
      const buyerMasked = maskName(t.buyer_name || '');
      const preview = t.preview_text || (t.messages?.[0]?.content || '').slice(0, 120);
      const category = classifyCategory(preview || '');

      // upsert cs_threads
      let threadRow;
      if (admin) {
        // 매칭되는 order_id 찾기 (있으면 연결)
        let orderId = null;
        if (t.market_order_id) {
          const { data: order } = await admin
            .from('marketplace_orders')
            .select('id')
            .eq('seller_id', seller.id)
            .eq('market', market)
            .eq('market_order_id', t.market_order_id)
            .single();
          orderId = order?.id || null;
        }

        const { data: upserted, error } = await admin
          .from('cs_threads')
          .upsert({
            seller_id: seller.id,
            market,
            market_thread_id: t.market_thread_id,
            order_id: orderId,
            market_order_id: t.market_order_id || null,
            buyer_name_masked: buyerMasked,
            category,
            status: 'pending',
            preview_text: preview,
          }, { onConflict: 'market,market_thread_id', ignoreDuplicates: false })
          .select('id, ai_suggested_response')
          .single();
        if (error) {
          console.error('[sync-cs-threads] upsert error:', error.message);
          continue;
        }
        threadRow = upserted;

        // 메시지 insert (멱등 보장 약함, 같은 content+thread는 중복될 수 있음 — 운영에서는 메시지 ID 키 추가)
        for (const msg of t.messages || []) {
          await admin.from('cs_messages').insert({
            thread_id: threadRow.id,
            sender_type: msg.sender_type || 'buyer',
            content: msg.content,
            metadata: { source_raw: msg.raw || null },
          });
        }

        // AI 답변 자동 생성 (없을 때만)
        if (!threadRow.ai_suggested_response) {
          const ai = await suggestReply({
            message: preview,
            category,
            buyer_name_masked: buyerMasked,
            mock,
          });
          await admin.from('cs_threads').update({
            ai_suggested_response: ai.response,
            ai_confidence: ai.confidence,
            ai_generated_at: new Date().toISOString(),
            ai_model: ai.model,
          }).eq('id', threadRow.id);
        }
      }
      inserted += 1;
    }
    collected.push({ market, ok: true, count: inserted, mocked: !!result.mocked });
  }

  if (admin) {
    await recordAudit(admin, {
      actor_id: seller.id,
      actor_type: 'system',
      action: 'cs_threads_sync',
      resource_type: 'seller',
      resource_id: seller.id,
      metadata: { results: collected, since_minutes: sinceMinutes },
    });
  }
  return collected;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const cronSecret = (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'] || '').trim();
  let sellerId = null;
  if (cronSecret && cronSecret === (process.env.CRON_SECRET || '')) {
    // cron mode
  } else {
    const { payload, error } = verifySellerToken(token);
    if (error || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
    }
    sellerId = payload.seller_id;
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const sinceMinutes = Math.max(1, Math.min(60 * 24, Number(body.since_minutes || 60)));
  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  const adapterMock = (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  let admin = null;
  try { admin = getAdminClient(); } catch {
    if (!isSignupMock) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
    }
  }

  let sellers = [];
  if (admin) {
    if (sellerId) {
      const { data } = await admin.from('sellers').select('id, store_name').eq('id', sellerId).limit(1);
      sellers = data || [];
    } else {
      const { data } = await admin.from('sellers').select('id, store_name').limit(500);
      sellers = data || [];
    }
  } else {
    sellers = [{ id: sellerId || '00000000-0000-0000-0000-000000000001', store_name: '모킹 상점' }];
  }

  const summary = [];
  for (const seller of sellers) {
    const results = await syncForSeller(admin, seller, sinceMinutes, adapterMock);
    summary.push({ seller_id: seller.id, results, total_synced: results.reduce((a, r) => a + (r.count || 0), 0) });
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, sellers: sellers.length, mocked: adapterMock, summary }),
  };
};
