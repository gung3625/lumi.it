// 가격 일괄 변경 — Sprint 5 기본기
// POST /api/bulk-update-price
// Body: { productIds: [], operation: 'set'|'add'|'subtract'|'multiply', value, marketplaces?: [] }
//
// 동작:
// 1. 셀러 JWT 검증
// 2. products 테이블 조회 → 현재 price_suggested 가져오기
// 3. operation 적용 → 새 가격 계산
// 4. product_market_registrations 매핑 → 마켓 어댑터 updatePrice 호출
// 5. Throttle + retry_queue
// 6. Audit Log 모든 변경 기록
// 7. 결과: per-product per-market

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { translateMarketError } = require('./_shared/market-errors');
const { tryAcquire } = require('./_shared/throttle');
const retryEngine = require('./_shared/retry-engine');
const coupangOrders = require('./_shared/market-adapters/coupang-orders-adapter');
const naverOrders = require('./_shared/market-adapters/naver-orders-adapter');

const ADAPTERS = { coupang: coupangOrders, naver: naverOrders };
const SUPPORTED_MARKETS = new Set(Object.keys(ADAPTERS));
const VALID_OPERATIONS = new Set(['set', 'add', 'subtract', 'multiply']);

const MAX_PRODUCTS_PER_REQUEST = 200;
const MIN_PRICE = 100; // 100원 미만 자동 거부 (마켓 정책 위반 방지)
const MAX_PRICE = 10_000_000; // 1천만원 상한 (실수 방지)

function adapterMockEnabled() {
  return (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';
}

/**
 * operation 적용 → 새 가격 계산
 */
function computeNewPrice(currentPrice, operation, value) {
  const cur = Number(currentPrice) || 0;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  let next;
  switch (operation) {
    case 'set': next = v; break;
    case 'add': next = cur + v; break;
    case 'subtract': next = cur - v; break;
    case 'multiply': next = cur * v; break;
    default: return null;
  }
  return Math.max(0, Math.trunc(next));
}

async function updatePriceForMarket({ admin, sellerId, productId, market, marketProductId, newPrice, mock, creds }) {
  const throttle = tryAcquire(market, creds?.market_seller_id);
  if (!throttle.allowed) {
    return { market, ok: false, error: '잠시 후 다시 시도해주세요.', retryable: true, status: 429 };
  }
  const adapter = ADAPTERS[market];
  if (!adapter) return { market, ok: false, error: '지원하지 않는 마켓이에요.', retryable: false };

  const result = await adapter.updatePrice({
    market_product_id: marketProductId,
    price: newPrice,
    credentials: creds?.credentials_encrypted,
    access_token_encrypted: creds?.access_token_encrypted,
    token_expires_at: creds?.token_expires_at,
    market_seller_id: creds?.market_seller_id,
    mock,
  });

  if (admin && !result.ok && result.retryable) {
    await retryEngine.enqueue(admin, {
      seller_id: sellerId,
      task_type: 'price_update',
      market,
      payload: { product_id: productId, market_product_id: marketProductId, price: newPrice },
      last_error: { message: result.error, status: result.status },
    });
  }

  const friendly = result.ok ? null : translateMarketError(market, result.status || 500, result.error);
  return {
    market,
    ok: !!result.ok,
    new_price: result.ok ? newPrice : null,
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

  const productIds = Array.isArray(body.productIds) ? body.productIds.filter(Boolean).map(String) : [];
  if (productIds.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '상품 ID 목록이 필요해요.' }) };
  }
  if (productIds.length > MAX_PRODUCTS_PER_REQUEST) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `한 번에 최대 ${MAX_PRODUCTS_PER_REQUEST}개까지 변경할 수 있어요.` }) };
  }

  const operation = String(body.operation || '').toLowerCase();
  if (!VALID_OPERATIONS.has(operation)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'operation은 set/add/subtract/multiply 중 하나여야 해요.' }) };
  }
  const value = Number(body.value);
  if (!Number.isFinite(value)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'value는 숫자여야 해요.' }) };
  }
  if (operation === 'multiply' && value < 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'multiply 값은 0 이상이어야 해요.' }) };
  }

  const requestedMarkets = Array.isArray(body.marketplaces) && body.marketplaces.length > 0
    ? body.marketplaces.filter((m) => SUPPORTED_MARKETS.has(m))
    : Array.from(SUPPORTED_MARKETS);
  if (requestedMarkets.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '지원하는 마켓을 1개 이상 지정해주세요.' }) };
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  const mock = adapterMockEnabled();
  let admin = null;
  try { admin = getAdminClient(); } catch {
    if (!isSignupMock) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
    }
  }

  // 1. 상품 조회
  let products = [];
  if (admin) {
    const { data, error: pErr } = await admin
      .from('products')
      .select('id, title, price_suggested')
      .eq('seller_id', payload.seller_id)
      .in('id', productIds);
    if (pErr) {
      console.error('[bulk-update-price] products select error:', pErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상품을 불러오지 못했어요.' }) };
    }
    products = data || [];
  } else {
    // 모킹: 가상 product 생성
    products = productIds.map((id) => ({ id, title: `mock_${id}`, price_suggested: 10000 }));
  }

  if (products.length === 0) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '대상 상품을 찾을 수 없어요.' }) };
  }

  // 2. 매핑 + 자격증명 조회 (전체)
  const registrationsByProductMarket = {};
  const credentialsByMarket = {};
  if (admin) {
    const { data: regs } = await admin
      .from('product_market_registrations')
      .select('product_id, market, market_product_id')
      .eq('seller_id', payload.seller_id)
      .in('product_id', productIds)
      .in('market', requestedMarkets);
    if (Array.isArray(regs)) {
      for (const r of regs) registrationsByProductMarket[`${r.product_id}:${r.market}`] = r;
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

  // 3. 상품별 처리 (순차 — Rate Limit 안전)
  const results = [];
  for (const product of products) {
    const newPrice = computeNewPrice(product.price_suggested, operation, value);
    if (newPrice === null || newPrice < MIN_PRICE || newPrice > MAX_PRICE) {
      results.push({
        product_id: product.id,
        title: product.title,
        old_price: product.price_suggested,
        new_price: newPrice,
        skipped: true,
        reason: newPrice === null ? '가격 계산 실패' : `${MIN_PRICE}원 ~ ${MAX_PRICE}원 범위를 벗어나요.`,
        markets: {},
      });
      continue;
    }

    // products 테이블 갱신
    if (admin) {
      await admin.from('products')
        .update({ price_suggested: newPrice, updated_at: new Date().toISOString() })
        .eq('id', product.id)
        .eq('seller_id', payload.seller_id);
    }

    // 마켓별 호출 (병렬)
    const marketTasks = requestedMarkets.map((market) => {
      const reg = registrationsByProductMarket[`${product.id}:${market}`];
      const creds = credentialsByMarket[market];
      if (!reg || !reg.market_product_id) {
        return Promise.resolve({ market, ok: false, skipped: true, error: { title: '등록 정보 없음', cause: '이 상품이 해당 마켓에 등록되어 있지 않아요.', action: '마켓에 먼저 등록해주세요.', statusCode: 404 } });
      }
      if (!creds && !mock) {
        return Promise.resolve({ market, ok: false, skipped: true, error: { title: '연결 정보 없음', cause: '이 마켓 자격증명이 없어요.', action: '연결 페이지에서 다시 연결해주세요.', statusCode: 401 } });
      }
      return updatePriceForMarket({
        admin,
        sellerId: payload.seller_id,
        productId: product.id,
        market,
        marketProductId: reg.market_product_id,
        newPrice,
        mock,
        creds,
      });
    });
    const marketResults = await Promise.all(marketTasks);
    const marketsByKey = {};
    for (const m of marketResults) marketsByKey[m.market] = { ok: m.ok, new_price: m.new_price, mocked: m.mocked, error: m.error, retryable: m.retryable };

    results.push({
      product_id: product.id,
      title: product.title,
      old_price: product.price_suggested,
      new_price: newPrice,
      skipped: false,
      markets: marketsByKey,
    });
  }

  if (admin) {
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'bulk_update_price',
      resource_type: 'product',
      resource_id: productIds.join(','),
      metadata: {
        operation,
        value,
        marketplaces: requestedMarkets,
        total: products.length,
        success: results.filter((r) => !r.skipped).length,
      },
      event,
    });
  }

  console.log(`[bulk-update-price] seller=${payload.seller_id.slice(0,8)} op=${operation} value=${value} count=${products.length} markets=${requestedMarkets.join(',')}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: results.some((r) => !r.skipped),
      operation,
      value,
      total: products.length,
      results,
      mocked: mock || !admin,
    }),
  };
};
