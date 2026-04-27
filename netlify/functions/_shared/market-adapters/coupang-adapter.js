// 쿠팡 어댑터 — Sprint 2 Distribution 단계
// LumiProduct → 쿠팡 Wing OPEN API 등록 → 직링크
//
// 마켓 표준 (검증된 사실):
// - 이미지 10MB 이하, 가로 780px 권장 (현재는 URL 그대로 전달, 향후 sharp 리사이즈 추가)
// - 카테고리 4-Depth (대분류 → 중분류 → 소분류 → 세분류)
// - API 응답 = productId / sellerProductId / vendorItemId
// - 직링크 = https://www.coupang.com/vp/products/{productId}  (직접 조합)
// - Rate Limit: 보수적 5 req/s per Vendor ID
//
// 모킹 (COUPANG_VERIFY_MOCK=true): 외부 호출 스킵, 더미 productId 반환
// 실연동: signCoupang() HMAC + decrypt() 자격증명

const fetch = require('node-fetch');
const { signCoupang } = require('../coupang-signature');
const { decrypt } = require('../encryption');
const { validateLumiProduct } = require('./lumi-product-schema');

const COUPANG_API_HOST = 'https://api-gateway.coupang.com';
const REGISTER_PATH = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';

/**
 * LumiProduct → 쿠팡 등록 페이로드 변환 (Transformation 단계)
 * @param {import('./lumi-product-schema').LumiProduct} lumiProduct
 * @param {string} vendorId
 * @returns {Object} 쿠팡 OPEN API body (간소화 버전, 실연동 시 정식 스펙 추가)
 */
function transformToCoupangPayload(lumiProduct, vendorId) {
  const tree = lumiProduct.category_suggestions?.coupang?.tree || [];
  const categoryId = lumiProduct.category_suggestions?.coupang?.marketCategoryId || null;

  // 옵션 → 쿠팡 items 배열 (단품도 옵션='단품' 필수)
  const items = (Array.isArray(lumiProduct.options) && lumiProduct.options.length > 0)
    ? expandOptionsToItems(lumiProduct.options, lumiProduct.price_suggested, lumiProduct.image_urls)
    : [{
        itemName: '단품',
        originalPrice: lumiProduct.price_suggested,
        salePrice: lumiProduct.price_suggested,
        maximumBuyCount: 999,
        outboundShippingTimeDay: 1,
        images: (lumiProduct.image_urls || []).slice(0, 50).map((url, i) => ({
          imageOrder: i,
          imageType: i === 0 ? 'REPRESENTATION' : 'DETAIL',
          vendorPath: url,
        })),
        notices: [],
      }];

  return {
    sellerProductName: lumiProduct.title,
    vendorId,
    saleStartedAt: new Date().toISOString().slice(0, 19),
    saleEndedAt: '2099-12-31T23:59:59',
    displayCategoryCode: categoryId,
    categoryTree: tree,
    brand: lumiProduct.market_overrides?.coupang?.brand || '',
    manufacture: lumiProduct.market_overrides?.coupang?.manufacture || '',
    deliveryMethod: 'AGENT_BUY',
    deliveryCompanyCode: 'CJGLS',
    deliveryChargeType: 'FREE',
    items,
    requiredDocuments: [],
    notices: [],
    searchTags: (lumiProduct.keywords || []).slice(0, 20),
  };
}

function expandOptionsToItems(options, basePrice, imageUrls) {
  // 옵션 조합 (n*m). 단순 직교곱 — 실제 운영 시 inventory·SKU 룩업 추가
  const combos = options.reduce((acc, opt) => {
    if (acc.length === 0) return opt.values.map((v) => [{ name: opt.name, value: v }]);
    return acc.flatMap((prev) => opt.values.map((v) => [...prev, { name: opt.name, value: v }]));
  }, []);

  return combos.slice(0, 100).map((combo, i) => ({
    itemName: combo.map((c) => c.value).join(' '),
    originalPrice: basePrice,
    salePrice: basePrice,
    maximumBuyCount: 999,
    outboundShippingTimeDay: 1,
    images: imageUrls.slice(0, 10).map((url, idx) => ({
      imageOrder: idx,
      imageType: idx === 0 ? 'REPRESENTATION' : 'DETAIL',
      vendorPath: url,
    })),
    attributes: combo.map((c) => ({ attributeTypeName: c.name, attributeValueName: c.value })),
  }));
}

/**
 * 쿠팡 직링크 templating (응답에서 productId 추출 후 조합)
 * @param {Object} apiResponse - 쿠팡 등록 API 응답
 * @returns {string} 직링크 URL
 */
function buildCoupangDirectLink(apiResponse) {
  const productId = apiResponse?.data?.productId || apiResponse?.productId || apiResponse?.data?.sellerProductId;
  if (!productId) return '';
  return `https://www.coupang.com/vp/products/${productId}`;
}

/**
 * 쿠팡 상품 등록 (Distribution)
 * @param {Object} params
 * @param {import('./lumi-product-schema').LumiProduct} params.lumiProduct
 * @param {Object} params.credentials - { ciphertext, iv, tag } 또는 { vendorId, accessKey, secretKey } (mock)
 * @param {string} [params.market_seller_id] - vendorId
 * @param {boolean} [params.mock]
 * @returns {Promise<{ success: boolean, market_product_id?: string, direct_link?: string, error?: string, status?: number, retryable?: boolean, raw?: Object }>}
 */
async function registerProduct({ lumiProduct, credentials, market_seller_id, mock }) {
  const { valid, errors } = validateLumiProduct(lumiProduct);
  if (!valid) {
    return { success: false, error: `Lumi 스키마 오류: ${errors.join(', ')}`, status: 400, retryable: false };
  }

  const isMock = mock === true || (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  if (isMock) {
    const fakeProductId = `MOCK_${Date.now()}`;
    return {
      success: true,
      market_product_id: fakeProductId,
      seller_product_id: `SP_${fakeProductId}`,
      direct_link: buildCoupangDirectLink({ data: { productId: fakeProductId } }),
      mock: true,
      raw: { mocked: true, payload_size: JSON.stringify(transformToCoupangPayload(lumiProduct, market_seller_id || 'A00012345')).length },
    };
  }

  // 실연동
  let creds;
  try {
    creds = (credentials && credentials.ciphertext) ? decrypt(credentials) : credentials;
  } catch (e) {
    return { success: false, error: '자격증명 복호화 실패', status: 500, retryable: false };
  }
  const vendorId = market_seller_id || creds?.vendorId;
  const accessKey = creds?.accessKey;
  const secretKey = creds?.secretKey;
  if (!vendorId || !accessKey || !secretKey) {
    return { success: false, error: '쿠팡 자격증명 누락', status: 401, retryable: false };
  }

  const payload = transformToCoupangPayload(lumiProduct, vendorId);
  const { authorization } = signCoupang({ method: 'POST', path: REGISTER_PATH, query: '', accessKey, secretKey });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${COUPANG_API_HOST}${REGISTER_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const retryable = err.name === 'AbortError' || /ECONN|timeout/i.test(err.message);
    return { success: false, error: '쿠팡 API 연결 실패', status: 0, retryable };
  }
  clearTimeout(timeout);

  let bodyText = '';
  try { bodyText = await response.text(); } catch (_) { /* */ }
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch (_) { /* */ }

  if (response.status === 200 || response.status === 201) {
    const productId = parsed?.data?.productId || parsed?.data?.sellerProductId;
    return {
      success: true,
      market_product_id: String(productId || ''),
      seller_product_id: String(parsed?.data?.sellerProductId || ''),
      direct_link: buildCoupangDirectLink(parsed),
      raw: parsed,
    };
  }

  // 4xx/5xx — retryable 판정
  const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
  return {
    success: false,
    status: response.status,
    error: parsed?.message || `쿠팡 등록 실패 (${response.status})`,
    retryable,
    raw: parsed,
  };
}

module.exports = {
  registerProduct,
  transformToCoupangPayload,
  buildCoupangDirectLink,
};
