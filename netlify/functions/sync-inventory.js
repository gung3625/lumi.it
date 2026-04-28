// 재고 동기화 (풀) — Sprint 5 기본기
// POST /api/sync-inventory
// Body: { productId, marketplaces?: ['coupang','naver'], delta?, absolute? }
//
// 동작:
// 1. 셀러 JWT 검증
// 2. product_market_registrations 조회 → 마켓별 market_product_id 매핑
// 3. delta = 가산/차감, absolute = 절대값 셋업
// 4. 마켓별 어댑터 syncInventory 병렬 호출 (throttle 통과 시)
// 5. 실패 시 retry_queue 적재, inventory_movements 기록
// 6. 결과: { coupang: {ok, quantity}, naver: {ok, quantity} }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { translateMarketError } = require('./_shared/market-errors');
const { tryAcquire } = require('./_shared/throttle');
const retryEngine = require('./_shared/retry-engine');
const { recordMovement } = require('./_shared/inventory-engine');
const coupangOrders = require('./_shared/market-adapters/coupang-orders-adapter');
const naverOrders = require('./_shared/market-adapters/naver-orders-adapter');

const ADAPTERS = { coupang: coupangOrders, naver: naverOrders };
const SUPPORTED_MARKETS = new Set(Object.keys(ADAPTERS));

function adapterMockEnabled() {
  return (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';
}

async function syncOne({ admin, sellerId, productId, market, marketProductId, targetQuantity, delta, mock, creds }) {
  // throttle
  const throttle = tryAcquire(market, creds?.market_seller_id);
  if (!throttle.allowed) {
    return { market, ok: false, error: '잠시 후 다시 시도해주세요.', retryable: true, status: 429 };
  }
  const adapter = ADAPTERS[market];
  if (!adapter) return { market, ok: false, error: '지원하지 않는 마켓이에요.', retryable: false };

  const result = await adapter.syncInventory({
    market_product_id: marketProductId,
    quantity: targetQuantity,
    credentials: creds?.credentials_encrypted,
    access_token_encrypted: creds?.access_token_encrypted,
    token_expires_at: creds?.token_expires_at,
    market_seller_id: creds?.market_seller_id,
    mock,
  });

  if (admin && !result.ok && result.retryable) {
    await retryEngine.enqueue(admin, {
      seller_id: sellerId,
      task_type: 'stock_sync',
      market,
      payload: { product_id: productId, market_product_id: marketProductId, target_quantity: targetQuantity },
      last_error: { message: result.error, status: result.status },
    });
  }

  if (admin && result.ok && Number.isFinite(delta) && delta !== 0) {
    await recordMovement(admin, {
      seller_id: sellerId,
      product_id: productId,
      market,
      movement_type: 'sync',
      quantity_delta: Math.trunc(delta),
      reference_type: 'sync_inventory',
      reference_id: productId,
      note: `재고 동기화 (${delta > 0 ? '+' : ''}${delta})`,
    });
  }

  const friendly = result.ok ? null : translateMarketError(market, result.status || 500, result.error);
  return {
    market,
    ok: !!result.ok,
    quantity: result.ok ? targetQuantity : null,
    mocked: !!result.mocked,
    error: friendly,
    retryable: !!result.retryable,
  };
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식이에요.' }) };
  }

  const productId = String(body.productId || body.product_id || '').trim();
  if (!productId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '상품 ID가 필요해요.' }) };
  }

  const requestedMarkets = Array.isArray(body.marketplaces) && body.marketplaces.length > 0
    ? body.marketplaces.filter((m) => SUPPORTED_MARKETS.has(m))
    : Array.from(SUPPORTED_MARKETS);
  if (requestedMarkets.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '지원하는 마켓을 1개 이상 지정해주세요.' }) };
  }

  // delta 또는 absolute 둘 중 하나만
  const hasDelta = Number.isFinite(Number(body.delta));
  const hasAbsolute = Number.isFinite(Number(body.absolute));
  if (!hasDelta && !hasAbsolute) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'delta 또는 absolute 값이 필요해요.' }) };
  }
  if (hasDelta && hasAbsolute) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'delta와 absolute는 동시에 지정할 수 없어요.' }) };
  }
  const delta = hasDelta ? Math.trunc(Number(body.delta)) : 0;
  const absoluteValue = hasAbsolute ? Math.trunc(Number(body.absolute)) : null;
  if (absoluteValue !== null && absoluteValue < 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '재고 절대값은 0 이상이어야 해요.' }) };
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  const mock = adapterMockEnabled();
  let admin = null;
  try { admin = getAdminClient(); } catch {
    if (!isSignupMock) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
    }
  }

  // 매핑 + 자격증명 조회
  const registrationsByMarket = {};
  const credentialsByMarket = {};
  if (admin) {
    const { data: regs } = await admin
      .from('product_market_registrations')
      .select('market, market_product_id, status')
      .eq('product_id', productId)
      .eq('seller_id', payload.seller_id)
      .in('market', requestedMarkets);
    if (Array.isArray(regs)) {
      for (const r of regs) registrationsByMarket[r.market] = r;
    }

    const { data: creds } = await admin
      .from('market_credentials')
      .select('market, credentials_encrypted, access_token_encrypted, token_expires_at, market_seller_id')
      .eq('seller_id', payload.seller_id)
      .in('market', requestedMarkets);
    if (Array.isArray(creds)) {
      for (const c of creds) credentialsByMarket[c.market] = c;
    }
  }

  // 절대값 모드: 모든 마켓에 동일 값.
  // delta 모드: 현재 재고를 모르므로 어댑터 제약상 absolute로 변환 불가 → 셀러에게 명시.
  // 정책: delta는 inventory_movements 기록만 + 어댑터에는 absolute 전달 (target = absoluteValue)
  // delta-only 모드에서는 마켓 어댑터 호출 X (movements만 기록) — Phase 1.5 마켓 reconcile cron이 처리
  const deltaOnly = hasDelta && !hasAbsolute;
  if (deltaOnly) {
    // 마켓 호출 없이 movements 만
    if (admin) {
      await recordMovement(admin, {
        seller_id: payload.seller_id,
        product_id: productId,
        market: null,
        movement_type: 'manual',
        quantity_delta: delta,
        reference_type: 'sync_inventory_delta',
        reference_id: productId,
        note: `delta ${delta > 0 ? '+' : ''}${delta} (마켓 미반영, reconcile cron 대기)`,
      });
      await recordAudit(admin, {
        actor_id: payload.seller_id,
        actor_type: 'seller',
        action: 'sync_inventory_delta',
        resource_type: 'product',
        resource_id: productId,
        metadata: { delta, marketplaces: requestedMarkets },
        event,
      });
    }
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        productId,
        mode: 'delta',
        delta,
        message: 'delta는 내부 재고 장부에만 반영됐어요. 마켓 절대값 동기화는 absolute 값으로 다시 호출해주세요.',
        results: {},
        mocked: !admin,
      }),
    };
  }

  // absolute 모드 — 마켓별 병렬 호출
  const tasks = requestedMarkets.map((market) => {
    const reg = registrationsByMarket[market];
    const creds = credentialsByMarket[market];
    if (!reg || !reg.market_product_id) {
      return Promise.resolve({ market, ok: false, error: { title: '등록 정보 없음', cause: '이 상품이 해당 마켓에 등록되어 있지 않아요.', action: '마켓에 먼저 등록해주세요.', statusCode: 404 } });
    }
    if (!creds && !mock) {
      return Promise.resolve({ market, ok: false, error: { title: '연결 정보 없음', cause: '이 마켓 자격증명이 없어요.', action: '연결 페이지에서 다시 연결해주세요.', statusCode: 401 } });
    }
    return syncOne({
      admin,
      sellerId: payload.seller_id,
      productId,
      market,
      marketProductId: reg.market_product_id,
      targetQuantity: absoluteValue,
      delta,
      mock,
      creds,
    });
  });

  const settled = await Promise.all(tasks);
  const resultsByMarket = {};
  for (const r of settled) resultsByMarket[r.market] = { ok: r.ok, quantity: r.quantity, mocked: r.mocked, error: r.error, retryable: r.retryable };

  if (admin) {
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'sync_inventory',
      resource_type: 'product',
      resource_id: productId,
      metadata: {
        marketplaces: requestedMarkets,
        absolute: absoluteValue,
        success: settled.filter((r) => r.ok).length,
        total: settled.length,
      },
      event,
    });
  }

  console.log(`[sync-inventory] seller=${payload.seller_id.slice(0,8)} product=${productId.slice(0,8)} markets=${requestedMarkets.join(',')} abs=${absoluteValue} success=${settled.filter((r)=>r.ok).length}/${settled.length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: settled.some((r) => r.ok),
      productId,
      mode: 'absolute',
      absolute: absoluteValue,
      results: resultsByMarket,
      mocked: mock || !admin,
    }),
  };
};
