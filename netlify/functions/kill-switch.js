// Kill Switch — 마켓·상품·옵션 단계 즉시 차단 / 재개 — Sprint 3
// POST /api/kill-switch
// Body: { scope: 'market'|'product'|'option', market?, product_id?, option_value?, action: 'stop'|'resume', reason? }
//
// 동작:
// 1. 셀러 검증 + 입력값 정규화
// 2. 어댑터.killSwitch 호출 (모킹 또는 실연동)
// 3. kill_switch_log 기록
// 4. 친절한 응답 ("쿠팡 판매를 즉시 중지했어요")

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const coupangOrders = require('./_shared/market-adapters/coupang-orders-adapter');
const naverOrders = require('./_shared/market-adapters/naver-orders-adapter');

const ADAPTERS = { coupang: coupangOrders, naver: naverOrders };

const VALID_SCOPES = new Set(['market', 'product', 'option']);
const VALID_ACTIONS = new Set(['stop', 'resume']);

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

  const scope = String(body.scope || '').toLowerCase();
  const action = String(body.action || 'stop').toLowerCase();
  const market = body.market ? String(body.market).toLowerCase() : null;
  const productId = body.product_id || null;
  const optionValue = body.option_value || null;
  const reason = body.reason || null;

  if (!VALID_SCOPES.has(scope)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'scope는 market/product/option 중 하나여야 해요.' }) };
  }
  if (!VALID_ACTIONS.has(action)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'action은 stop/resume 중 하나여야 해요.' }) };
  }
  if (scope === 'market' && !market) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '마켓을 지정해주세요.' }) };
  }
  if (scope === 'product' && !productId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '상품을 지정해주세요.' }) };
  }
  if (scope === 'option' && (!productId || !optionValue)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '상품과 옵션을 모두 지정해주세요.' }) };
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

  // 적용 대상 마켓 결정
  let targetMarkets = [];
  if (market) targetMarkets = [market];
  else if (productId && admin) {
    const { data } = await admin
      .from('product_market_registrations')
      .select('market')
      .eq('product_id', productId)
      .eq('seller_id', payload.seller_id);
    targetMarkets = Array.from(new Set((data || []).map((r) => r.market)));
  } else if (productId && !admin) {
    targetMarkets = ['coupang', 'naver']; // 모킹
  }
  if (targetMarkets.length === 0) {
    targetMarkets = ['coupang', 'naver'];
  }

  // market_product_id 룩업
  let marketProductByMarket = {};
  if (admin && productId) {
    const { data } = await admin
      .from('product_market_registrations')
      .select('market, market_product_id')
      .eq('product_id', productId)
      .eq('seller_id', payload.seller_id)
      .in('market', targetMarkets);
    if (Array.isArray(data)) {
      for (const r of data) marketProductByMarket[r.market] = r.market_product_id;
    }
  }

  const results = [];
  let appliedCount = 0;
  let failedCount = 0;
  for (const m of targetMarkets) {
    const adapter = ADAPTERS[m];
    if (!adapter) {
      results.push({ market: m, ok: false, error: '지원하지 않는 마켓이에요.' });
      failedCount += 1;
      continue;
    }
    let creds = null;
    if (admin) {
      const { data } = await admin
        .from('market_credentials')
        .select('credentials_encrypted, access_token_encrypted, token_expires_at, market_seller_id')
        .eq('seller_id', payload.seller_id)
        .eq('market', m)
        .single();
      creds = data || null;
    }
    const result = await adapter.killSwitch({
      scope,
      market_product_id: marketProductByMarket[m] || null,
      option_value: optionValue,
      credentials: creds?.credentials_encrypted,
      access_token_encrypted: creds?.access_token_encrypted,
      token_expires_at: creds?.token_expires_at,
      market_seller_id: creds?.market_seller_id,
      action,
      mock: adapterMock,
    });
    results.push({ market: m, ok: result.ok, applied: result.applied || 0, mocked: !!result.mocked, error: result.error || null });
    if (result.ok) appliedCount += result.applied || 1;
    else failedCount += 1;
  }

  // 로그
  if (admin) {
    await admin.from('kill_switch_log').insert({
      seller_id: payload.seller_id,
      scope,
      market: market || null,
      product_id: productId || null,
      option_value: optionValue || null,
      action,
      reason,
      applied_count: appliedCount,
      failed_count: failedCount,
      results,
    });
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: `kill_switch_${action}`,
      resource_type: scope,
      resource_id: productId || market || optionValue,
      metadata: { results },
      event,
    });
  }

  // 친절한 카피
  const friendlyMsg = action === 'stop'
    ? (scope === 'market' ? `${market} 판매를 즉시 중지했어요.` : `해당 ${scope === 'product' ? '상품' : '옵션'}의 판매를 중지했어요.`)
    : (scope === 'market' ? `${market} 판매를 다시 시작했어요.` : `해당 ${scope === 'product' ? '상품' : '옵션'}의 판매를 재개했어요.`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: appliedCount > 0,
      applied: appliedCount,
      failed: failedCount,
      message: friendlyMsg,
      scope,
      action,
      results,
      mocked: adapterMock || !admin,
    }),
  };
};
