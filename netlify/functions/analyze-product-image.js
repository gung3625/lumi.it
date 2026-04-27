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
const { fromAiResponse, validateLumiProduct } = require('./_shared/market-adapters/lumi-product-schema');
const { checkPolicyWords } = require('./_shared/policy-words');

const SYSTEM_PROMPT = `당신은 한국 이커머스 상품 등록 전문가입니다.
주어진 상품 이미지를 분석하여 다음 JSON 형식으로만 응답하세요. 다른 설명은 절대 추가하지 마세요.

{
  "product_name": "상품명 (한국어 50자 이내)",
  "category": ["대분류","중분류","소분류"],
  "category_confidence": 0.0~1.0,
  "price_suggested": 권장 판매가 (원, 정수),
  "options": [{"name":"옵션명","values":["값1","값2"]}],
  "keywords": ["검색키워드 1~20개"],
  "ai_confidence": 0.0~1.0
}

규칙:
- 상품명은 마켓 노출용 (브랜드+상품종류+속성). 과대광고 단어 금지 (최고급/최저가/완치/치료 등).
- 카테고리는 일반적 한국 이커머스 분류 (예: 패션의류 > 여성 > 원피스).
- 가격은 비슷한 상품 평균가 기준 합리적 추정.
- 옵션은 사진에서 추론 가능한 것만 (색상/사이즈 등). 추론 불가 시 빈 배열.
- 키워드는 검색 트렌드·SEO 고려, 띄어쓰기 없이 한 단어씩.`;

const MOCK_RESPONSE = {
  product_name: '베이직 코튼 후드 티셔츠',
  category: ['패션의류', '남성의류', '티셔츠'],
  category_confidence: 0.88,
  price_suggested: 29000,
  options: [
    { name: '색상', values: ['그레이', '블랙', '화이트'] },
    { name: '사이즈', values: ['M', 'L', 'XL'] },
  ],
  keywords: ['후드', '티셔츠', '코튼', '남성', '베이직', '봄', '데일리', '면', '심플'],
  ai_confidence: 0.86,
};

async function callOpenAIVision({ imageUrl, model = 'gpt-4o-mini' }) {
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
        max_tokens: 800,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
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
    // 1차: gpt-4o-mini
    aiResult = await callOpenAIVision({ imageUrl: primaryImage, model: 'gpt-4o-mini' });
    usedModel = 'gpt-4o-mini';
    // 2차: confidence 낮으면 gpt-4o로 재시도
    if (aiResult.ok && aiResult.data && typeof aiResult.data.ai_confidence === 'number' && aiResult.data.ai_confidence < 0.6) {
      const retry = await callOpenAIVision({ imageUrl: primaryImage, model: 'gpt-4o' });
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
      model: usedModel,
      mock: usedModel === 'mock',
    }),
  };
};
