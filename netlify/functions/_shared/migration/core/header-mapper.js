// 헤더 매핑 엔진 — Sprint 3.5 마이그레이션
// Phase 1 (코드 룰) + Phase 2 (AI 폴백) 4단 매핑 파이프라인의 1·2단계
//
// 사용처:
//   const mapped = await mapHeaders(headers, { solution: 'sabangnet', mockAi: true });
//   // [{ original: 'it_name', mapped: 'product_name', confidence: 1, source: 'code' }, ...]
//
// 설계 원칙 (project_migration_export_structure.md):
// - 표준 양식 = 코드 lookup 100% (AI 미사용 → ₩0)
// - 변칙 양식 = AI 폴백 (셀러당 ₩30~500)
// - AI_MIGRATION_MOCK=true → AI 호출 모킹 (베타 시작 시 비용 0)

const SOLUTION_MAPPINGS = require('../parsers/sabang-parser').SOLUTION_MAPPINGS;
const SYNONYMS = require('../parsers/sabang-parser').SYNONYMS;

const LUMI_FIELDS = [
  'sku_code', 'product_name', 'price', 'msrp', 'stock',
  'option_name', 'option_value', 'category_id', 'image_url', 'tax_type',
];

/**
 * 헤더 정규화 (대소문자·공백·특수문자 무관 매칭)
 * @param {string} h
 */
function normalize(h) {
  if (h == null) return '';
  return String(h).trim().replace(/\s+/g, '').toLowerCase();
}

/**
 * Phase 1: 코드 룰 lookup (솔루션별 결정적 매핑 + 동의어 사전).
 * @param {string} header - 원본 헤더 텍스트
 * @param {string} solution - 솔루션 타입
 * @returns {{ mapped: string|null, confidence: number, source: 'code'|'synonym'|null }}
 */
function lookupCodeMapping(header, solution) {
  const normalized = normalize(header);

  // 1차: 솔루션별 결정적 매핑
  const solutionMap = SOLUTION_MAPPINGS[solution] || {};
  for (const [key, value] of Object.entries(solutionMap)) {
    if (normalize(key) === normalized) {
      return { mapped: value, confidence: 1.0, source: 'code' };
    }
  }

  // 2차: 동의어 사전 (변칙 양식 셀러 정의 헤더)
  for (const [lumiField, synonyms] of Object.entries(SYNONYMS)) {
    for (const syn of synonyms) {
      if (normalize(syn) === normalized) {
        return { mapped: lumiField, confidence: 0.9, source: 'synonym' };
      }
    }
  }

  return { mapped: null, confidence: 0, source: null };
}

/**
 * Phase 2: AI 폴백 (코드 매핑 실패한 헤더만).
 * AI_MIGRATION_MOCK=true 또는 OPENAI_API_KEY 미설정 시 모킹.
 * @param {string[]} unmappedHeaders
 * @param {{ mockAi?: boolean }} options
 * @returns {Promise<Object<string, { mapped: string|null, confidence: number }>>}
 */
async function aiFallbackMapping(unmappedHeaders, options = {}) {
  const useMock = options.mockAi
    || process.env.AI_MIGRATION_MOCK === 'true'
    || !process.env.OPENAI_API_KEY;

  if (useMock) {
    // 모킹: 헤더 텍스트 휴리스틱 매칭 (실비용 ₩0)
    const result = {};
    for (const h of unmappedHeaders) {
      const guess = heuristicGuess(h);
      result[h] = { mapped: guess, confidence: guess ? 0.6 : 0, source: 'ai-mock' };
    }
    return result;
  }

  // 실제 OpenAI 호출 (gpt-4o-mini)
  try {
    const prompt = buildMappingPrompt(unmappedHeaders);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: '당신은 한국 이커머스 엑셀 헤더를 Lumi 표준 필드로 매핑하는 도구입니다. JSON만 응답하세요.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const j = await res.json();
    const content = j.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const result = {};
    for (const h of unmappedHeaders) {
      const m = parsed[h] || parsed[normalize(h)];
      result[h] = m && LUMI_FIELDS.includes(m)
        ? { mapped: m, confidence: 0.85, source: 'ai' }
        : { mapped: null, confidence: 0, source: 'ai' };
    }
    return result;
  } catch (e) {
    // 실패 시 휴리스틱 폴백
    const result = {};
    for (const h of unmappedHeaders) {
      const guess = heuristicGuess(h);
      result[h] = { mapped: guess, confidence: guess ? 0.5 : 0, source: 'ai-fallback' };
    }
    return result;
  }
}

function buildMappingPrompt(headers) {
  return `다음 엑셀 헤더들을 Lumi 표준 필드 (${LUMI_FIELDS.join(', ')}) 중 하나로 매핑하세요.
매핑 불가능하면 null. 응답은 JSON 객체 (헤더 → 표준필드).

헤더: ${JSON.stringify(headers)}

응답 예시: {"가격(원)": "price", "수량": "stock", "기타필드": null}`;
}

/**
 * 휴리스틱 매핑 (AI 모킹용 폴백)
 * @param {string} header
 */
function heuristicGuess(header) {
  const n = normalize(header);
  if (/(상품명|제품명|품명|name|title)/i.test(n)) return 'product_name';
  if (/(판매가|가격|price|단가|amount)/i.test(n)) return 'price';
  if (/(소비자가|정가|msrp|retail)/i.test(n)) return 'msrp';
  if (/(재고|수량|stock|qty|inventory)/i.test(n)) return 'stock';
  if (/(상품코드|관리코드|sku|코드)/i.test(n)) return 'sku_code';
  if (/(카테고리|category|분류)/i.test(n)) return 'category_id';
  if (/(이미지|image|thumbnail|썸네일)/i.test(n)) return 'image_url';
  if (/(옵션명|옵션이름|option.*name)/i.test(n)) return 'option_name';
  if (/(옵션값|옵션데이터|option.*value)/i.test(n)) return 'option_value';
  if (/(과세|세금|tax|vat)/i.test(n)) return 'tax_type';
  return null;
}

/**
 * 4단 파이프라인의 1·2단계 통합 — 헤더 배열 매핑.
 * @param {string[]} headers
 * @param {{ solution?: string, mockAi?: boolean }} options
 * @returns {Promise<Array<{ original: string, mapped: string|null, confidence: number, source: string }>>}
 */
async function mapHeaders(headers, options = {}) {
  const solution = options.solution || 'unknown';
  const phase1 = headers.map((h) => {
    const r = lookupCodeMapping(h, solution);
    return { original: h, mapped: r.mapped, confidence: r.confidence, source: r.source || 'unmapped' };
  });

  const unmapped = phase1.filter((r) => !r.mapped).map((r) => r.original);
  if (unmapped.length === 0) return phase1;

  const aiResults = await aiFallbackMapping(unmapped, options);
  return phase1.map((r) => {
    if (r.mapped) return r;
    const ai = aiResults[r.original];
    return ai
      ? { ...r, mapped: ai.mapped, confidence: ai.confidence, source: ai.source }
      : r;
  });
}

module.exports = {
  mapHeaders,
  lookupCodeMapping,
  aiFallbackMapping,
  heuristicGuess,
  LUMI_FIELDS,
};
