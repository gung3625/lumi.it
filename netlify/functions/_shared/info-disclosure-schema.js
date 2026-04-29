/**
 * 공정위 고시 기준 정보고시 스키마 (Phase A — 6종 카테고리)
 *
 * 출처:
 *   - 전자상거래법 제13조 제4항
 *   - 공정거래위원회 고시: 전자상거래등에서의상품등의정보제공에관한고시 (별표)
 *     https://www.law.go.kr (마지막 갱신 확인: 2025-08-01 기준)
 *   - 어린이제품 안전 특별법 (kids 카테고리 안전인증 근거)
 *
 * AI 추출 면책:
 *   모든 항목의 AI 추출값은 초안입니다.
 *   사장님이 검수하신 후 발행하면 사장님 책임이에요.
 */

'use strict';

// ─── 1. 식품 (농수축산물 포함) ────────────────────────────────────────────────
const FOOD_ITEMS = [
  {
    key: 'product_name',
    label: '제품명',
    required: true,
    type: 'text',
    extractable: true,
    hint: '상품명 또는 식품 라벨에서 자동 추출을 시도해요. 확인해 주세요.',
  },
  {
    key: 'food_type',
    label: '식품 유형',
    required: true,
    type: 'text',
    extractable: true,
    hint: '식품 유형 (예: 과자, 음료, 건강기능식품 등). 라벨 사진에서 추출 시도해요.',
  },
  {
    key: 'manufacturer',
    label: '제조원 및 소재지',
    required: true,
    type: 'text',
    extractable: true,
    hint: '제조사 이름과 소재지를 라벨에서 확인하여 입력해 주세요.',
  },
  {
    key: 'manufacture_date',
    label: '제조연월일',
    required: true,
    type: 'date',
    extractable: true,
    hint: '제조연월일을 라벨 사진에서 자동 추출 시도해요. 누락 시 직접 입력해 주세요.',
  },
  {
    key: 'expiry_date',
    label: '유통기한 (또는 소비기한)',
    required: true,
    type: 'date',
    extractable: true,
    hint: '유통기한·소비기한을 라벨 사진에서 자동 추출 시도해요.',
  },
  {
    key: 'volume_weight',
    label: '포장 단위별 내용물의 용량(중량)·수량',
    required: true,
    type: 'text',
    extractable: true,
    hint: '예: 500g, 1L, 30정 등. 라벨에서 추출 시도해요.',
  },
  {
    key: 'ingredients',
    label: '원재료명 및 함량',
    required: true,
    type: 'multiline',
    extractable: true,
    hint: '원재료명과 함량을 라벨 사진에서 추출 시도해요. AI 추출값은 반드시 검수해 주세요.',
  },
  {
    key: 'nutrition_facts',
    label: '영양성분',
    required: true,
    type: 'multiline',
    extractable: true,
    hint: '영양성분표를 사진에서 OCR 추출 시도해요. 누락·오류 시 직접 입력해 주세요.',
  },
  {
    key: 'gmo',
    label: '유전자변형식품 여부',
    required: true,
    type: 'text',
    extractable: false,
    hint: '유전자변형식품 해당 여부를 직접 입력해 주세요. (예: 해당 없음 / 유전자변형 OO 포함)',
  },
  {
    key: 'storage_method',
    label: '보관 방법',
    required: true,
    type: 'text',
    extractable: true,
    hint: '냉장·냉동·실온 등 보관방법을 라벨에서 추출 시도해요.',
  },
  {
    key: 'cs_contact',
    label: '소비자상담 연락처',
    required: true,
    type: 'text',
    extractable: false,
    hint: '고객센터 전화번호를 직접 입력해 주세요.',
  },
];

// ─── 2. 화장품 ─────────────────────────────────────────────────────────────────
const COSMETIC_ITEMS = [
  {
    key: 'product_name',
    label: '화장품 명칭',
    required: true,
    type: 'text',
    extractable: true,
    hint: '화장품 이름을 포장 사진에서 자동 추출 시도해요.',
  },
  {
    key: 'manufacturer_info',
    label: '제조업자·책임판매업자 상호 및 주소',
    required: true,
    type: 'text',
    extractable: true,
    hint: '포장 뒷면 제조사 정보에서 추출 시도해요. 확인해 주세요.',
  },
  {
    key: 'batch_number',
    label: '제조번호 (Batch No.)',
    required: true,
    type: 'text',
    extractable: true,
    hint: '제조번호를 포장 사진에서 OCR 추출 시도해요. 누락 시 직접 입력해 주세요.',
  },
  {
    key: 'expiry_or_pao',
    label: '사용기한 또는 개봉 후 사용기간',
    required: true,
    type: 'text',
    extractable: true,
    hint: '예: 2026-12-31 또는 개봉 후 12M. 포장에서 추출 시도해요.',
  },
  {
    key: 'full_ingredients',
    label: '모든 성분',
    required: true,
    type: 'multiline',
    extractable: true,
    hint: '전성분 목록을 사진에서 OCR 추출 시도해요. 반드시 검수해 주세요.',
  },
  {
    key: 'cautions',
    label: '사용 시 주의사항',
    required: true,
    type: 'multiline',
    extractable: true,
    hint: '주의사항을 포장에서 추출 시도해요. 누락·오류 시 직접 입력해 주세요.',
  },
  {
    key: 'volume_weight',
    label: '용량 또는 중량',
    required: true,
    type: 'text',
    extractable: true,
    hint: '예: 50ml, 30g. 포장에서 자동 추출 시도해요.',
  },
];

// ─── 3. 전기용품·생활가전 ──────────────────────────────────────────────────────
const ELECTRIC_ITEMS = [
  {
    key: 'product_name',
    label: '품명',
    required: true,
    type: 'text',
    extractable: true,
    hint: '제품 이름을 사진에서 자동 추출 시도해요.',
  },
  {
    key: 'model_name',
    label: '모델명',
    required: true,
    type: 'text',
    extractable: true,
    hint: '모델명을 제품 라벨·박스에서 추출 시도해요.',
  },
  {
    key: 'country_of_origin',
    label: '제조국',
    required: true,
    type: 'text',
    extractable: true,
    hint: '제조국을 라벨에서 추출 시도해요. (예: 대한민국, 중국)',
  },
  {
    key: 'manufacture_date',
    label: '제조연월',
    required: true,
    type: 'date',
    extractable: true,
    hint: '제조연월을 제품 라벨에서 추출 시도해요.',
  },
  {
    key: 'kc_certification',
    label: 'KC 인증 정보 (안전인증·안전확인·공급자적합성확인)',
    required: true,
    type: 'text',
    extractable: true,
    hint: 'KC 인증번호를 사진에서 자동 추출 시도해요. 누락 시 인증서를 확인하여 직접 입력해 주세요.',
  },
  {
    key: 'rated_voltage',
    label: '정격전압',
    required: true,
    type: 'text',
    extractable: true,
    hint: '예: AC 220V, 50/60Hz. 제품 라벨에서 추출 시도해요.',
  },
  {
    key: 'power_consumption',
    label: '소비전력',
    required: true,
    type: 'text',
    extractable: true,
    hint: '예: 100W. 제품 라벨에서 추출 시도해요.',
  },
  {
    key: 'release_date',
    label: '동일모델 출시년월',
    required: false,
    type: 'date',
    extractable: false,
    hint: '동일 모델의 최초 출시년월을 직접 입력해 주세요.',
  },
  {
    key: 'manufacturer',
    label: '제조사',
    required: true,
    type: 'text',
    extractable: true,
    hint: '제조사 이름을 제품 라벨에서 추출 시도해요.',
  },
  {
    key: 'as_contact',
    label: 'A/S 책임자 및 연락처',
    required: true,
    type: 'text',
    extractable: false,
    hint: 'A/S 책임자(업체명)와 전화번호를 직접 입력해 주세요.',
  },
];

// ─── 4. 의류·섬유·신변잡화 ────────────────────────────────────────────────────
const CLOTHING_ITEMS = [
  {
    key: 'material',
    label: '제품 소재',
    required: true,
    type: 'text',
    extractable: true,
    hint: '소재 구성을 태그·사진에서 추출 시도해요. (예: 면 100%, 폴리에스터 80% + 나일론 20%)',
  },
  {
    key: 'color',
    label: '색상',
    required: true,
    type: 'text',
    extractable: true,
    hint: '상품 색상을 사진에서 추출 시도해요.',
  },
  {
    key: 'size',
    label: '치수',
    required: true,
    type: 'text',
    extractable: false,
    hint: '사이즈 표기(예: S/M/L/XL 또는 55/66/77)를 직접 입력해 주세요.',
  },
  {
    key: 'manufacturer_importer',
    label: '제조자·수입자',
    required: true,
    type: 'text',
    extractable: false,
    hint: '제조자 또는 수입자 상호를 직접 입력해 주세요.',
  },
  {
    key: 'country_of_origin',
    label: '제조국',
    required: true,
    type: 'text',
    extractable: true,
    hint: '제조국을 태그·라벨에서 추출 시도해요.',
  },
  {
    key: 'washing_instructions',
    label: '세탁 방법 및 취급 시 주의사항',
    required: true,
    type: 'multiline',
    extractable: true,
    hint: '세탁 기호·주의사항을 태그 사진에서 추출 시도해요. 반드시 검수해 주세요.',
  },
  {
    key: 'manufacture_date',
    label: '제조연월',
    required: false,
    type: 'date',
    extractable: false,
    hint: '제조연월을 직접 입력해 주세요. (해당 시)',
  },
  {
    key: 'quality_guarantee',
    label: '품질보증기준',
    required: true,
    type: 'text',
    extractable: false,
    hint: '예: 구매일로부터 6개월 이내 품질 이상 시 교환·환불. 직접 입력해 주세요.',
  },
  {
    key: 'as_contact',
    label: 'A/S 책임자 및 전화번호',
    required: true,
    type: 'text',
    extractable: false,
    hint: 'A/S 책임자(업체명)와 전화번호를 직접 입력해 주세요.',
  },
];

// ─── 5. 생활용품 ───────────────────────────────────────────────────────────────
const LIVING_ITEMS = [
  {
    key: 'product_name',
    label: '품명',
    required: true,
    type: 'text',
    extractable: true,
    hint: '제품 이름을 사진에서 자동 추출 시도해요.',
  },
  {
    key: 'model_name',
    label: '모델명',
    required: false,
    type: 'text',
    extractable: true,
    hint: '모델명이 있을 경우 사진·라벨에서 추출 시도해요.',
  },
  {
    key: 'material',
    label: '재질',
    required: true,
    type: 'text',
    extractable: true,
    hint: '주요 재질을 라벨·사진에서 추출 시도해요. (예: ABS 플라스틱, 스테인리스 304)',
  },
  {
    key: 'fuel_or_purpose',
    label: '사용 연료·용도 (해당 시)',
    required: false,
    type: 'text',
    extractable: false,
    hint: '연료 또는 주요 용도가 있는 경우 직접 입력해 주세요.',
  },
  {
    key: 'color',
    label: '색상',
    required: false,
    type: 'text',
    extractable: true,
    hint: '색상을 사진에서 추출 시도해요.',
  },
  {
    key: 'size',
    label: '크기',
    required: false,
    type: 'text',
    extractable: false,
    hint: '가로×세로×높이 또는 지름 등을 직접 입력해 주세요.',
  },
  {
    key: 'certification',
    label: '인증기준 및 인증번호 (해당 시)',
    required: false,
    type: 'text',
    extractable: true,
    hint: 'KC 등 인증번호를 사진에서 자동 추출 시도해요. 해당하지 않으면 "해당 없음"으로 입력해 주세요.',
  },
  {
    key: 'safety_standard',
    label: '안전기준 (해당 시)',
    required: false,
    type: 'text',
    extractable: false,
    hint: '안전기준이 있는 경우 직접 입력해 주세요.',
  },
  {
    key: 'country_of_origin',
    label: '제조국',
    required: true,
    type: 'text',
    extractable: true,
    hint: '제조국을 라벨에서 추출 시도해요.',
  },
  {
    key: 'manufacture_date',
    label: '제조연월',
    required: false,
    type: 'date',
    extractable: false,
    hint: '제조연월을 직접 입력해 주세요.',
  },
  {
    key: 'as_contact',
    label: 'A/S 책임자 및 연락처',
    required: true,
    type: 'text',
    extractable: false,
    hint: 'A/S 책임자(업체명)와 전화번호를 직접 입력해 주세요.',
  },
];

// ─── 6. 유아용품 ───────────────────────────────────────────────────────────────
const KIDS_ITEMS = [
  {
    key: 'product_name',
    label: '품명',
    required: true,
    type: 'text',
    extractable: true,
    hint: '제품 이름을 사진에서 자동 추출 시도해요.',
  },
  {
    key: 'model_name',
    label: '모델명',
    required: false,
    type: 'text',
    extractable: true,
    hint: '모델명을 박스·라벨에서 추출 시도해요.',
  },
  {
    key: 'material',
    label: '재질',
    required: true,
    type: 'text',
    extractable: true,
    hint: '주요 재질을 라벨에서 추출 시도해요.',
  },
  {
    key: 'age_range',
    label: '사용 연령',
    required: true,
    type: 'text',
    extractable: true,
    hint: '예: 만 3세 이상, 0~36개월. 포장에서 추출 시도해요.',
  },
  {
    key: 'kc_certification',
    label: 'KC 안전인증 정보 (어린이제품 안전 특별법)',
    required: true,
    type: 'text',
    extractable: true,
    hint: 'KC 인증번호를 사진에서 자동 추출 시도해요. 어린이제품은 법적 의무 항목이에요. 누락 시 인증서를 확인하여 직접 입력해 주세요.',
  },
  {
    key: 'color',
    label: '색상',
    required: false,
    type: 'text',
    extractable: true,
    hint: '색상을 사진에서 추출 시도해요.',
  },
  {
    key: 'size',
    label: '크기',
    required: false,
    type: 'text',
    extractable: false,
    hint: '크기(가로×세로×높이 등)를 직접 입력해 주세요.',
  },
  {
    key: 'country_of_origin',
    label: '제조국',
    required: true,
    type: 'text',
    extractable: true,
    hint: '제조국을 포장에서 추출 시도해요.',
  },
  {
    key: 'manufacture_date',
    label: '제조연월',
    required: false,
    type: 'date',
    extractable: false,
    hint: '제조연월을 직접 입력해 주세요.',
  },
  {
    key: 'cautions',
    label: '사용 시 주의사항',
    required: true,
    type: 'multiline',
    extractable: true,
    hint: '안전 주의사항을 포장에서 추출 시도해요. 어린이 안전과 직결되므로 반드시 검수해 주세요.',
  },
  {
    key: 'as_contact',
    label: 'A/S 책임자 및 연락처',
    required: true,
    type: 'text',
    extractable: false,
    hint: 'A/S 책임자(업체명)와 전화번호를 직접 입력해 주세요.',
  },
];

// ─── 카테고리 레지스트리 ────────────────────────────────────────────────────────
const SCHEMA_REGISTRY = {
  food: {
    key: 'food',
    label: '식품 (농수축산물 포함)',
    disclaimer:
      'AI가 채운 초안입니다. 사장님이 검수하신 후 발행하면 사장님 책임이에요.',
    items: FOOD_ITEMS,
  },
  cosmetic: {
    key: 'cosmetic',
    label: '화장품',
    disclaimer:
      'AI가 채운 초안입니다. 사장님이 검수하신 후 발행하면 사장님 책임이에요.',
    items: COSMETIC_ITEMS,
  },
  electric: {
    key: 'electric',
    label: '전기용품·생활가전',
    disclaimer:
      'AI가 채운 초안입니다. 사장님이 검수하신 후 발행하면 사장님 책임이에요.',
    items: ELECTRIC_ITEMS,
  },
  clothing: {
    key: 'clothing',
    label: '의류·섬유·신변잡화',
    disclaimer:
      'AI가 채운 초안입니다. 사장님이 검수하신 후 발행하면 사장님 책임이에요.',
    items: CLOTHING_ITEMS,
  },
  living: {
    key: 'living',
    label: '생활용품',
    disclaimer:
      'AI가 채운 초안입니다. 사장님이 검수하신 후 발행하면 사장님 책임이에요.',
    items: LIVING_ITEMS,
  },
  kids: {
    key: 'kids',
    label: '유아용품',
    disclaimer:
      'AI가 채운 초안입니다. 사장님이 검수하신 후 발행하면 사장님 책임이에요.',
    items: KIDS_ITEMS,
  },
};

// ─── 마켓 카테고리 → 정보고시 카테고리 매핑 (Phase B에서 채움) ────────────────
/**
 * 마켓 대분류 → 정보고시 categoryKey 매핑.
 * Phase B에서 쿠팡·네이버·토스 카테고리 트리에 맞게 채울 placeholder.
 *
 * @type {Object.<string, Object.<string, string>>}
 */
const MARKET_CATEGORY_TO_DISCLOSURE_MAP = {
  coupang: {
    // TODO Phase B: 쿠팡 대분류 categoryId → 정보고시 categoryKey
    // 예: '1001': 'food', '2001': 'clothing'
  },
  naver: {
    // TODO Phase B: 네이버 스마트스토어 대분류 코드 → 정보고시 categoryKey
  },
  toss: {
    // TODO Phase B: 토스쇼핑 대분류 코드 → 정보고시 categoryKey
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * 카테고리 키로 스키마 전체를 반환.
 *
 * @param {string} categoryKey - 'food' | 'cosmetic' | 'electric' | 'clothing' | 'living' | 'kids'
 * @returns {{ key: string, label: string, disclaimer: string, items: Array } | null}
 */
function getCategorySchema(categoryKey) {
  return SCHEMA_REGISTRY[categoryKey] || null;
}

/**
 * 카테고리의 필수(required=true) 항목만 반환.
 *
 * @param {string} categoryKey
 * @returns {Array}
 */
function getRequiredItems(categoryKey) {
  const schema = SCHEMA_REGISTRY[categoryKey];
  if (!schema) return [];
  return schema.items.filter((item) => item.required === true);
}

/**
 * 마켓명 + 마켓 카테고리 ID로 정보고시 categoryKey를 반환.
 * Phase B에서 MARKET_CATEGORY_TO_DISCLOSURE_MAP을 채운 후 동작.
 *
 * @param {string} marketName - 'coupang' | 'naver' | 'toss'
 * @param {string|number} marketCategoryId
 * @returns {string | null} 정보고시 categoryKey 또는 null
 */
function mapMarketCategoryToInfoCategory(marketName, marketCategoryId) {
  const marketMap = MARKET_CATEGORY_TO_DISCLOSURE_MAP[marketName];
  if (!marketMap) return null;
  return marketMap[String(marketCategoryId)] || null;
}

module.exports = {
  SCHEMA_REGISTRY,
  MARKET_CATEGORY_TO_DISCLOSURE_MAP,
  getCategorySchema,
  getRequiredItems,
  mapMarketCategoryToInfoCategory,
};
