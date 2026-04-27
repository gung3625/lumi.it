// 네이버 커머스 어댑터 — Sprint 2 Distribution 단계
// LumiProduct → 네이버 커머스 API 등록 → 직링크
//
// 마켓 표준 (검증된 사실):
// - 카테고리 4-depth (3단계 가능)
// - API 응답 = smartstoreProductId / originProductNo
// - 직링크 = https://smartstore.naver.com/{스토어아이디}/products/{smartstoreProductId} (직접 조합)
// - Access Token 3시간 유효, 만료 30분 전 자동 갱신
// - 응답 헤더 GNCP-GW-RateLimit-* 모니터링
//
// 모킹 (NAVER_VERIFY_MOCK=true): 외부 호출 스킵, 더미 ID 반환
// 토큰 갱신: shouldRefreshToken() + reissueToken() (실연동 시 caller에서 처리)

const fetch = require('node-fetch');
const crypto = require('crypto');
const { decrypt, decryptToken } = require('../encryption');
const { validateLumiProduct } = require('./lumi-product-schema');

const NAVER_API_HOST = 'https://api.commerce.naver.com';
const REGISTER_PATH = '/external/v2/products';
const TOKEN_PATH = '/external/v1/oauth2/token';

/**
 * 토큰 만료 30분 전 갱신 필요 여부 체크
 * @param {string} expiresAt - ISO timestamp
 * @returns {boolean}
 */
function shouldRefreshToken(expiresAt) {
  if (!expiresAt) return true;
  const exp = new Date(expiresAt).getTime();
  return (exp - Date.now()) < 30 * 60 * 1000;
}

/**
 * 네이버 토큰 재발급 (3시간 유효)
 * @param {Object} params
 * @param {string} params.applicationId
 * @param {string} params.applicationSecret
 * @returns {Promise<{ ok: boolean, accessToken?: string, expiresAt?: string, error?: string }>}
 */
async function reissueToken({ applicationId, applicationSecret }) {
  const timestamp = Date.now();
  const message = `${applicationSecret}_${timestamp}`;
  const sign = crypto
    .createHmac('sha256', Buffer.from(applicationSecret, 'utf8'))
    .update(Buffer.from(message, 'utf8'))
    .digest('base64');

  const params = new URLSearchParams({
    client_id: applicationId,
    timestamp: String(timestamp),
    client_secret_sign: sign,
    grant_type: 'client_credentials',
    type: 'SELF',
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${NAVER_API_HOST}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* */ }
    if (res.status === 200 && json && json.access_token) {
      const expiresIn = json.expires_in || 10800;
      return {
        ok: true,
        accessToken: json.access_token,
        expiresAt: new Date(Date.now() + (expiresIn - 60) * 1000).toISOString(),
      };
    }
    return { ok: false, error: '토큰 갱신 실패', status: res.status };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, error: '토큰 갱신 네트워크 오류: ' + err.message, retryable: true };
  }
}

/**
 * LumiProduct → 네이버 등록 페이로드 변환
 * @param {import('./lumi-product-schema').LumiProduct} lumiProduct
 * @returns {Object} 네이버 커머스 API body (간소화 버전)
 */
function transformToNaverPayload(lumiProduct) {
  const tree = lumiProduct.category_suggestions?.naver?.tree || [];
  const leafCategoryId = lumiProduct.category_suggestions?.naver?.marketCategoryId || null;

  return {
    originProduct: {
      statusType: 'SALE',
      saleType: 'NEW',
      leafCategoryId,
      categoryTree: tree,
      name: lumiProduct.title,
      detailContent: lumiProduct.market_overrides?.naver?.detail_html || `<p>${escapeHtml(lumiProduct.title)}</p>`,
      images: {
        representativeImage: { url: lumiProduct.image_urls?.[0] || '' },
        optionalImages: (lumiProduct.image_urls || []).slice(1, 10).map((url) => ({ url })),
      },
      salePrice: lumiProduct.price_suggested,
      stockQuantity: 999,
      deliveryInfo: {
        deliveryType: 'DELIVERY',
        deliveryAttributeType: 'NORMAL',
        deliveryFee: { deliveryFeeType: 'FREE', baseFee: 0 },
      },
      detailAttribute: {
        afterServiceInfo: { afterServiceTelephoneNumber: lumiProduct.market_overrides?.naver?.as_phone || '', afterServiceGuideContent: '판매자 문의' },
        originAreaInfo: { originAreaCode: '0200037', importer: '' },
        sellerCodeInfo: { sellerManagementCode: lumiProduct.market_overrides?.naver?.seller_code || '' },
        productInfoProvidedNotice: lumiProduct.market_overrides?.naver?.notice || {},
        seoInfo: {
          sellerTags: (lumiProduct.keywords || []).slice(0, 10).map((k) => ({ text: k })),
          metaDescription: lumiProduct.title,
        },
        optionInfo: lumiProduct.options && lumiProduct.options.length > 0 ? {
          optionCombinations: expandNaverOptions(lumiProduct.options, lumiProduct.price_suggested),
        } : null,
      },
    },
    smartstoreChannelProduct: {
      naverShoppingRegistration: true,
      channelProductDisplayStatusType: 'ON',
    },
  };
}

function expandNaverOptions(options, basePrice) {
  const combos = options.reduce((acc, opt) => {
    if (acc.length === 0) return opt.values.map((v) => [{ name: opt.name, value: v }]);
    return acc.flatMap((prev) => opt.values.map((v) => [...prev, { name: opt.name, value: v }]));
  }, []);

  return combos.slice(0, 100).map((combo) => {
    const detail = combo.reduce((acc, c, i) => {
      acc[`optionName${i + 1}`] = c.name;
      acc[`optionValue${i + 1}`] = c.value;
      return acc;
    }, {});
    return {
      ...detail,
      stockQuantity: 999,
      price: 0, // 추가요금 0
      usable: true,
    };
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 네이버 직링크 templating
 * @param {Object} apiResponse
 * @param {string} [storeId]
 * @returns {string}
 */
function buildNaverDirectLink(apiResponse, storeId) {
  const productId = apiResponse?.smartstoreChannelProductNo || apiResponse?.smartstoreProductId || apiResponse?.originProductNo;
  if (!productId) return '';
  if (!storeId) return `https://smartstore.naver.com/main/products/${productId}`;
  return `https://smartstore.naver.com/${storeId}/products/${productId}`;
}

/**
 * 네이버 상품 등록 (Distribution)
 * @param {Object} params
 * @param {import('./lumi-product-schema').LumiProduct} params.lumiProduct
 * @param {Object} params.credentials - 암호문 또는 평문 객체
 * @param {string} [params.access_token_encrypted] - encryptToken 결과 문자열
 * @param {string} [params.token_expires_at]
 * @param {string} [params.market_seller_id] - applicationId
 * @param {string} [params.store_id] - 스마트스토어 ID
 * @param {boolean} [params.mock]
 * @returns {Promise<{ success: boolean, market_product_id?: string, direct_link?: string, error?: string, status?: number, retryable?: boolean, rateLimit?: Object, raw?: Object }>}
 */
async function registerProduct({ lumiProduct, credentials, access_token_encrypted, token_expires_at, market_seller_id, store_id, mock }) {
  const { valid, errors } = validateLumiProduct(lumiProduct);
  if (!valid) {
    return { success: false, error: `Lumi 스키마 오류: ${errors.join(', ')}`, status: 400, retryable: false };
  }

  const isMock = mock === true || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  if (isMock) {
    const fakeProductId = `NV_MOCK_${Date.now()}`;
    return {
      success: true,
      market_product_id: fakeProductId,
      origin_product_no: `OP_${fakeProductId}`,
      direct_link: buildNaverDirectLink({ smartstoreProductId: fakeProductId }, store_id),
      mock: true,
      raw: { mocked: true, payload_size: JSON.stringify(transformToNaverPayload(lumiProduct)).length },
    };
  }

  // 실연동
  let creds;
  try {
    creds = (credentials && credentials.ciphertext) ? decrypt(credentials) : credentials;
  } catch (e) {
    return { success: false, error: '자격증명 복호화 실패', status: 500, retryable: false };
  }
  let accessToken = null;
  try {
    accessToken = access_token_encrypted ? decryptToken(access_token_encrypted) : null;
  } catch (e) { /* */ }

  // 토큰 갱신 필요 시
  if (!accessToken || shouldRefreshToken(token_expires_at)) {
    const reissue = await reissueToken({
      applicationId: creds?.applicationId,
      applicationSecret: creds?.applicationSecret,
    });
    if (!reissue.ok) {
      return { success: false, error: reissue.error || '토큰 갱신 실패', status: reissue.status || 0, retryable: !!reissue.retryable };
    }
    accessToken = reissue.accessToken;
  }

  const payload = transformToNaverPayload(lumiProduct);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${NAVER_API_HOST}${REGISTER_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const retryable = err.name === 'AbortError' || /ECONN|timeout/i.test(err.message);
    return { success: false, error: '네이버 API 연결 실패', status: 0, retryable };
  }
  clearTimeout(timeout);

  // Rate limit 모니터링 헤더
  const rateLimit = {
    remaining: response.headers.get('GNCP-GW-RateLimit-Remaining'),
    replenishRate: response.headers.get('GNCP-GW-RateLimit-Replenish-Rate'),
    burstCapacity: response.headers.get('GNCP-GW-RateLimit-Burst-Capacity'),
  };

  let bodyText = '';
  try { bodyText = await response.text(); } catch (_) { /* */ }
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch (_) { /* */ }

  if (response.status === 200 || response.status === 201) {
    const productId = parsed?.smartstoreChannelProductNo || parsed?.originProductNo;
    return {
      success: true,
      market_product_id: String(productId || ''),
      origin_product_no: String(parsed?.originProductNo || ''),
      direct_link: buildNaverDirectLink(parsed, store_id),
      rateLimit,
      raw: parsed,
    };
  }

  const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
  return {
    success: false,
    status: response.status,
    error: parsed?.message || `네이버 등록 실패 (${response.status})`,
    retryable,
    rateLimit,
    raw: parsed,
  };
}

module.exports = {
  registerProduct,
  transformToNaverPayload,
  buildNaverDirectLink,
  shouldRefreshToken,
  reissueToken,
};
