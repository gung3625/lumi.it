// 토스쇼핑 주문·반품 어댑터 — 통합솔루션 트랙
// 기본 모킹 (TOSS_VERIFY_MOCK=true), 실연동 시 HMAC-SHA256 서명 사용 (toss-adapter signToss 재사용)
//
// 인터페이스: coupang/naver-orders-adapter 와 동일 (processReturn / processRefund)

const fetch = require('node-fetch');
const { decrypt } = require('../encryption');
const { signToss } = require('./toss-adapter');

const TOSS_API_HOST = 'https://api.toss.shop';

function isMockMode(explicit) {
  return explicit === true || (process.env.TOSS_VERIFY_MOCK || 'true').toLowerCase() !== 'false';
}

/**
 * 토스 반품·환불 처리
 * @param {Object} params
 * @param {string} params.market_order_id
 * @param {string} [params.reason]
 * @param {'refund'|'exchange'|'partial_refund'} [params.type='refund']
 * @param {number} [params.amount] - 부분환불 금액
 * @param {Object} [params.credentials]
 * @param {string} [params.market_seller_id] - partnerId
 * @param {boolean} [params.mock]
 */
async function processReturn({ market_order_id, reason, type, amount, credentials, market_seller_id, mock }) {
  if (!market_order_id) {
    return { ok: false, error: '주문번호가 필요해요.', retryable: false };
  }
  const t = (type === 'exchange' || type === 'partial_refund') ? type : 'refund';
  if (t === 'partial_refund' && (!Number.isFinite(amount) || amount <= 0)) {
    return { ok: false, error: '부분환불 금액은 0원 초과여야 해요.', retryable: false };
  }
  if (isMockMode(mock)) {
    return {
      ok: true,
      mocked: true,
      market_order_id,
      type: t,
      refund_id: `TOSS_RET_${Date.now()}`,
      amount: t === 'partial_refund' ? amount : undefined,
    };
  }
  let creds;
  try {
    creds = (credentials && credentials.ciphertext) ? decrypt(credentials) : credentials;
  } catch {
    return { ok: false, error: '토스 자격증명 복호화 실패', retryable: false };
  }
  const partnerId = market_seller_id || creds?.partnerId;
  const accessKey = creds?.accessKey;
  const secretKey = creds?.secretKey;
  if (!partnerId || !accessKey || !secretKey) {
    return { ok: false, error: '토스 자격증명 누락', retryable: false };
  }

  const path = `/v1/partner/orders/${encodeURIComponent(market_order_id)}/return`;
  const body = {
    type: t === 'partial_refund' ? 'PARTIAL_REFUND' : (t === 'exchange' ? 'EXCHANGE' : 'REFUND'),
    reason: reason || '셀러 처리',
    refundAmount: t === 'partial_refund' ? Math.trunc(amount) : null,
  };
  const bodyStr = JSON.stringify(body);
  const { authorization } = signToss({ method: 'POST', path, body: bodyStr, partnerId, secretKey });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${TOSS_API_HOST}${path}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'X-TOSS-ACCESS-KEY': accessKey,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* */ }
    if (!res.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      return { ok: false, error: json?.message || `토스 반품 처리 실패 (${res.status})`, status: res.status, retryable };
    }
    return {
      ok: true,
      market_order_id,
      type: t,
      refund_id: String(json?.data?.returnId || json?.returnId || ''),
      amount: t === 'partial_refund' ? amount : undefined,
      raw: json,
    };
  } catch (e) {
    clearTimeout(timeout);
    const retryable = e.name === 'AbortError' || /ECONN|timeout/i.test(e.message);
    return { ok: false, error: '토스 반품 처리 네트워크 오류', retryable };
  }
}

// processRefund 별칭 (인터페이스 통일)
async function processRefund(params) {
  return processReturn(params);
}

module.exports = {
  processReturn,
  processRefund,
};
