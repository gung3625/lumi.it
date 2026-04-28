// 상품 부분 수정 — Sprint 5 기본기
// POST /api/update-product
// Body: { productId, fields: { title?, description?, price?, options?, keywords? }, marketplaces?: [] }
//
// 동작:
// 1. 셀러 JWT 검증
// 2. fields 4단 매핑 검증 (변경된 필드만)
// 3. products 테이블 갱신
// 4. product_market_registrations 매핑 → 마켓 어댑터 updateProduct 호출
// 5. 결과 마켓별 회신

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { translateMarketError } = require('./_shared/market-errors');
const { checkPolicyWords } = require('./_shared/policy-words');
const { tryAcquire } = require('./_shared/throttle');
const retryEngine = require('./_shared/retry-engine');
const coupangOrders = require('./_shared/market-adapters/coupang-orders-adapter');
const naverOrders = require('./_shared/market-adapters/naver-orders-adapter');

const ADAPTERS = { coupang: coupangOrders, naver: naverOrders };
const SUPPORTED_MARKETS = new Set(Object.keys(ADAPTERS));

// 화이트리스트: 변경 가능한 필드
const ALLOWED_FIELDS = new Set(['title', 'description', 'price', 'options', 'keywords']);

const MIN_PRICE = 100;
const MAX_PRICE = 10_000_000;

function adapterMockEnabled() {
  return (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';
}

/**
 * 4단 매핑 검증 — 변경 필드만
 */
function validateFields(fields) {
  const errors = [];
  if ('title' in fields) {
    const t = String(fields.title || '').trim();
    if (t.length < 2) errors.push('title은 2자 이상이어야 해요.');
    if (t.length > 100) errors.push('title은 100자를 넘을 수 없어요.');
  }
  if ('description' in fields) {
    const d = String(fields.description || '');
    if (d.length > 5000) errors.push('description은 5000자를 넘을 수 없어요.');
  }
  if ('price' in fields) {
    const p = Number(fields.price);
    if (!Number.isFinite(p)) errors.push('price는 숫자여야 해요.');
    else if (p < MIN_PRICE || p > MAX_PRICE) errors.push(`price는 ${MIN_PRICE}원 ~ ${MAX_PRICE}원 범위여야 해요.`);
  }
  if ('options' in fields) {
    if (!Array.isArray(fields.options)) errors.push('options는 배열이어야 해요.');
    else if (fields.options.length > 100) errors.push('options 조합은 100개를 넘을 수 없어요.');
  }
  if ('keywords' in fields) {
    if (!Array.isArray(fields.keywords)) errors.push('keywords는 배열이어야 해요.');
    else if (fields.keywords.length > 20) errors.push('keywords는 20개를 넘을 수 없어요.');
  }
  return errors;
}

/**
 * 화이트리스트 외 필드 제거
 */
function pickAllowedFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (ALLOWED_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

async function updateOneMarket({ admin, sellerId, productId, market, marketProductId, fields, mock, creds }) {
  const throttle = tryAcquire(market, creds?.market_seller_id);
  if (!throttle.allowed) {
    return { market, ok: false, error: '잠시 후 다시 시도해주세요.', retryable: true, status: 429 };
  }
  const adapter = ADAPTERS[market];
  if (!adapter) return { market, ok: false, error: '지원하지 않는 마켓이에요.', retryable: false };

  const result = await adapter.updateProduct({
    market_product_id: marketProductId,
    fields,
    credentials: creds?.credentials_encrypted,
    access_token_encrypted: creds?.access_token_encrypted,
    token_expires_at: creds?.token_expires_at,
    market_seller_id: creds?.market_seller_id,
    mock,
  });

  if (admin && !result.ok && result.retryable) {
    await retryEngine.enqueue(admin, {
      seller_id: sellerId,
      task_type: 'update_product',
      market,
      payload: { product_id: productId, market_product_id: marketProductId, fields },
      last_error: { message: result.error, status: result.status },
    });
  }

  const friendly = result.ok ? null : translateMarketError(market, result.status || 500, result.error);
  return {
    market,
    ok: !!result.ok,
    fields_updated: result.fields_updated || Object.keys(fields),
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

  const fields = pickAllowedFields(body.fields || {});
  if (Object.keys(fields).length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '수정할 필드가 없어요.' }) };
  }

  const errors = validateFields(fields);
  if (errors.length > 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: errors.join(' / ') }) };
  }

  const requestedMarkets = Array.isArray(body.marketplaces) && body.marketplaces.length > 0
    ? body.marketplaces.filter((m) => SUPPORTED_MARKETS.has(m))
    : Array.from(SUPPORTED_MARKETS);

  // 정책 단어 검사 (title 변경 시)
  let policyWarnings = [];
  if ('title' in fields) {
    policyWarnings = checkPolicyWords(String(fields.title), requestedMarkets);
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  const mock = adapterMockEnabled();
  let admin = null;
  try { admin = getAdminClient(); } catch {
    if (!isSignupMock) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
    }
  }

  // 상품 소유자 검증
  let product = null;
  if (admin) {
    const { data, error: pErr } = await admin
      .from('products')
      .select('id, title, price_suggested')
      .eq('id', productId)
      .eq('seller_id', payload.seller_id)
      .single();
    if (pErr || !data) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '상품을 찾을 수 없어요.' }) };
    }
    product = data;
  } else {
    product = { id: productId, title: 'mock', price_suggested: 10000 };
  }

  // products 테이블 부분 갱신 (DB 컬럼 매핑)
  if (admin) {
    const dbUpdate = { updated_at: new Date().toISOString() };
    if ('title' in fields) dbUpdate.title = String(fields.title).trim();
    if ('description' in fields) dbUpdate.description = String(fields.description || '');
    if ('price' in fields) dbUpdate.price_suggested = Math.trunc(Number(fields.price));
    if ('keywords' in fields) dbUpdate.keywords = fields.keywords;
    // policy_warnings 갱신
    if ('title' in fields) dbUpdate.policy_warnings = policyWarnings;
    const { error: uErr } = await admin
      .from('products')
      .update(dbUpdate)
      .eq('id', productId)
      .eq('seller_id', payload.seller_id);
    if (uErr) {
      console.error('[update-product] products update error:', uErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상품 정보를 갱신하지 못했어요.' }) };
    }
  }

  // 마켓 매핑 + 자격증명
  const registrationsByMarket = {};
  const credentialsByMarket = {};
  if (admin) {
    const { data: regs } = await admin
      .from('product_market_registrations')
      .select('market, market_product_id')
      .eq('seller_id', payload.seller_id)
      .eq('product_id', productId)
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

  const tasks = requestedMarkets.map((market) => {
    const reg = registrationsByMarket[market];
    const creds = credentialsByMarket[market];
    if (!reg || !reg.market_product_id) {
      return Promise.resolve({ market, ok: false, error: { title: '등록 정보 없음', cause: '이 상품이 해당 마켓에 등록되어 있지 않아요.', action: '마켓에 먼저 등록해주세요.', statusCode: 404 } });
    }
    if (!creds && !mock) {
      return Promise.resolve({ market, ok: false, error: { title: '연결 정보 없음', cause: '이 마켓 자격증명이 없어요.', action: '연결 페이지에서 다시 연결해주세요.', statusCode: 401 } });
    }
    return updateOneMarket({
      admin,
      sellerId: payload.seller_id,
      productId,
      market,
      marketProductId: reg.market_product_id,
      fields,
      mock,
      creds,
    });
  });

  const settled = await Promise.all(tasks);
  const resultsByMarket = {};
  for (const r of settled) resultsByMarket[r.market] = { ok: r.ok, fields_updated: r.fields_updated, mocked: r.mocked, error: r.error, retryable: r.retryable };

  if (admin) {
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'update_product',
      resource_type: 'product',
      resource_id: productId,
      metadata: {
        fields_changed: Object.keys(fields),
        marketplaces: requestedMarkets,
        success: settled.filter((r) => r.ok).length,
        total: settled.length,
        policy_warnings: policyWarnings.length,
      },
      event,
    });
  }

  console.log(`[update-product] seller=${payload.seller_id.slice(0,8)} product=${productId.slice(0,8)} fields=${Object.keys(fields).join(',')} success=${settled.filter((r)=>r.ok).length}/${settled.length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: settled.some((r) => r.ok),
      productId,
      fields_changed: Object.keys(fields),
      policy_warnings: policyWarnings,
      results: resultsByMarket,
      mocked: mock || !admin,
    }),
  };
};
