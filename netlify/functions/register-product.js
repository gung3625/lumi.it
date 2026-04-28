// 첫 상품 등록 — Sprint 2 (Distribution 단계, 셀러 액션 3)
// POST /api/register-product
// Body: { product: LumiProduct, markets: ['coupang','naver'] }
//
// 동작:
// 1. seller JWT + 상품 스키마 검증
// 2. products 테이블 insert
// 3. 마켓별 어댑터 호출 (Throttle 통과 시) — 병렬
// 4. 실패 시 retry_queue 적재
// 5. product_market_registrations 갱신
// 6. 직링크 응답 (Lumi templating)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { validateLumiProduct } = require('./_shared/market-adapters/lumi-product-schema');
const { checkPolicyWords } = require('./_shared/policy-words');
const { tryAcquire, adaptFromHeaders, applyBackoff } = require('./_shared/throttle');
const retryEngine = require('./_shared/retry-engine');
const coupangAdapter = require('./_shared/market-adapters/coupang-adapter');
const naverAdapter = require('./_shared/market-adapters/naver-adapter');
const tossAdapter = require('./_shared/market-adapters/toss-adapter');
const { translateMarketError } = require('./_shared/market-errors');

const SUPPORTED_MARKETS = new Set(['coupang', 'naver', 'toss']);

async function distributeToMarket({ market, lumiProduct, sellerCredentials, store_id, mock }) {
  // Throttle 체크
  const throttle = tryAcquire(market, sellerCredentials?.market_seller_id);
  if (!throttle.allowed) {
    return {
      market,
      success: false,
      error: `호출 한도 도달 (${throttle.retryAfterMs}ms 후 재시도)`,
      retryable: true,
      status: 429,
    };
  }

  try {
    if (market === 'coupang') {
      const result = await coupangAdapter.registerProduct({
        lumiProduct,
        credentials: sellerCredentials?.credentials_encrypted,
        market_seller_id: sellerCredentials?.market_seller_id,
        mock,
      });
      return { market, ...result };
    }
    if (market === 'naver') {
      const result = await naverAdapter.registerProduct({
        lumiProduct,
        credentials: sellerCredentials?.credentials_encrypted,
        access_token_encrypted: sellerCredentials?.access_token_encrypted,
        token_expires_at: sellerCredentials?.token_expires_at,
        market_seller_id: sellerCredentials?.market_seller_id,
        store_id,
        mock,
      });
      // Rate limit 헤더 → throttle 적응
      if (result.rateLimit) {
        adaptFromHeaders(market, sellerCredentials?.market_seller_id, result.rateLimit);
      }
      // 429 → backoff
      if (result.status === 429) {
        applyBackoff(market, sellerCredentials?.market_seller_id, 60_000);
      }
      return { market, ...result };
    }
    if (market === 'toss') {
      const result = await tossAdapter.registerProduct({
        lumiProduct,
        credentials: sellerCredentials?.credentials_encrypted,
        market_seller_id: sellerCredentials?.market_seller_id,
        mock,
      });
      if (result.status === 429) {
        applyBackoff(market, sellerCredentials?.market_seller_id, 60_000);
      }
      return { market, ...result };
    }
    return { market, success: false, error: `지원하지 않는 마켓: ${market}`, retryable: false };
  } catch (e) {
    return { market, success: false, error: e.message, retryable: false };
  }
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 1. JWT
  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  // 2. body
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식입니다.' }) };
  }
  const lumiProduct = body.product;
  const markets = Array.isArray(body.markets) ? body.markets.filter((m) => SUPPORTED_MARKETS.has(m)) : [];

  const { valid, errors } = validateLumiProduct(lumiProduct);
  if (!valid) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Lumi 스키마 오류: ' + errors.join(', ') }) };
  }
  if (markets.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '대상 마켓을 1개 이상 선택해주세요.' }) };
  }

  // 정책 단어 재검사 (셀러가 수정한 후 다시 들어왔을 수 있음)
  lumiProduct.policy_warnings = checkPolicyWords(lumiProduct.title, markets);

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  const adaptersForceMock = (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.TOSS_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  // 3. Supabase 연결 (mock 환경에서는 graceful)
  let admin;
  let productId = null;
  let credentialsByMarket = {};
  try {
    admin = getAdminClient();
  } catch (e) {
    if (isSignupMock) {
      // 모킹: products insert 스킵, 어댑터 mock 호출만
      productId = `MOCK_PRODUCT_${Date.now()}`;
    } else {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
    }
  }

  // 4. products insert
  if (admin) {
    const insertPayload = {
      seller_id: payload.seller_id,
      title: lumiProduct.title,
      description: lumiProduct.description || null,
      price_suggested: Math.floor(lumiProduct.price_suggested),
      ai_confidence: lumiProduct.ai_confidence,
      image_urls: lumiProduct.image_urls,
      primary_image_url: lumiProduct.image_urls?.[0] || null,
      category_suggestions: lumiProduct.category_suggestions,
      keywords: lumiProduct.keywords,
      market_overrides: {
        ...(lumiProduct.market_overrides || {}),
        // Phase: title 3안·후킹·상세레이아웃 보존 (추후 칼럼 정식화 전 임시)
        title_options: Array.isArray(lumiProduct.title_options) ? lumiProduct.title_options : null,
        hook_caption: lumiProduct.hook_caption || null,
        detail_layout: lumiProduct.detail_layout || null,
      },
      policy_warnings: lumiProduct.policy_warnings,
      raw_ai: lumiProduct.raw_ai || null,
      status: 'registering',
    };

    const { data: inserted, error: insertErr } = await admin
      .from('products')
      .insert(insertPayload)
      .select('id')
      .single();
    if (insertErr) {
      console.error('[register-product] insert 오류:', insertErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상품 저장에 실패했어요.' }) };
    }
    productId = inserted.id;

    // 5. 셀러 자격증명 조회
    const { data: creds } = await admin
      .from('market_credentials')
      .select('market, credentials_encrypted, access_token_encrypted, token_expires_at, market_seller_id, market_store_name, verified')
      .eq('seller_id', payload.seller_id)
      .in('market', markets);
    if (Array.isArray(creds)) {
      for (const c of creds) credentialsByMarket[c.market] = c;
    }
  }

  // 6. 마켓별 등록 (병렬)
  const distributePromises = markets.map((market) => distributeToMarket({
    market,
    lumiProduct,
    sellerCredentials: credentialsByMarket[market] || {},
    store_id: credentialsByMarket[market]?.market_store_name,
    mock: adaptersForceMock,
  }));
  const results = await Promise.all(distributePromises);

  // 7. product_market_registrations 갱신 + retry_queue 적재
  const registrations = [];
  for (const r of results) {
    let retryQueueId = null;
    if (admin && !r.success && r.retryable) {
      const enq = await retryEngine.enqueue(admin, {
        seller_id: payload.seller_id,
        task_type: 'register_product',
        market: r.market,
        payload: { product_id: productId, lumi_product: lumiProduct },
        last_error: { message: r.error, status: r.status },
      });
      if (enq.ok) retryQueueId = enq.id;
    }

    if (admin && productId) {
      await admin
        .from('product_market_registrations')
        .upsert({
          product_id: productId,
          seller_id: payload.seller_id,
          market: r.market,
          market_product_id: r.market_product_id || null,
          seller_product_id: r.seller_product_id || null,
          origin_product_no: r.origin_product_no || null,
          direct_link: r.direct_link || null,
          status: r.success ? (r.mock ? 'mocked' : 'live') : 'failed',
          last_error: r.success ? null : { message: r.error, status: r.status, raw: r.raw },
          retry_queue_id: retryQueueId,
          registered_at: r.success ? new Date().toISOString() : null,
          raw_response: r.raw || null,
        }, { onConflict: 'product_id,market' });
    }

    const friendly = r.success ? null : translateMarketError(r.market, r.status, r.error);
    registrations.push({
      market: r.market,
      success: r.success,
      market_product_id: r.market_product_id,
      direct_link: r.direct_link,
      mock: !!r.mock,
      retryable: !!r.retryable,
      retry_queue_id: retryQueueId,
      error: friendly,
    });
  }

  // 8. products status 갱신
  if (admin && productId) {
    const anyLive = results.some((r) => r.success);
    const allFailed = results.every((r) => !r.success);
    const newStatus = anyLive ? 'live' : (allFailed ? 'failed' : 'registering');
    await admin.from('products').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', productId);

    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'product_register',
      resource_type: 'product',
      resource_id: productId,
      metadata: { markets, results: results.map((r) => ({ market: r.market, success: r.success, status: r.status })) },
      event,
    });
  }

  console.log(`[register-product] seller=${payload.seller_id.slice(0, 8)} product=${productId} markets=${markets.join(',')} success=${results.filter((r)=>r.success).length}/${results.length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: registrations.some((r) => r.success),
      productId,
      registrations,
      mock: adaptersForceMock || isSignupMock,
    }),
  };
};
