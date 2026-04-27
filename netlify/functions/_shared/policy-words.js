// 정책 위반 단어 사전 — Sprint 2
// 메모리 feedback_market_integration_principles.md ⑤ 친절한 번역 적용
// 메모리 project_phase1_market_intel_verified.md "4사 모두 미제공 = 루미 차별화"
//
// 1차 검사: 사전 매칭 (즉시, 비용 0)
// 2차 검사: AI 시맨틱 (GPT-4o-mini, ₩0.5/상품) — 본 모듈은 사전 검사만, 시맨틱은 analyze-product-image에 통합

// 마켓별 정책 위반 사전 (검증값 일부 + 추정값, 외부 cron 크롤링 placeholder)
// 정식 운영 시 정책 변경 매주 검토 (관리자 페이지에서 갱신)
const POLICY_DICT = {
  common: [
    { word: '최고급', cause: '과대광고 우려', suggestion: '프리미엄' },
    { word: '최저가', cause: '비교 광고 제한', suggestion: '합리적 가격' },
    { word: '국내 1위', cause: '근거 자료 필수', suggestion: '많이 찾는' },
    { word: '100% 정품', cause: '인증 자료 필요', suggestion: '정품 인증' },
    { word: '완치', cause: '의료 효능 표현 금지', suggestion: '도움' },
    { word: '치료', cause: '의료 효능 표현 금지', suggestion: '관리' },
    { word: '의약품', cause: '식품에서 의약 표현 금지', suggestion: '건강기능식품' },
  ],
  coupang: [
    { word: '쿠팡 직배송', cause: '쿠팡 로켓·자체배송 혼동', suggestion: '빠른 배송' },
    { word: '쿠팡 추천', cause: '쿠팡 인증 표현 금지', suggestion: '인기 상품' },
    { word: '로켓배송', cause: '쿠팡 직매입에서만 사용 가능', suggestion: '익일 배송' },
    { word: '특가', cause: '근거 자료 필요', suggestion: '할인가' },
  ],
  naver: [
    { word: '네이버 인증', cause: '네이버 자체 인증 외 사용 불가', suggestion: '품질 인증' },
    { word: '네이버 1위', cause: '근거 자료 필요', suggestion: '인기' },
    { word: '스마트스토어 1위', cause: '근거 자료 필요', suggestion: '인기' },
    { word: '오늘 마감', cause: '소비자 압박 광고', suggestion: '한정 수량' },
  ],
};

/**
 * 텍스트에서 정책 위반 단어 검색 (사전 매칭, 1차 검사)
 * @param {string} text - 상품명 + 설명
 * @param {string[]} markets - ['coupang', 'naver']
 * @returns {Array<import('./market-adapters/lumi-product-schema').PolicyWarning>}
 */
function checkPolicyWords(text, markets = ['coupang', 'naver']) {
  if (!text || typeof text !== 'string') return [];
  const lower = text.toLowerCase();
  const warnings = [];

  // 공통 사전
  for (const entry of POLICY_DICT.common) {
    if (lower.includes(entry.word.toLowerCase())) {
      warnings.push({
        word: entry.word,
        market: 'common',
        cause: entry.cause,
        suggestion: entry.suggestion,
      });
    }
  }

  // 마켓별 사전
  for (const market of markets) {
    const dict = POLICY_DICT[market] || [];
    for (const entry of dict) {
      if (lower.includes(entry.word.toLowerCase())) {
        warnings.push({
          word: entry.word,
          market,
          cause: entry.cause,
          suggestion: entry.suggestion,
        });
      }
    }
  }

  // 중복 제거 (word+market 기준)
  const seen = new Set();
  return warnings.filter((w) => {
    const key = `${w.word}|${w.market}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 1탭 자동 치환 — warnings 기반 텍스트 정정
 * @param {string} text
 * @param {Array<import('./market-adapters/lumi-product-schema').PolicyWarning>} warnings
 * @returns {string}
 */
function applySafeReplacements(text, warnings) {
  if (!text) return text;
  let safe = text;
  for (const w of warnings) {
    if (!w.suggestion) continue;
    const re = new RegExp(escapeRegex(w.word), 'gi');
    safe = safe.replace(re, w.suggestion);
  }
  return safe;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 사전 갱신 (관리자 페이지에서 호출, 추후 DB 마이그레이션)
 */
function listAllWords() {
  return POLICY_DICT;
}

module.exports = {
  checkPolicyWords,
  applySafeReplacements,
  listAllWords,
  POLICY_DICT,
};
