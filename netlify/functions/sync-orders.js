// 주문 수집 — Sprint 3 (Inbound: 마켓 → 루미)
// POST /api/sync-orders  (cron 또는 수동 트리거)
// Body: { seller_id?, since? } — seller_id 미지정 시 모든 셀러 (cron용)
//
// 동작:
// 1. seller(s) 조회 + market_credentials 조회
// 2. 마켓별 어댑터 fetchNewOrders 호출
// 3. orders 테이블 upsert (UNIQUE market+market_order_id로 중복 방지)
// 4. inventory_movements 차감 기록
// 5. 셀러용 알림 hooks (push/email — Phase 1.5)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { maskBuyerFields } = require('./_shared/privacy-mask');
const { deductStockForSale } = require('./_shared/inventory-engine');
const coupangOrders = require('./_shared/market-adapters/coupang-orders-adapter');
const naverOrders = require('./_shared/market-adapters/naver-orders-adapter');

const ADAPTERS = {
  coupang: coupangOrders,
  naver: naverOrders,
};

async function syncForSeller(admin, seller, sinceMinutes, mock) {
  const sinceDate = new Date(Date.now() - sinceMinutes * 60 * 1000);
  const collected = [];

  // 셀러 자격증명 조회
  const { data: credsRows } = await admin
    ? await admin
        .from('market_credentials')
        .select('market, credentials_encrypted, access_token_encrypted, token_expires_at, market_seller_id, market_store_name, verified')
        .eq('seller_id', seller.id)
    : { data: [] };
  const credsByMarket = {};
  if (Array.isArray(credsRows)) {
    for (const c of credsRows) credsByMarket[c.market] = c;
  }

  for (const market of Object.keys(ADAPTERS)) {
    const creds = credsByMarket[market];
    // 모킹 모드에서는 자격증명 없어도 진행
    if (!creds && !mock) continue;

    const adapter = ADAPTERS[market];
    const result = await adapter.fetchNewOrders({
      credentials: creds?.credentials_encrypted,
      access_token_encrypted: creds?.access_token_encrypted,
      token_expires_at: creds?.token_expires_at,
      market_seller_id: creds?.market_seller_id,
      store_id: creds?.market_store_name,
      since: sinceDate,
      mock,
    });

    if (!result.ok) {
      collected.push({ market, ok: false, count: 0, error: result.error });
      continue;
    }

    let inserted = 0;
    let skipped = 0;
    for (const raw of result.orders) {
      const masked = maskBuyerFields(raw);
      const row = {
        seller_id: seller.id,
        market: raw.market,
        market_order_id: raw.market_order_id,
        market_product_id: raw.market_product_id || null,
        product_title: raw.product_title || null,
        quantity: raw.quantity || 1,
        total_price: raw.total_price || 0,
        option_text: raw.option_text || null,
        status: raw.status || 'paid',
        ...masked,
        raw_payload: raw.raw || null,
      };

      if (!admin) {
        // 모킹: DB 미사용
        inserted += 1;
        continue;
      }

      const { error } = await admin.from('orders').upsert(row, {
        onConflict: 'market,market_order_id',
        ignoreDuplicates: true,
      });
      if (error) {
        console.error('[sync-orders] upsert error:', error.message);
        skipped += 1;
        continue;
      }
      inserted += 1;

      // 재고 차감 기록 (sale)
      if (row.status === 'paid') {
        const { data: orderRow } = await admin
          .from('orders')
          .select('id, product_id, quantity')
          .eq('market', raw.market)
          .eq('market_order_id', raw.market_order_id)
          .single();
        if (orderRow) {
          await deductStockForSale(admin, {
            id: orderRow.id,
            seller_id: seller.id,
            product_id: orderRow.product_id,
            market: raw.market,
            quantity: orderRow.quantity,
          });
        }
      }
    }

    collected.push({ market, ok: true, count: inserted, skipped, mocked: !!result.mocked });
  }

  if (admin) {
    await recordAudit(admin, {
      actor_id: seller.id,
      actor_type: 'system',
      action: 'orders_sync',
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

  // 인증: 셀러 JWT 또는 cron secret
  const token = extractBearerToken(event);
  const cronSecret = (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'] || '').trim();
  let sellerId = null;
  if (cronSecret && cronSecret === (process.env.CRON_SECRET || '')) {
    // cron 모드 — 모든 셀러
  } else {
    const { payload, error } = verifySellerToken(token);
    if (error || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
    }
    sellerId = payload.seller_id;
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const sinceMinutes = Math.max(1, Math.min(60 * 24, Number(body.since_minutes || 15)));
  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  const adapterMock = (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  let admin = null;
  try {
    admin = getAdminClient();
  } catch {
    if (!isSignupMock) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
    }
  }

  // 1셀러 또는 전체 셀러
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
    // 모킹
    sellers = [{ id: sellerId || '00000000-0000-0000-0000-000000000001', store_name: '모킹 상점' }];
  }

  const summary = [];
  for (const seller of sellers) {
    const results = await syncForSeller(admin, seller, sinceMinutes, adapterMock);
    summary.push({
      seller_id: seller.id,
      results,
      total_synced: results.reduce((acc, r) => acc + (r.count || 0), 0),
    });
  }

  console.log(`[sync-orders] sellers=${sellers.length} total=${summary.reduce((a, s) => a + s.total_synced, 0)}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      sellers: sellers.length,
      since_minutes: sinceMinutes,
      mocked: adapterMock,
      summary,
    }),
  };
};
