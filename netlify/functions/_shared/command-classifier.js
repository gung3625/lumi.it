// command-classifier.js — Gate 2 Intent 분류 (Tier 1, gpt-4o-mini, ₩2 미만)
// 메모리 project_agent_architecture_0428.md
//
// 입력 자연어 → JSON {intent, confidence, action_hint}
//
// intent 종류:
//   shop          (쇼핑몰 운영 — 가격·재고·트렌드·CS·주문 등)
//   greeting      (인사 — "안녕"·"하이")
//   non_related   (관련 없는 잡담 — 영화·연예 등)
//   abuse         (욕설·차단)
//   weather       (날씨 — 외부 API)
//   currency      (환율 — 외부 API)
//   calendar      (공휴일 — 외부 API)
//   calc          (계산 — 마진·VAT 자체 룰)

const { makeCacheKey, getCached, setCached } = require('./llm-cache');

// Pre-filter (gate 1) — Shell 즉시 처리
const BLOCKLIST = [
  '시발', '씨발', 'fuck', 'shit',
  // 명백한 욕설만 추가. 정치·종교는 non_related로 분류
];

const GREETING_PATTERNS = [
  /^안녕/,
  /^반가/,
  /^하이$/i,
  /^hello$/i,
  /^hi$/i,
  /^어이/,
];

const QUICK_WEATHER = /날씨|기온|미세먼지|비와|덥|추워|춥/;
const QUICK_CURRENCY = /환율|달러|위안|엔화|usd|cny|jpy|krw/i;
const QUICK_HOLIDAY = /공휴일|쉬는\s*날|연휴|어린이날|설날|추석|언제/;
const QUICK_CALC = /^[\s\d+\-*/().,%원₩]+$|마진|부가세|vat|수수료\s*계산/i;

const SHOP_KEYWORDS = [
  '상품', '판매', '재고', '주문', '쿠팡', '네이버', '토스', 'cs', '문의',
  '반품', '환불', '가격', '인하', '인상', '내려', '올려', '등록', '게시',
  '리뷰', '별점', '검색', '키워드', '트렌드', '뜨는', '광고', '매출', '수익',
  '업로드', '사진', '이미지',
];

/**
 * Gate 1: Shell Pre-Filter (₩0)
 * @returns {object|null} - { intent, fast: true, ... } if matched, else null
 */
function preFilter(input) {
  const text = String(input || '').trim();
  if (!text) return { intent: 'invalid', fast: true, reason: '명령이 비어 있어요' };
  if (text.length < 2) return { intent: 'invalid', fast: true, reason: '명령이 너무 짧아요. 조금 더 자세히 적어 주세요' };
  if (text.length > 500) return { intent: 'invalid', fast: true, reason: '명령이 너무 길어요. 500자 이내로 부탁드려요' };

  const lower = text.toLowerCase();

  // 욕설 차단
  for (const w of BLOCKLIST) {
    if (lower.includes(w.toLowerCase())) {
      return { intent: 'abuse', fast: true, reason: '그런 표현은 응답하지 않아요' };
    }
  }

  // 인사
  for (const p of GREETING_PATTERNS) {
    if (p.test(text)) return { intent: 'greeting', fast: true, confidence: 0.95 };
  }

  // 외부 API 카테고리 (각 keyword가 명확하면 mini 호출 없이 바로 라우팅)
  if (QUICK_WEATHER.test(text)) return { intent: 'weather', fast: true, confidence: 0.90 };
  if (QUICK_CURRENCY.test(text)) return { intent: 'currency', fast: true, confidence: 0.90 };
  if (QUICK_HOLIDAY.test(text)) return { intent: 'calendar', fast: true, confidence: 0.85 };
  if (QUICK_CALC.test(text)) return { intent: 'calc', fast: true, confidence: 0.85 };

  // 쇼핑 키워드 명백한 경우 → shop 직행
  let shopHits = 0;
  for (const kw of SHOP_KEYWORDS) if (lower.includes(kw)) shopHits += 1;
  if (shopHits >= 2) return { intent: 'shop', fast: true, confidence: 0.85 };

  return null; // pass to Tier 1 mini classifier
}

/**
 * Gate 2: gpt-4o-mini 분류 (Tier 1, ₩2 미만, 캐싱 7일)
 */
async function classifyWithMini(input, sellerContext = {}) {
  const cacheKey = makeCacheKey({
    kind: 'classifier',
    input: input,
    contextHash: '',
    tier: 1,
  });
  const cached = await getCached(cacheKey);
  if (cached) return { ...cached, cached: true };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // 키 없으면 보수적으로 shop 처리
    return { intent: 'shop', confidence: 0.4, action_hint: 'fallback', fallback: true };
  }

  const systemPrompt = `너는 한국 1인 셀러 도우미 "루미"의 명령 분류기다. JSON만 출력.
입력 명령을 다음 카테고리 중 하나로 분류:
- shop: 쇼핑몰 운영 (가격·재고·주문·트렌드·등록·CS·매출·반품 등)
- greeting: 인사·잡담 시작
- non_related: 쇼핑과 무관한 잡담 (영화·연예·뉴스·정치 등)
- abuse: 욕설·공격적 표현
- weather: 날씨·기온·미세먼지
- currency: 환율
- calendar: 공휴일·연휴
- calc: 단순 계산 (마진·VAT·수수료)

JSON 형식: { "intent": "...", "confidence": 0.0~1.0, "action_hint": "1줄 핵심 액션" }`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        max_tokens: 100,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: String(input).slice(0, 400) },
        ],
      }),
    });
    if (!res.ok) {
      return { intent: 'shop', confidence: 0.3, action_hint: 'mini_failed', fallback: true };
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    const result = {
      intent: parsed.intent || 'shop',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      action_hint: parsed.action_hint || '',
    };
    await setCached(cacheKey, result, { kind: 'classifier', tier: 1 });
    return result;
  } catch (_) {
    return { intent: 'shop', confidence: 0.3, action_hint: 'network_error', fallback: true };
  }
}

/**
 * 메인 entry point — Gate 1 → Gate 2
 */
async function classify(input, sellerContext = {}) {
  const pre = preFilter(input);
  if (pre) return pre;
  const mini = await classifyWithMini(input, sellerContext);
  return { ...mini, fast: false };
}

module.exports = { classify, preFilter, classifyWithMini, BLOCKLIST };
