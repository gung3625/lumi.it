// 쿠팡 주문·송장·CS·Kill Switch 어댑터 — Sprint 3
// 기본 모킹 (COUPANG_VERIFY_MOCK=true), 실연동 시 signCoupang HMAC 사용
//
// 검증된 사실:
// - Vendor ID 단위 5 req/s
// - 주문 조회: GET /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets
// - 송장 입력: PUT /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/orders/invoices

const fetch = require('node-fetch');
const { signCoupang } = require('../coupang-signature');
const { decrypt } = require('../encryption');

const COUPANG_API_HOST = 'https://api-gateway.coupang.com';

function isMockMode(explicit) {
  return explicit === true || (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false';
}

/**
 * 쿠팡 주문 풀링 (지난 N분간 신규)
 * @param {Object} params
 * @param {Object} [params.credentials]
 * @param {string} [params.market_seller_id] - vendorId
 * @param {Date} [params.since]
 * @param {boolean} [params.mock]
 * @returns {Promise<{ ok: boolean, orders: Array, error?: string, retryable?: boolean }>}
 */
async function fetchNewOrders({ credentials, market_seller_id, since, mock }) {
  if (isMockMode(mock)) {
    return { ok: true, orders: mockOrders(market_seller_id || 'V_MOCK_VENDOR'), mocked: true };
  }
  let creds;
  try {
    creds = (credentials && credentials.ciphertext) ? decrypt(credentials) : credentials;
  } catch {
    return { ok: false, orders: [], error: '쿠팡 자격증명 복호화 실패', retryable: false };
  }
  const vendorId = market_seller_id || creds?.vendorId;
  if (!vendorId || !creds?.accessKey || !creds?.secretKey) {
    return { ok: false, orders: [], error: '쿠팡 자격증명 누락', retryable: false };
  }
  const sinceISO = (since instanceof Date ? since : new Date(Date.now() - 15 * 60 * 1000)).toISOString().slice(0, 19);
  const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`;
  const query = `createdAtFrom=${sinceISO}&status=ACCEPT`;
  const { authorization } = signCoupang({ method: 'GET', path, query, accessKey: creds.accessKey, secretKey: creds.secretKey });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${COUPANG_API_HOST}${path}?${query}`, {
      method: 'GET',
      headers: { Authorization: authorization, 'Content-Type': 'application/json;charset=UTF-8' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* */ }
    if (!res.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      return { ok: false, orders: [], error: json?.message || `쿠팡 주문 조회 실패 (${res.status})`, status: res.status, retryable };
    }
    const orders = (json?.data || []).map(normalizeCoupangOrder);
    return { ok: true, orders };
  } catch (e) {
    clearTimeout(timeout);
    return { ok: false, orders: [], error: '쿠팡 주문 조회 네트워크 오류', retryable: true };
  }
}

function normalizeCoupangOrder(raw) {
  // 쿠팡 ordersheet → 루미 표준
  const item = (raw.orderItems && raw.orderItems[0]) || {};
  return {
    market: 'coupang',
    market_order_id: String(raw.orderId || raw.orderSheetId || ''),
    market_product_id: String(item.productId || item.sellerProductId || ''),
    product_title: item.sellerProductName || item.productName || '',
    quantity: Number(item.shippingCount || item.orderQuantity || 1),
    total_price: Number(item.salesPrice || raw.salesPrice || 0),
    option_text: item.sellerProductItemName || '',
    status: 'paid',
    buyer_name: raw.receiverName || raw.purchaserName || '',
    buyer_phone: raw.receiver?.receiverPhone || raw.purchaserPhone || '',
    buyer_address: [raw.receiver?.addr1, raw.receiver?.addr2].filter(Boolean).join(' '),
    raw,
  };
}

function mockOrders(vendorId) {
  const now = Date.now();
  return [
    {
      market: 'coupang',
      market_order_id: `CP_MOCK_${now}_1`,
      market_product_id: 'MOCK_P_1',
      product_title: '봄 시폰 원피스 베이지',
      quantity: 1,
      total_price: 39000,
      option_text: '베이지 / M',
      status: 'paid',
      buyer_name: '김철수',
      buyer_phone: '010-1234-5678',
      buyer_address: '서울특별시 강남구 테헤란로 152, 101동 1234호',
      raw: { mocked: true, vendorId },
    },
    {
      market: 'coupang',
      market_order_id: `CP_MOCK_${now}_2`,
      market_product_id: 'MOCK_P_2',
      product_title: '베이직 코튼 후드 티셔츠',
      quantity: 2,
      total_price: 58000,
      option_text: '블랙 / L',
      status: 'paid',
      buyer_name: '이영희',
      buyer_phone: '01098765432',
      buyer_address: '경기도 성남시 분당구 판교역로 235',
      raw: { mocked: true, vendorId },
    },
  ];
}

/**
 * 쿠팡 송장 입력
 * @param {Object} params
 * @param {string} params.market_order_id
 * @param {string} params.tracking_number
 * @param {string} params.courier_code
 * @param {Object} [params.credentials]
 * @param {string} [params.market_seller_id]
 * @param {boolean} [params.mock]
 */
async function submitTracking({ market_order_id, tracking_number, courier_code, credentials, market_seller_id, mock }) {
  if (!market_order_id || !tracking_number || !courier_code) {
    return { ok: false, error: '주문번호·송장번호·택배사 모두 필요해요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, raw: { orderId: market_order_id, deliveryCompanyCode: courier_code, invoiceNumber: tracking_number } };
  }
  let creds;
  try {
    creds = (credentials && credentials.ciphertext) ? decrypt(credentials) : credentials;
  } catch {
    return { ok: false, error: '쿠팡 자격증명 복호화 실패', retryable: false };
  }
  const vendorId = market_seller_id || creds?.vendorId;
  const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/orders/invoices`;
  const body = {
    vendorId,
    orderSheetInvoiceApplyDtos: [{
      shipmentBoxId: market_order_id,
      deliveryCompanyCode: courier_code,
      invoiceNumber: tracking_number,
    }],
  };
  const { authorization } = signCoupang({ method: 'PUT', path, query: '', accessKey: creds.accessKey, secretKey: creds.secretKey });
  try {
    const res = await fetch(`${COUPANG_API_HOST}${path}`, {
      method: 'PUT',
      headers: { Authorization: authorization, 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* */ }
    if (!res.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      return { ok: false, error: json?.message || `쿠팡 송장 입력 실패 (${res.status})`, status: res.status, retryable };
    }
    return { ok: true, raw: json };
  } catch (e) {
    return { ok: false, error: '쿠팡 송장 입력 네트워크 오류', retryable: true };
  }
}

/**
 * 쿠팡 CS 문의 풀링 (모킹)
 */
async function fetchCsThreads({ credentials, market_seller_id, since, mock }) {
  if (isMockMode(mock)) {
    return { ok: true, threads: mockCsThreads(market_seller_id || 'V_MOCK'), mocked: true };
  }
  // 실연동은 customer-service API. Phase 1.5에서 정식 결합. 여기서는 빈 배열 반환.
  return { ok: true, threads: [] };
}

function mockCsThreads(vendorId) {
  const now = Date.now();
  return [
    {
      market: 'coupang',
      market_thread_id: `CP_CS_${now}_1`,
      market_order_id: `CP_MOCK_${now}_1`,
      buyer_name: '김철수',
      preview_text: '주문한 원피스 언제 발송되나요?',
      messages: [{ sender_type: 'buyer', content: '주문한 원피스 언제 발송되나요? 빠른 답변 부탁드려요.' }],
      raw: { mocked: true, vendorId },
    },
  ];
}

/**
 * 쿠팡 CS 답변 전송 (모킹)
 */
async function sendCsReply({ market_thread_id, content, credentials, market_seller_id, mock }) {
  if (!market_thread_id || !content) {
    return { ok: false, error: '문의 ID와 답변 내용이 필요해요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, market_response_id: `CP_RESP_${Date.now()}` };
  }
  // 실연동 미구현 (Phase 1.5)
  return { ok: false, error: '실연동 미지원', retryable: false };
}

/**
 * Kill Switch — 마켓·상품·옵션 단계 판매 중지
 */
async function killSwitch({ scope, market_product_id, option_value, credentials, market_seller_id, action, mock }) {
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, applied: 1, scope, action };
  }
  // 실연동: 쿠팡 OPEN API 상품 상태 변경 PUT (Phase 1.5)
  return { ok: false, error: '실연동 미지원', retryable: false };
}

/**
 * 재고 동기화 (PUT) — 단일 상품/옵션 재고 갱신
 * @param {Object} params
 * @param {string} params.market_product_id
 * @param {number} params.quantity - 절대값 (음수 금지)
 * @param {Object} [params.credentials]
 * @param {string} [params.market_seller_id]
 * @param {boolean} [params.mock]
 */
async function syncInventory({ market_product_id, quantity, credentials, market_seller_id, mock }) {
  if (!market_product_id) {
    return { ok: false, error: '상품 ID가 필요해요.', retryable: false };
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    return { ok: false, error: '재고 수량은 0 이상이어야 해요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, market_product_id, quantity, raw: { mocked: true } };
  }
  let creds;
  try {
    creds = (credentials && credentials.ciphertext) ? decrypt(credentials) : credentials;
  } catch {
    return { ok: false, error: '쿠팡 자격증명 복호화 실패', retryable: false };
  }
  const vendorId = market_seller_id || creds?.vendorId;
  if (!vendorId || !creds?.accessKey || !creds?.secretKey) {
    return { ok: false, error: '쿠팡 자격증명 누락', retryable: false };
  }
  // PUT /v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{vendorItemId}/quantities/{quantity}
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(market_product_id)}/quantities/${Math.trunc(quantity)}`;
  const { authorization } = signCoupang({ method: 'PUT', path, query: '', accessKey: creds.accessKey, secretKey: creds.secretKey });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${COUPANG_API_HOST}${path}`, {
      method: 'PUT',
      headers: { Authorization: authorization, 'Content-Type': 'application/json;charset=UTF-8' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* */ }
    if (!res.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      return { ok: false, error: json?.message || `쿠팡 재고 동기화 실패 (${res.status})`, status: res.status, retryable };
    }
    return { ok: true, market_product_id, quantity, raw: json };
  } catch (e) {
    clearTimeout(timeout);
    const retryable = e.name === 'AbortError' || /ECONN|timeout/i.test(e.message);
    return { ok: false, error: '쿠팡 재고 동기화 네트워크 오류', retryable };
  }
}

/**
 * 가격 갱신 (PUT) — 단일 상품/옵션 판매가 갱신
 * @param {Object} params
 * @param {string} params.market_product_id
 * @param {number} params.price - 원 단위 (절대값)
 * @param {Object} [params.credentials]
 * @param {string} [params.market_seller_id]
 * @param {boolean} [params.mock]
 */
async function updatePrice({ market_product_id, price, credentials, market_seller_id, mock }) {
  if (!market_product_id) {
    return { ok: false, error: '상품 ID가 필요해요.', retryable: false };
  }
  if (!Number.isFinite(price) || price < 0) {
    return { ok: false, error: '가격은 0 이상이어야 해요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, market_product_id, price, raw: { mocked: true } };
  }
  let creds;
  try {
    creds = (credentials && credentials.ciphertext) ? decrypt(credentials) : credentials;
  } catch {
    return { ok: false, error: '쿠팡 자격증명 복호화 실패', retryable: false };
  }
  const vendorId = market_seller_id || creds?.vendorId;
  if (!vendorId || !creds?.accessKey || !creds?.secretKey) {
    return { ok: false, error: '쿠팡 자격증명 누락', retryable: false };
  }
  // PUT /v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{vendorItemId}/prices/{price}
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(market_product_id)}/prices/${Math.trunc(price)}`;
  const { authorization } = signCoupang({ method: 'PUT', path, query: '', accessKey: creds.accessKey, secretKey: creds.secretKey });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${COUPANG_API_HOST}${path}`, {
      method: 'PUT',
      headers: { Authorization: authorization, 'Content-Type': 'application/json;charset=UTF-8' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* */ }
    if (!res.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      return { ok: false, error: json?.message || `쿠팡 가격 갱신 실패 (${res.status})`, status: res.status, retryable };
    }
    return { ok: true, market_product_id, price, raw: json };
  } catch (e) {
    clearTimeout(timeout);
    const retryable = e.name === 'AbortError' || /ECONN|timeout/i.test(e.message);
    return { ok: false, error: '쿠팡 가격 갱신 네트워크 오류', retryable };
  }
}

/**
 * 상품 부분 수정 (PATCH) — 변경된 필드만 마켓 반영
 * @param {Object} params
 * @param {string} params.market_product_id
 * @param {Object} params.fields - { title?, description?, price?, options? }
 * @param {Object} [params.credentials]
 * @param {string} [params.market_seller_id]
 * @param {boolean} [params.mock]
 */
async function updateProduct({ market_product_id, fields, credentials, market_seller_id, mock }) {
  if (!market_product_id) {
    return { ok: false, error: '상품 ID가 필요해요.', retryable: false };
  }
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    return { ok: false, error: '수정할 필드가 없어요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, market_product_id, fields_updated: Object.keys(fields), raw: { mocked: true } };
  }
  // 실연동 — 가격은 별도 엔드포인트, 그 외는 상품 PUT (간소화: 가격만 분리 라우팅)
  if ('price' in fields && Object.keys(fields).length === 1) {
    return updatePrice({ market_product_id, price: Number(fields.price), credentials, market_seller_id, mock });
  }
  // 그 외 필드는 상품 본문 PUT — Phase 1.5 정식 결합
  return { ok: false, error: '쿠팡은 현재 가격·재고 외 부분 수정은 모킹만 지원해요.', retryable: false };
}

/**
 * 환불 처리 (POST) — 마켓별 환불 API 호출
 * @param {Object} params
 * @param {string} params.market_order_id
 * @param {string} params.reason
 * @param {'refund'|'exchange'} [params.type='refund']
 * @param {Object} [params.credentials]
 * @param {string} [params.market_seller_id]
 * @param {boolean} [params.mock]
 */
async function processRefund({ market_order_id, reason, type, credentials, market_seller_id, mock }) {
  if (!market_order_id) {
    return { ok: false, error: '주문번호가 필요해요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return { ok: true, mocked: true, market_order_id, type: type || 'refund', refund_id: `CP_REF_${Date.now()}` };
  }
  // 실연동 미구현 — Phase 1.5 (returnRequests 승인 + 환불 트리거)
  return { ok: false, error: '쿠팡 환불 실연동은 곧 지원돼요. 모킹 모드를 활성화해주세요.', retryable: false };
}

/**
 * 반품·교환·부분환불 풀 사이클 처리 — 쿠팡 returnRequests 승인 + 환불 트리거
 * @param {Object} params
 * @param {string} params.market_order_id
 * @param {string} [params.reason]
 * @param {'refund'|'exchange'|'partial_refund'} [params.type='refund']
 * @param {number} [params.amount] - 부분환불 금액 (KRW)
 * @param {string} [params.exchange_product_id] - 교환 시 새 상품 ID
 * @param {Object} [params.credentials]
 * @param {string} [params.market_seller_id]
 * @param {boolean} [params.mock]
 */
async function processReturn({ market_order_id, reason, type, amount, exchange_product_id, credentials, market_seller_id, mock }) {
  if (!market_order_id) {
    return { ok: false, error: '주문번호가 필요해요.', retryable: false };
  }
  const t = (type === 'exchange' || type === 'partial_refund') ? type : 'refund';
  if (t === 'partial_refund' && (!Number.isFinite(amount) || amount <= 0)) {
    return { ok: false, error: '부분환불 금액은 0원 초과여야 해요.', retryable: false };
  }
  if (t === 'exchange' && !exchange_product_id && !mock) {
    // mock 모드면 통과, 실연동에서 교환 상품 ID 필수
    if (!isMockMode(mock)) {
      return { ok: false, error: '교환 처리 시 새 상품 ID가 필요해요.', retryable: false };
    }
  }
  if (isMockMode(mock)) {
    return {
      ok: true,
      mocked: true,
      market_order_id,
      type: t,
      refund_id: `CP_RET_${Date.now()}`,
      amount: t === 'partial_refund' ? amount : undefined,
    };
  }
  let creds;
  try {
    creds = (credentials && credentials.ciphertext) ? decrypt(credentials) : credentials;
  } catch {
    return { ok: false, error: '쿠팡 자격증명 복호화 실패', retryable: false };
  }
  const vendorId = market_seller_id || creds?.vendorId;
  if (!vendorId || !creds?.accessKey || !creds?.secretKey) {
    return { ok: false, error: '쿠팡 자격증명 누락', retryable: false };
  }
  // 쿠팡 returnRequests 승인 — POST /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/returnRequests/{receiptId}/approval
  const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/returnRequests/${encodeURIComponent(market_order_id)}/approval`;
  const body = {
    vendorId,
    cancelType: t === 'exchange' ? 'EXCHANGE' : (t === 'partial_refund' ? 'PARTIAL_REFUND' : 'CANCEL'),
    refundAmount: t === 'partial_refund' ? Math.trunc(amount) : undefined,
    cancelReasonCode: 'CHANGEMIND',
    cancelReason: reason || '셀러 처리',
  };
  const bodyStr = JSON.stringify(body);
  const { authorization } = signCoupang({ method: 'POST', path, query: '', accessKey: creds.accessKey, secretKey: creds.secretKey });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${COUPANG_API_HOST}${path}`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json;charset=UTF-8' },
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* */ }
    if (!res.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      return { ok: false, error: json?.message || `쿠팡 반품 처리 실패 (${res.status})`, status: res.status, retryable };
    }
    return {
      ok: true,
      market_order_id,
      type: t,
      refund_id: String(json?.data?.cancelId || json?.data?.receiptId || ''),
      amount: t === 'partial_refund' ? amount : undefined,
      raw: json,
    };
  } catch (e) {
    clearTimeout(timeout);
    const retryable = e.name === 'AbortError' || /ECONN|timeout/i.test(e.message);
    return { ok: false, error: '쿠팡 반품 처리 네트워크 오류', retryable };
  }
}

module.exports = {
  fetchNewOrders,
  normalizeCoupangOrder,
  submitTracking,
  fetchCsThreads,
  sendCsReply,
  killSwitch,
  syncInventory,
  updatePrice,
  updateProduct,
  processRefund,
  processReturn,
};
