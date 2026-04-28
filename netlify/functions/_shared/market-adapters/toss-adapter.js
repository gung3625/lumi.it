// 토스쇼핑 어댑터 — Sprint 2 Distribution 단계 (신규)
// LumiProduct → 토스쇼핑 통합솔루션 트랙 등록 → 직링크
//
// 마켓 표준 (project_marketplace_scope_0428.md 준거):
// - 통합솔루션 트랙: HMAC-SHA256 서명 (timestamp + path + body) + Bearer accessKey
// - 카테고리 3-Depth (대 / 중 / 소). 4-Depth 미지원
// - 응답 = productNo / sellerProductCode
// - 직링크 = https://toss.shop/products/{productNo}
// - Rate Limit: 보수적 5 req/s per Partner ID (네이버보다 조심)
//
// 모킹 (TOSS_VERIFY_MOCK=true): 외부 호출 스킵, 더미 productNo 반환
// 실연동 시: signature() HMAC + decrypt() 자격증명
// 인터페이스 = coupang-adapter / naver-adapter 와 동일 (registerProduct, transformToTossPayload, buildTossDirectLink)

const fetch = require('node-fetch');
const crypto = require('crypto');
const { decrypt } = require('../encryption');
const { validateLumiProduct } = require('./lumi-product-schema');

const TOSS_API_HOST = 'https://api.toss.shop';
const REGISTER_PATH = '/v1/partner/products';

/**
 * 토스쇼핑 HMAC-SHA256 서명
 * (실 스펙은 토스 정책 문서. 여기서는 안전한 기본 형식: timestamp.method.path.bodyHash)
 *
 * @param {{method:string,path:string,body:string,partnerId:string,secretKey:string}} params
 * @returns {{ authorization:string, timestamp:number, signature:string }}
 */
function signToss({ method, path, body, partnerId, secretKey }) {
  const timestamp = Date.now();
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const message = `${timestamp}.${method.toUpperCase()}.${path}.${bodyHash}`;
  const signature = crypto.createHmac('sha256', secretKey).update(message).digest('base64');
  return {
    authorization: `TOSS-HMAC partnerId=${partnerId}, timestamp=${timestamp}, signature=${signature}`,
    timestamp,
    signature,
  };
}

/**
 * LumiProduct → 토스쇼핑 등록 페이로드 변환
 * @param {import('./lumi-product-schema').LumiProduct} lumiProduct
 * @param {string} partnerId
 * @returns {Object} 토스 통합솔루션 트랙 body
 */
function transformToTossPayload(lumiProduct, partnerId) {
  const tree = lumiProduct.category_suggestions?.toss?.tree
    || lumiProduct.category_suggestions?.coupang?.tree
    || lumiProduct.category_suggestions?.naver?.tree
    || [];
  // 토스는 3-Depth max — 초과 시 잘라냄
  const tossTree = tree.slice(0, 3);
  const categoryCode = lumiProduct.category_suggestions?.toss?.marketCategoryId || null;

  const items = (Array.isArray(lumiProduct.options) && lumiProduct.options.length > 0)
    ? expandTossOptions(lumiProduct.options, lumiProduct.price_suggested)
    : [{
        itemName: '단품',
        salePrice: lumiProduct.price_suggested,
        stockQuantity: 999,
      }];

  return {
    partnerId,
    sellerProductCode: lumiProduct.market_overrides?.toss?.seller_code || `LUMI-${Date.now()}`,
    productName: lumiProduct.title,
    hookCaption: lumiProduct.hook_caption || null,
    categoryCode,
    categoryTree: tossTree,
    salePrice: Math.floor(lumiProduct.price_suggested),
    stockQuantity: 999,
    representativeImage: lumiProduct.image_urls?.[0] || '',
    additionalImages: (lumiProduct.image_urls || []).slice(1, 10),
    detailContent: buildDetailHtml(lumiProduct),
    options: items,
    searchKeywords: (lumiProduct.keywords || []).slice(0, 20),
    deliveryInfo: {
      deliveryType: 'NORMAL',
      deliveryFeeType: 'FREE',
      deliveryFee: 0,
    },
    saleStartedAt: new Date().toISOString(),
    statusType: 'SALE',
  };
}

function expandTossOptions(options, basePrice) {
  const combos = options.reduce((acc, opt) => {
    if (acc.length === 0) return opt.values.map((v) => [{ name: opt.name, value: v }]);
    return acc.flatMap((prev) => opt.values.map((v) => [...prev, { name: opt.name, value: v }]));
  }, []);

  return combos.slice(0, 100).map((combo) => ({
    itemName: combo.map((c) => c.value).join(' '),
    optionAttributes: combo.map((c) => ({ name: c.name, value: c.value })),
    salePrice: basePrice,
    extraPrice: 0,
    stockQuantity: 999,
    usable: true,
  }));
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildDetailHtml(lumiProduct) {
  const dl = lumiProduct.detail_layout;
  if (!dl) return `<p>${escapeHtml(lumiProduct.title)}</p>`;
  const parts = [];
  if (dl.header_image) parts.push(`<p><strong>${escapeHtml(dl.header_image)}</strong></p>`);
  if (Array.isArray(dl.key_points) && dl.key_points.length) {
    parts.push('<ul>' + dl.key_points.map((k) => `<li>${escapeHtml(k)}</li>`).join('') + '</ul>');
  }
  if (dl.model_styling) parts.push(`<p>${escapeHtml(dl.model_styling)}</p>`);
  if (dl.fabric_care) parts.push(`<p>${escapeHtml(dl.fabric_care)}</p>`);
  return parts.join('') || `<p>${escapeHtml(lumiProduct.title)}</p>`;
}

/**
 * 토스 직링크
 * @param {Object} apiResponse
 * @returns {string}
 */
function buildTossDirectLink(apiResponse) {
  const productNo = apiResponse?.data?.productNo || apiResponse?.productNo || apiResponse?.data?.sellerProductNo;
  if (!productNo) return '';
  return `https://toss.shop/products/${productNo}`;
}

/**
 * 토스 상품 등록 (Distribution)
 * @param {Object} params
 * @param {import('./lumi-product-schema').LumiProduct} params.lumiProduct
 * @param {Object} params.credentials - { ciphertext, iv, tag } 또는 { partnerId, accessKey, secretKey }
 * @param {string} [params.market_seller_id] - partnerId (있으면 우선)
 * @param {boolean} [params.mock]
 * @returns {Promise<{ success: boolean, market_product_id?: string, direct_link?: string, error?: string, status?: number, retryable?: boolean, raw?: Object }>}
 */
async function registerProduct({ lumiProduct, credentials, market_seller_id, mock }) {
  const { valid, errors } = validateLumiProduct(lumiProduct);
  if (!valid) {
    return { success: false, error: `Lumi 스키마 오류: ${errors.join(', ')}`, status: 400, retryable: false };
  }

  const isMock = mock === true || (process.env.TOSS_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  if (isMock) {
    const fakeProductNo = `TOSS_MOCK_${Date.now()}`;
    return {
      success: true,
      market_product_id: fakeProductNo,
      seller_product_id: `SP_${fakeProductNo}`,
      direct_link: buildTossDirectLink({ data: { productNo: fakeProductNo } }),
      mock: true,
      raw: { mocked: true, payload_size: JSON.stringify(transformToTossPayload(lumiProduct, market_seller_id || 'PARTNER_LUMI')).length },
    };
  }

  // 실연동
  let creds;
  try {
    creds = (credentials && credentials.ciphertext) ? decrypt(credentials) : credentials;
  } catch (e) {
    return { success: false, error: '자격증명 복호화 실패', status: 500, retryable: false };
  }
  const partnerId = market_seller_id || creds?.partnerId;
  const accessKey = creds?.accessKey;
  const secretKey = creds?.secretKey;
  if (!partnerId || !accessKey || !secretKey) {
    return { success: false, error: '토스 자격증명 누락', status: 401, retryable: false };
  }

  const payload = transformToTossPayload(lumiProduct, partnerId);
  const bodyStr = JSON.stringify(payload);
  const { authorization } = signToss({ method: 'POST', path: REGISTER_PATH, body: bodyStr, partnerId, secretKey });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${TOSS_API_HOST}${REGISTER_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'X-TOSS-ACCESS-KEY': accessKey,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: bodyStr,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const retryable = err.name === 'AbortError' || /ECONN|timeout/i.test(err.message);
    return { success: false, error: '토스 API 연결 실패', status: 0, retryable };
  }
  clearTimeout(timeout);

  let bodyText = '';
  try { bodyText = await response.text(); } catch (_) { /* */ }
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch (_) { /* */ }

  if (response.status === 200 || response.status === 201) {
    const productNo = parsed?.data?.productNo || parsed?.productNo;
    return {
      success: true,
      market_product_id: String(productNo || ''),
      seller_product_id: String(parsed?.data?.sellerProductCode || ''),
      direct_link: buildTossDirectLink(parsed),
      raw: parsed,
    };
  }

  const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
  return {
    success: false,
    status: response.status,
    error: parsed?.message || `토스 등록 실패 (${response.status})`,
    retryable,
    raw: parsed,
  };
}

module.exports = {
  registerProduct,
  transformToTossPayload,
  buildTossDirectLink,
  signToss,
};
