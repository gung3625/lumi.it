// 네이버 주문·송장·CS·Kill Switch 어댑터 — Sprint 3
// 기본 모킹 (NAVER_VERIFY_MOCK=true), 실연동 시 OAuth 토큰 갱신 사용

const fetch = require('node-fetch');
const { decrypt, decryptToken } = require('../encryption');
const { reissueToken, shouldRefreshToken } = require('./naver-adapter');

const NAVER_API_HOST = 'https://api.commerce.naver.com';

function isMockMode(explicit) {
  return explicit === true || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';
}

async function ensureToken({ credentials, access_token_encrypted, token_expires_at }) {
  let creds;
  try {
    creds = (credentials && credentials.ciphertext) ? decrypt(credentials) : credentials;
  } catch {
    return { ok: false, error: '네이버 자격증명 복호화 실패' };
  }
  let accessToken = null;
  try { accessToken = access_token_encrypted ? decryptToken(access_token_encrypted) : null; } catch { /* */ }
  if (!accessToken || shouldRefreshToken(token_expires_at)) {
    const r = await reissueToken({ applicationId: creds?.applicationId, applicationSecret: creds?.applicationSecret });
    if (!r.ok) return { ok: false, error: r.error || '토큰 갱신 실패' };
    accessToken = r.accessToken;
  }
  return { ok: true, accessToken };
}

/**
 * 네이버 신규 주문 풀링
 */
async function fetchNewOrders({ credentials, access_token_encrypted, token_expires_at, market_seller_id, store_id, since, mock }) {
  if (isMockMode(mock)) {
    return { ok: true, orders: mockOrders(store_id || market_seller_id || 'main'), mocked: true };
  }
  const tk = await ensureToken({ credentials, access_token_encrypted, token_expires_at });
  if (!tk.ok) return { ok: false, orders: [], error: tk.error, retryable: false };
  const sinceISO = (since instanceof Date ? since : new Date(Date.now() - 15 * 60 * 1000)).toISOString();
  const url = `${NAVER_API_HOST}/external/v1/pay-order/seller/orders?lastChangedFrom=${encodeURIComponent(sinceISO)}&lastChangedType=PAYED`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tk.accessToken}`, 'Content-Type': 'application/json' },
    });
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* */ }
    if (!res.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      return { ok: false, orders: [], error: json?.message || `네이버 주문 조회 실패 (${res.status})`, status: res.status, retryable };
    }
    const orders = (json?.data?.contents || []).map(normalizeNaverOrder);
    return { ok: true, orders };
  } catch (e) {
    return { ok: false, orders: [], error: '네이버 주문 조회 네트워크 오류', retryable: true };
  }
}

function normalizeNaverOrder(raw) {
  const order = raw.content || raw;
  const product = order.productOrder || order;
  return {
    market: 'naver',
    market_order_id: String(order.productOrderId || order.orderId || ''),
    market_product_id: String(product.productId || product.originProductNo || ''),
    product_title: product.productName || '',
    quantity: Number(product.quantity || 1),
    total_price: Number(product.totalPaymentAmount || product.totalPrice || 0),
    option_text: product.productOption || '',
    status: 'paid',
    buyer_name: order.shippingAddress?.name || order.ordererName || '',
    buyer_phone: order.shippingAddress?.tel1 || order.ordererPhone || '',
    buyer_address: [order.shippingAddress?.baseAddress, order.shippingAddress?.detailedAddress].filter(Boolean).join(' '),
    raw: order,
  };
}

function mockOrders(storeId) {
  const now = Date.now();
  return [
    {
      market: 'naver',
      market_order_id: `NV_MOCK_${now}_1`,
      market_product_id: 'MOCK_NV_P_1',
      product_title: '봄 시폰 원피스 베이지',
      quantity: 1,
      total_price: 39000,
      option_text: '베이지 / S',
      status: 'paid',
      buyer_name: '박지수',
      buyer_phone: '010-7777-8888',
      buyer_address: '서울특별시 마포구 양화로 45',
      raw: { mocked: true, storeId },
    },
  ];
}

/**
 * 네이버 송장 입력
 * PUT /external/v1/pay-order/seller/product-orders/dispatch
 */
async function submitTracking({ market_order_id, tracking_number, courier_code, credentials, access_token_encrypted, token_expires_at, mock }) {
  if (!market_order_id || !tracking_number || !courier_code) {
    return { ok: false, error: '주문번호·송장번호·택배사 모두 필요해요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, raw: { orderId: market_order_id, courier: courier_code, invoice: tracking_number } };
  }
  const tk = await ensureToken({ credentials, access_token_encrypted, token_expires_at });
  if (!tk.ok) return { ok: false, error: tk.error, retryable: false };

  const body = {
    dispatchProductOrders: [{
      productOrderId: market_order_id,
      deliveryCompanyCode: courier_code,
      trackingNumber: tracking_number,
      dispatchDate: new Date().toISOString(),
    }],
  };
  try {
    const res = await fetch(`${NAVER_API_HOST}/external/v1/pay-order/seller/product-orders/dispatch`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tk.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* */ }
    if (!res.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      return { ok: false, error: json?.message || `네이버 송장 입력 실패 (${res.status})`, status: res.status, retryable };
    }
    return { ok: true, raw: json };
  } catch (e) {
    return { ok: false, error: '네이버 송장 입력 네트워크 오류', retryable: true };
  }
}

/**
 * 네이버 CS 문의 풀링 (모킹 — 실연동은 inquiries API)
 */
async function fetchCsThreads({ credentials, access_token_encrypted, token_expires_at, market_seller_id, mock }) {
  if (isMockMode(mock)) {
    return { ok: true, threads: mockCsThreads(market_seller_id || 'NV'), mocked: true };
  }
  return { ok: true, threads: [] };
}

function mockCsThreads(applicationId) {
  const now = Date.now();
  return [
    {
      market: 'naver',
      market_thread_id: `NV_CS_${now}_1`,
      market_order_id: `NV_MOCK_${now}_1`,
      buyer_name: '박지수',
      preview_text: '사이즈 교환 가능한가요? S → M으로요.',
      messages: [{ sender_type: 'buyer', content: '사이즈 교환 가능한가요? S → M으로 부탁드려요.' }],
      raw: { mocked: true, applicationId },
    },
  ];
}

async function sendCsReply({ market_thread_id, content, credentials, access_token_encrypted, token_expires_at, mock }) {
  if (!market_thread_id || !content) {
    return { ok: false, error: '문의 ID와 답변 내용이 필요해요.', retryable: false };
  }
  if (isMockMode(mock)) return { ok: true, mocked: true, market_response_id: `NV_RESP_${Date.now()}` };
  return { ok: false, error: '실연동 미지원', retryable: false };
}

async function killSwitch({ scope, market_product_id, option_value, credentials, access_token_encrypted, token_expires_at, action, mock }) {
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, applied: 1, scope, action };
  }
  return { ok: false, error: '실연동 미지원', retryable: false };
}

/**
 * 네이버 재고 동기화 — PATCH /external/v2/products/origin-products/{originProductNo}/change-stock-quantity
 */
async function syncInventory({ market_product_id, quantity, credentials, access_token_encrypted, token_expires_at, mock }) {
  if (!market_product_id) {
    return { ok: false, error: '상품 ID가 필요해요.', retryable: false };
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    return { ok: false, error: '재고 수량은 0 이상이어야 해요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, market_product_id, quantity, raw: { mocked: true } };
  }
  const tk = await ensureToken({ credentials, access_token_encrypted, token_expires_at });
  if (!tk.ok) return { ok: false, error: tk.error, retryable: false };
  const path = `/external/v2/products/origin-products/${encodeURIComponent(market_product_id)}/change-stock-quantity`;
  const body = { stockQuantity: Math.trunc(quantity) };
  try {
    const res = await fetch(`${NAVER_API_HOST}${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tk.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* */ }
    if (!res.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      return { ok: false, error: json?.message || `네이버 재고 동기화 실패 (${res.status})`, status: res.status, retryable };
    }
    return { ok: true, market_product_id, quantity, raw: json };
  } catch (e) {
    return { ok: false, error: '네이버 재고 동기화 네트워크 오류', retryable: true };
  }
}

/**
 * 네이버 가격 갱신 — PATCH /external/v2/products/origin-products/{originProductNo}/change-sale-price
 */
async function updatePrice({ market_product_id, price, credentials, access_token_encrypted, token_expires_at, mock }) {
  if (!market_product_id) {
    return { ok: false, error: '상품 ID가 필요해요.', retryable: false };
  }
  if (!Number.isFinite(price) || price < 0) {
    return { ok: false, error: '가격은 0 이상이어야 해요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, market_product_id, price, raw: { mocked: true } };
  }
  const tk = await ensureToken({ credentials, access_token_encrypted, token_expires_at });
  if (!tk.ok) return { ok: false, error: tk.error, retryable: false };
  const path = `/external/v2/products/origin-products/${encodeURIComponent(market_product_id)}/change-sale-price`;
  const body = { salePrice: Math.trunc(price) };
  try {
    const res = await fetch(`${NAVER_API_HOST}${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tk.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* */ }
    if (!res.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      return { ok: false, error: json?.message || `네이버 가격 갱신 실패 (${res.status})`, status: res.status, retryable };
    }
    return { ok: true, market_product_id, price, raw: json };
  } catch (e) {
    return { ok: false, error: '네이버 가격 갱신 네트워크 오류', retryable: true };
  }
}

/**
 * 네이버 상품 부분 수정 (필드별 라우팅)
 */
async function updateProduct({ market_product_id, fields, credentials, access_token_encrypted, token_expires_at, mock }) {
  if (!market_product_id) {
    return { ok: false, error: '상품 ID가 필요해요.', retryable: false };
  }
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    return { ok: false, error: '수정할 필드가 없어요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, market_product_id, fields_updated: Object.keys(fields), raw: { mocked: true } };
  }
  if ('price' in fields && Object.keys(fields).length === 1) {
    return updatePrice({ market_product_id, price: Number(fields.price), credentials, access_token_encrypted, token_expires_at, mock });
  }
  return { ok: false, error: '네이버는 현재 가격·재고 외 부분 수정은 모킹만 지원해요.', retryable: false };
}

/**
 * 네이버 환불 처리 — POST /external/v1/pay-order/seller/product-orders/{productOrderId}/return/approve
 */
async function processRefund({ market_order_id, reason, type, credentials, access_token_encrypted, token_expires_at, mock }) {
  if (!market_order_id) {
    return { ok: false, error: '주문번호가 필요해요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, market_order_id, type: type || 'refund', refund_id: `NV_REF_${Date.now()}` };
  }
  return { ok: false, error: '네이버 환불 실연동은 곧 지원돼요. 모킹 모드를 활성화해주세요.', retryable: false };
}

module.exports = {
  fetchNewOrders,
  normalizeNaverOrder,
  submitTracking,
  fetchCsThreads,
  sendCsReply,
  killSwitch,
  syncInventory,
  updatePrice,
  updateProduct,
  processRefund,
};
