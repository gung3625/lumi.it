// 상품 이미지 AI 분석 — Sprint 2 (Normalization 단계 핵심)
// POST /api/analyze-product-image
// Body: { imageUrl: string } 또는 { imageUrls: string[] }
//
// GPT-4o-mini Vision (1차) → 모호 시 GPT-4o (2차, 옵션) → Lumi 표준 스키마
//
// 모킹: AI_PRODUCT_ANALYZE_MOCK=true → 더미 LumiProduct 반환
//
// 비용: gpt-4o-mini ≈ $0.001 / 이미지 (₩1.4)
//       gpt-4o ≈ $0.005 / 이미지 (₩7.0) — 모호 시만

const fetch = require('node-fetch');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');
const { fromAiResponse, validateLumiProduct } = require('./_shared/market-adapters/lumi-product-schema');
const { checkPolicyWords } = require('./_shared/policy-words');
const { getCategorySchema, getRequiredItems } = require('./_shared/info-disclosure-schema');

// 한국 이커머스 대분류 키워드 → 정보고시 카테고리 키 매핑 (AI 응답 category[0] 기준)
const AI_CATEGORY_TO_DISCLOSURE_MAP = {
  식품: 'food', 농산물: 'food', 수산물: 'food', 축산물: 'food', 건강식품: 'food',
  건강기능식품: 'food', 간식: 'food', 음료: 'food', 가공식품: 'food',
  화장품: 'cosmetic', 뷰티: 'cosmetic', 스킨케어: 'cosmetic', 헤어케어: 'cosmetic',
  메이크업: 'cosmetic', 향수: 'cosmetic', 바디케어: 'cosmetic',
  전자제품: 'electric', 생활가전: 'electric', 가전: 'electric', 디지털: 'electric',
  컴퓨터: 'electric', 스마트폰: 'electric', 카메라: 'electric', 전기용품: 'electric',
  패션의류: 'clothing', 의류: 'clothing', 패션: 'clothing', 여성의류: 'clothing',
  남성의류: 'clothing', 아동의류: 'clothing', 언더웨어: 'clothing', 스포츠의류: 'clothing',
  신발: 'clothing', 잡화: 'clothing', 가방: 'clothing', 액세서리: 'clothing',
  생활용품: 'living', 주방용품: 'living', 욕실용품: 'living', 청소용품: 'living',
  문구: 'living', 인테리어: 'living', 홈데코: 'living', 반려동물: 'living',
  유아용품: 'kids', 완구: 'kids', 육아용품: 'kids', 어린이: 'kids', 장난감: 'kids',
};

/**
 * AI 응답 category 배열 → 정보고시 categoryKey 결정.
 * category[0] (대분류)을 우선 매핑, 못 찾으면 category[1] 시도.
 * @param {string[]} categoryArr - AI 응답의 category 배열
 * @returns {string|null}
 */
function mapAiCategoryToDisclosureKey(categoryArr) {
  if (!Array.isArray(categoryArr) || categoryArr.length === 0) return null;
  for (const cat of categoryArr.slice(0, 2)) {
    if (!cat) continue;
    // 완전 일치 우선
    if (AI_CATEGORY_TO_DISCLOSURE_MAP[cat]) return AI_CATEGORY_TO_DISCLOSURE_MAP[cat];
    // 부분 일치
    const found = Object.keys(AI_CATEGORY_TO_DISCLOSURE_MAP).find((k) => cat.includes(k) || k.includes(cat));
    if (found) return AI_CATEGORY_TO_DISCLOSURE_MAP[found];
  }
  return null;
}

/**
 * extractable 항목 목록을 LLM 프롬프트용 텍스트로 변환.
 * @param {Array} items
 * @returns {string}
 */
function buildInfoDisclosurePromptSection(items) {
  const extractable = items.filter((i) => i.extractable);
  if (extractable.length === 0) return '';
  const lines = extractable.map((i) => `  - key="${i.key}" label="${i.label}" hint="${i.hint}"`);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `당신은 한국 이커머스 상품 등록 전문가입니다.
주어진 상품 이미지를 분석하여 다음 JSON 형식으로만 응답하세요. 다른 설명은 절대 추가하지 마세요.

{
  "product_name": "상품명 (한국어 50자 이내, A안과 동일)",
  "title_options": ["A안 (감성·후킹 중심, 30~45자)", "B안 (스펙·소재 중심, 30~45자)", "C안 (가격·실용 중심, 30~45자)"],
  "hook_caption": "후킹 카피 1줄 (20~35자, 마켓 상단 노출용 짧은 한 줄)",
  "category": ["대분류","중분류","소분류"],
  "category_confidence": 0.0~1.0,
  "price_suggested": 권장 판매가 (원, 정수),
  "options": [{"name":"옵션명","values":["값1","값2"]}],
  "keywords": ["검색키워드 1~20개"],
  "detail_layout": {
    "header_image": "대표 이미지 슬롯 설명 (예: '코트 정면 풀샷')",
    "key_points": ["핵심 셀링포인트 3~5개 (소재·기능·핏 등 짧은 문구)"],
    "size_table": [{"label":"M","chest":"95","length":"110"}, {"label":"L","chest":"100","length":"112"}],
    "model_styling": "모델 사이즈/스타일링 한 줄 (예: '키 165cm M 사이즈 착용')",
    "fabric_care": "소재·세탁 방법 한 줄",
    "faq": [{"q":"질문","a":"답"}]
  },
  "ai_confidence": 0.0~1.0,
  "info_disclosure": {
    "category": "식품|화장품|전기용품·생활가전|의류·섬유·신변잡화|생활용품|유아용품 중 하나 (이미지·카테고리 기반 자동 결정)",
    "items": {
      "<key>": { "value": "추출값 (불확실하면 빈 문자열)", "confidence": 0.0~1.0, "source": "image|title|description|null" }
    }
  }
}

[정보고시 추출 규칙]
- info_disclosure.items 는 아래 [추출 항목 목록]에 명시된 key 만 포함하세요. 목록에 없는 key 추가 금지.
- value: 사진·상품명에서 명확히 보이는 정보만 기입. 확실하지 않으면 반드시 빈 문자열("") 로 두세요. 가짜 데이터·추측 금지.
- confidence: 0.0(전혀 모름)~1.0(확실). 빈 문자열 시 0으로 설정.
- source: 어느 입력에서 추출했는지 — "image"(사진), "title"(상품명), "description"(설명 텍스트), null(추출 못 함).
- 카테고리는 대분류(category[0])를 기준으로 자동 결정. 해당 카테고리의 항목만 추출하세요.
- 법적 책임: 추출값의 정확성은 사장님이 최종 검수합니다. 틀린 값보다 빈 값이 낫습니다.

[추출 항목 목록은 카테고리별로 동적 주입됨 — 아래 참조]
__INFO_DISCLOSURE_ITEMS_PLACEHOLDER__

규칙:
- product_name = title_options[0] 와 동일하게 맞추세요.
- title_options 3안은 서로 톤이 달라야 합니다 (감성 / 스펙 / 가격).
- hook_caption 은 마침표 없이, 1줄, 20~35자.
- 상품명은 마켓 노출용 (브랜드+상품종류+속성). 과대광고 단어 금지 (최고급/최저가/완치/치료 등).
- 카테고리는 일반적 한국 이커머스 분류 (예: 패션의류 > 여성 > 원피스).
- 가격은 비슷한 상품 평균가 기준 합리적 추정.
- 옵션은 사진에서 추론 가능한 것만 (색상/사이즈 등). 추론 불가 시 빈 배열.
- 키워드는 검색 트렌드·SEO 고려, 띄어쓰기 없이 한 단어씩.
- detail_layout 은 상세페이지 블록 미리보기. 이미지 슬롯은 텍스트 설명만 (URL 아님).
- size_table·faq 는 추론 불가 시 빈 배열로 두세요. 가짜 데이터 금지.`;

const MOCK_RESPONSE = {
  product_name: '베이직 코튼 후드 티셔츠 (남녀공용)',
  title_options: [
    '베이직 코튼 후드 티셔츠 (남녀공용)',
    '오버핏 100% 면 후드티 — 봄가을 데일리',
    '가성비 후드 티셔츠 데일리 베이직 3color',
  ],
  hook_caption: '봄가을 매일 입는 코튼 후드',
  category: ['패션의류', '남성의류', '티셔츠'],
  category_confidence: 0.88,
  price_suggested: 29000,
  options: [
    { name: '색상', values: ['그레이', '블랙', '화이트'] },
    { name: '사이즈', values: ['M', 'L', 'XL'] },
  ],
  keywords: ['후드', '티셔츠', '코튼', '남성', '베이직', '봄', '데일리', '면', '심플'],
  detail_layout: {
    header_image: '후드 티셔츠 정면 풀샷',
    key_points: ['100% 면 코튼', '오버핏 실루엣', '세탁기 사용 가능', '남녀공용 사이즈'],
    size_table: [
      { label: 'M', chest: '110', length: '70' },
      { label: 'L', chest: '115', length: '72' },
      { label: 'XL', chest: '120', length: '74' },
    ],
    model_styling: '키 175cm 65kg M 사이즈 착용',
    fabric_care: '면 100% / 30도 미만 단독 세탁 / 다림질 가능',
    faq: [
      { q: '여자도 입을 수 있나요?', a: '네, 남녀공용으로 제작되어 사이즈만 맞추시면 됩니다.' },
    ],
  },
  ai_confidence: 0.86,
  info_disclosure: {
    category: '의류·섬유·신변잡화',
    items: {
      material: { value: '면 100%', confidence: 0.9, source: 'image' },
      color: { value: '그레이, 블랙, 화이트', confidence: 0.95, source: 'image' },
      size: { value: '', confidence: 0, source: null },
      manufacturer_importer: { value: '', confidence: 0, source: null },
      country_of_origin: { value: '', confidence: 0, source: null },
      washing_instructions: { value: '30도 미만 단독 세탁 / 다림질 가능', confidence: 0.75, source: 'image' },
      manufacture_date: { value: '', confidence: 0, source: null },
      quality_guarantee: { value: '', confidence: 0, source: null },
      as_contact: { value: '', confidence: 0, source: null },
    },
  },
};

async function callOpenAIVision({ imageUrl, model = 'gpt-4o-mini', systemPrompt = SYSTEM_PROMPT }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'OPENAI_API_KEY 미설정' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2400,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: '이 상품 이미지를 분석해주세요. JSON으로만 응답하세요.' },
              { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, error: err.name === 'AbortError' ? '분석 시간 초과' : 'OpenAI 연결 실패: ' + err.message };
  }
  clearTimeout(timeout);

  const text = await response.text();
  if (!response.ok) {
    return { ok: false, error: `OpenAI 오류 (${response.status})`, status: response.status };
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { /* */ }
  const content = parsed?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: '응답 형식 오류' };
  let json = null;
  try { json = JSON.parse(content); } catch (_) {
    return { ok: false, error: 'JSON 파싱 실패' };
  }
  return { ok: true, data: json, model };
}

/**
 * AI 응답의 info_disclosure 필드를 정규화하고 missingRequired·disclaimer를 추가.
 * @param {object} aiData - AI 원본 응답 JSON
 * @param {string} disclosureCategoryKey - 정보고시 카테고리 키
 * @returns {object} 정규화된 infoDisclosure 객체
 */
function buildInfoDisclosure(aiData, disclosureCategoryKey) {
  const schema = getCategorySchema(disclosureCategoryKey);
  if (!schema) return null;

  const aiItems = (aiData.info_disclosure && typeof aiData.info_disclosure.items === 'object')
    ? aiData.info_disclosure.items
    : {};

  // 스키마에 정의된 모든 항목을 순회하여 정규화
  const normalizedItems = {};
  for (const schemaItem of schema.items) {
    const raw = aiItems[schemaItem.key];
    if (raw && typeof raw === 'object') {
      normalizedItems[schemaItem.key] = {
        value: typeof raw.value === 'string' ? raw.value : '',
        confidence: typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0,
        source: ['image', 'title', 'description'].includes(raw.source) ? raw.source : null,
      };
    } else {
      // AI가 해당 key를 반환하지 않은 경우 빈 항목으로 채움
      normalizedItems[schemaItem.key] = { value: '', confidence: 0, source: null };
    }
  }

  // 필수 항목 중 비어 있는 항목 목록
  const requiredItems = getRequiredItems(disclosureCategoryKey);
  const missingRequired = requiredItems
    .filter((item) => !normalizedItems[item.key] || !normalizedItems[item.key].value)
    .map((item) => item.key);

  return {
    category: disclosureCategoryKey,
    categoryLabel: schema.label,
    items: normalizedItems,
    missingRequired,
    disclaimer: 'AI가 생성한 초안입니다. 사장님이 검수·수정 후 발행해 주세요. 정확성·법적 적합성 책임은 사장님께 있습니다.',
  };
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
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls : (body.imageUrl ? [body.imageUrl] : []);
  if (imageUrls.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이미지 URL이 필요합니다.' }) };
  }
  const primaryImage = imageUrls[0];

  const isMock = (process.env.AI_PRODUCT_ANALYZE_MOCK || 'true').toLowerCase() !== 'false';

  // 3. AI 호출 (또는 모킹)
  let aiResult;
  let usedModel = 'mock';
  if (isMock || !process.env.OPENAI_API_KEY) {
    aiResult = { ok: true, data: { ...MOCK_RESPONSE }, model: 'mock' };
    usedModel = 'mock';
  } else {
    // Quota 검증 (gpt-4o-mini ₩5/호출)
    try {
      await checkAndIncrementQuota(payload.seller_id, 'gpt-4o-mini');
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        const CORS = corsHeaders(getOrigin(event));
        return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: e.message }) };
      }
      throw e;
    }
    // 정보고시 카테고리는 1차 호출 전에 미리 알 수 없으므로, 첫 응답에서 category를 확인 후 프롬프트에 항목 주입
    // 1차: gpt-4o-mini — 모든 카테고리 공통 항목 없이 카테고리 분류만 먼저 받기 어려우므로,
    // 대신 SYSTEM_PROMPT의 placeholder를 빈 상태로 보내 카테고리 분류 결과를 받은 뒤 처리
    const firstPrompt = SYSTEM_PROMPT.replace('__INFO_DISCLOSURE_ITEMS_PLACEHOLDER__',
      '(카테고리 분류 후 자동 결정됩니다. 지금은 info_disclosure.items 를 빈 객체 {} 로 두세요.)');
    aiResult = await callOpenAIVision({ imageUrl: primaryImage, model: 'gpt-4o-mini', systemPrompt: firstPrompt });
    usedModel = 'gpt-4o-mini';

    // 카테고리 분류 결과로 정보고시 카테고리 결정 후 items 포함 프롬프트로 2차 호출
    if (aiResult.ok && aiResult.data) {
      const disclosureKey = mapAiCategoryToDisclosureKey(aiResult.data.category);
      if (disclosureKey) {
        const schema = getCategorySchema(disclosureKey);
        if (schema) {
          const itemsSection = buildInfoDisclosurePromptSection(schema.items);
          const secondPrompt = SYSTEM_PROMPT.replace('__INFO_DISCLOSURE_ITEMS_PLACEHOLDER__',
            `카테고리: ${schema.label}\n추출 대상 항목:\n${itemsSection}`);
          const secondResult = await callOpenAIVision({ imageUrl: primaryImage, model: 'gpt-4o-mini', systemPrompt: secondPrompt });
          if (secondResult.ok) {
            aiResult = secondResult;
          }
        }
      }
    }

    // 2차: ai_confidence 낮으면 gpt-4o로 재시도
    if (aiResult.ok && aiResult.data && typeof aiResult.data.ai_confidence === 'number' && aiResult.data.ai_confidence < 0.6) {
      const disclosureKey2 = mapAiCategoryToDisclosureKey(aiResult.data.category);
      const schema2 = disclosureKey2 ? getCategorySchema(disclosureKey2) : null;
      const retryPrompt = schema2
        ? SYSTEM_PROMPT.replace('__INFO_DISCLOSURE_ITEMS_PLACEHOLDER__',
            `카테고리: ${schema2.label}\n추출 대상 항목:\n${buildInfoDisclosurePromptSection(schema2.items)}`)
        : SYSTEM_PROMPT.replace('__INFO_DISCLOSURE_ITEMS_PLACEHOLDER__',
            '(카테고리 분류 후 자동 결정됩니다. info_disclosure.items 를 빈 객체 {} 로 두세요.)');
      const retry = await callOpenAIVision({ imageUrl: primaryImage, model: 'gpt-4o', systemPrompt: retryPrompt });
      if (retry.ok) {
        aiResult = retry;
        usedModel = 'gpt-4o';
      }
    }
  }

  if (!aiResult.ok) {
    console.log(`[analyze-product-image] ai_failed seller=${payload.seller_id.slice(0, 8)} status=${aiResult.status}`);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: false,
        error: aiResult.error || 'AI 분석에 실패했어요. 사진을 다시 올려주세요.',
      }),
    };
  }

  // 4. Lumi 표준 스키마로 변환
  const lumiProduct = fromAiResponse(aiResult.data, imageUrls);

  // 5. 정책 위반 단어 1차 검사 (사전 매칭)
  const policyWarnings = checkPolicyWords(lumiProduct.title, ['coupang', 'naver']);
  lumiProduct.policy_warnings = policyWarnings;

  // 5b. 정보고시 후처리 — AI 응답에서 카테고리 결정 후 정규화
  const disclosureCategoryKey = isMock
    ? 'clothing'
    : mapAiCategoryToDisclosureKey(aiResult.data.category);
  const infoDisclosure = disclosureCategoryKey
    ? buildInfoDisclosure(aiResult.data, disclosureCategoryKey)
    : null;

  // 6. 검증
  const { valid, errors } = validateLumiProduct(lumiProduct);
  if (!valid) {
    console.warn(`[analyze-product-image] schema_invalid seller=${payload.seller_id.slice(0, 8)} errors=${errors.join(',')}`);
    // 일부 필드 미충족이라도 셀러가 검수 카드에서 수정 가능하므로 200 반환 + warning
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        product: lumiProduct,
        infoDisclosure,
        warnings: errors,
        model: usedModel,
        mock: usedModel === 'mock',
      }),
    };
  }

  console.log(`[analyze-product-image] ok seller=${payload.seller_id.slice(0, 8)} model=${usedModel} confidence=${lumiProduct.ai_confidence}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      product: lumiProduct,
      infoDisclosure,
      model: usedModel,
      mock: usedModel === 'mock',
    }),
  };
};
