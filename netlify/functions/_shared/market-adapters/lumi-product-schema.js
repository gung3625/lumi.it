// Lumi 표준 상품 스키마 — Sprint 2
// 모든 마켓 어댑터의 공통 입력 형식 (Normalization 결과)
//
// 설계 원칙:
// - 마켓별 차이는 market_overrides JSONB로 격리 (DB는 정규화)
// - AI 분석 결과 = 이 스키마로 정형화 (analyze-product-image 응답 = LumiProduct)
// - 셀러 검수 카드 5장 = 이 스키마의 5필드를 차례로 검토 (title/category/price/options/policy)
//
// JSDoc 타입 정의 (TypeScript 의존성 회피):

/**
 * @typedef {Object} CategorySuggestion
 * @property {string[]} tree - 카테고리 경로 (예: ['패션의류','여성','원피스'])
 * @property {number} confidence - 0~1 신뢰도
 * @property {string} [marketCategoryId] - 마켓별 leaf ID (Distribution 시 매핑)
 */

/**
 * @typedef {Object} ProductOption
 * @property {string} name - 옵션명 (예: '색상')
 * @property {string[]} values - 옵션값 (예: ['베이지','블랙'])
 */

/**
 * @typedef {Object} PolicyWarning
 * @property {string} word - 의심 단어 (예: '최고급')
 * @property {string} market - 'coupang'|'naver'|'common'
 * @property {string} cause - 친화 설명 (예: '과대광고 우려')
 * @property {string} suggestion - 대체 추천어 (예: '프리미엄')
 */

/**
 * @typedef {Object} DetailLayout
 * @property {string} [header_image]
 * @property {string[]} [key_points]
 * @property {Array<Object>} [size_table]
 * @property {string} [model_styling]
 * @property {string} [fabric_care]
 * @property {Array<{q:string,a:string}>} [faq]
 */

/**
 * @typedef {Object} LumiProduct
 * @property {string} title - 표준 상품명 (선택된 1안)
 * @property {string[]} [title_options] - 3안 (사용자 라디오 선택)
 * @property {string} [hook_caption] - 후킹 카피 1줄
 * @property {DetailLayout} [detail_layout] - 상세페이지 블록 미리보기
 * @property {Object<string, CategorySuggestion>} category_suggestions - { coupang, naver, toss }
 * @property {number} price_suggested - 권장가 (원)
 * @property {ProductOption[]} options
 * @property {string[]} keywords - SEO·검색 태그 (≤20)
 * @property {PolicyWarning[]} policy_warnings
 * @property {string[]} image_urls - Storage 업로드 URL (대표 + 추가)
 * @property {number} ai_confidence - 0~1 종합 신뢰도
 * @property {Object} [market_overrides] - 마켓별 커스터마이즈
 * @property {Object} [raw_ai] - 원본 AI 응답 (디버깅용)
 */

/**
 * Lumi 표준 스키마 검증
 * @param {LumiProduct} product
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateLumiProduct(product) {
  const errors = [];
  if (!product || typeof product !== 'object') {
    return { valid: false, errors: ['상품 객체가 비었습니다.'] };
  }
  if (!product.title || typeof product.title !== 'string' || product.title.length < 2) {
    errors.push('title 누락 또는 2자 미만');
  }
  if (product.title && product.title.length > 100) {
    errors.push('title 100자 초과');
  }
  if (typeof product.price_suggested !== 'number' || product.price_suggested < 0) {
    errors.push('price_suggested 음수 또는 누락');
  }
  if (!product.category_suggestions || typeof product.category_suggestions !== 'object') {
    errors.push('category_suggestions 누락');
  }
  if (!Array.isArray(product.options)) {
    errors.push('options 배열 아님');
  }
  if (!Array.isArray(product.keywords)) {
    errors.push('keywords 배열 아님');
  }
  if (product.keywords && product.keywords.length > 20) {
    errors.push('keywords 20개 초과 (쿠팡 권장 ≤20)');
  }
  if (!Array.isArray(product.image_urls) || product.image_urls.length === 0) {
    errors.push('image_urls 빈 배열');
  }
  if (typeof product.ai_confidence !== 'number' || product.ai_confidence < 0 || product.ai_confidence > 1) {
    errors.push('ai_confidence 0~1 범위 아님');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 빈 LumiProduct 생성 (모킹·테스트용)
 */
function emptyLumiProduct() {
  return {
    title: '',
    title_options: [],
    hook_caption: '',
    detail_layout: null,
    category_suggestions: {
      coupang: { tree: [], confidence: 0 },
      naver: { tree: [], confidence: 0 },
      toss: { tree: [], confidence: 0 },
    },
    price_suggested: 0,
    options: [],
    keywords: [],
    policy_warnings: [],
    image_urls: [],
    ai_confidence: 0,
    market_overrides: {},
  };
}

/**
 * AI 응답(GPT Vision raw)에서 LumiProduct로 변환
 * @param {Object} aiRaw - { product_name, category, price, options, keywords, ... }
 * @param {string[]} imageUrls
 * @returns {LumiProduct}
 */
function fromAiResponse(aiRaw, imageUrls = []) {
  const safe = aiRaw && typeof aiRaw === 'object' ? aiRaw : {};
  const baseTree = Array.isArray(safe.category) ? safe.category : (typeof safe.category === 'string' ? safe.category.split(/[>\/]/).map((s) => s.trim()).filter(Boolean) : []);
  const conf = typeof safe.category_confidence === 'number' ? safe.category_confidence : 0.7;

  // 3안 보정: 누락 시 product_name 기반 합성
  const baseTitle = String(safe.product_name || safe.title || '').slice(0, 100);
  let titleOptions = Array.isArray(safe.title_options)
    ? safe.title_options.filter((t) => typeof t === 'string' && t.trim()).slice(0, 3).map((t) => String(t).slice(0, 100))
    : [];
  if (titleOptions.length === 0 && baseTitle) titleOptions = [baseTitle];
  // 항상 첫 번째 = title 기준
  if (titleOptions[0] !== baseTitle && baseTitle) titleOptions[0] = baseTitle;

  // 상세 레이아웃 sanitize
  const dlRaw = safe.detail_layout && typeof safe.detail_layout === 'object' ? safe.detail_layout : null;
  const detailLayout = dlRaw ? {
    header_image: String(dlRaw.header_image || '').slice(0, 200),
    key_points: Array.isArray(dlRaw.key_points) ? dlRaw.key_points.slice(0, 6).map((s) => String(s).slice(0, 60)) : [],
    size_table: Array.isArray(dlRaw.size_table) ? dlRaw.size_table.slice(0, 12).map((row) => {
      if (!row || typeof row !== 'object') return null;
      const out = {};
      for (const k of Object.keys(row)) out[String(k).slice(0, 20)] = String(row[k]).slice(0, 40);
      return out;
    }).filter(Boolean) : [],
    model_styling: String(dlRaw.model_styling || '').slice(0, 120),
    fabric_care: String(dlRaw.fabric_care || '').slice(0, 200),
    faq: Array.isArray(dlRaw.faq) ? dlRaw.faq.slice(0, 6).map((f) => ({
      q: String(f?.q || '').slice(0, 120),
      a: String(f?.a || '').slice(0, 240),
    })).filter((f) => f.q && f.a) : [],
  } : null;

  return {
    title: baseTitle,
    title_options: titleOptions,
    hook_caption: String(safe.hook_caption || '').slice(0, 60),
    detail_layout: detailLayout,
    category_suggestions: {
      coupang: { tree: baseTree, confidence: conf },
      naver: { tree: baseTree, confidence: conf },
      toss: { tree: baseTree, confidence: conf },
    },
    price_suggested: Number(safe.price_suggested || safe.price || 0),
    options: Array.isArray(safe.options) ? safe.options.map((o) => ({
      name: String(o.name || '').slice(0, 20),
      values: Array.isArray(o.values) ? o.values.slice(0, 30).map((v) => String(v).slice(0, 30)) : [],
    })) : [],
    keywords: Array.isArray(safe.keywords) ? safe.keywords.slice(0, 20).map((k) => String(k).slice(0, 20)) : [],
    policy_warnings: Array.isArray(safe.policy_warnings) ? safe.policy_warnings : [],
    image_urls: imageUrls,
    ai_confidence: typeof safe.ai_confidence === 'number' ? safe.ai_confidence : 0.7,
    market_overrides: safe.market_overrides || {},
    raw_ai: safe,
  };
}

module.exports = {
  validateLumiProduct,
  emptyLumiProduct,
  fromAiResponse,
};
