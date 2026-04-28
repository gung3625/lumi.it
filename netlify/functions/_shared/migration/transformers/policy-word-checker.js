// 정책 위반 단어 검사 (마이그레이션 시점) — Sprint 3.5
// 등록 시점이 아닌 마이그레이션 시점에 일괄 검사 → 셀러 선제 경고
//
// 설계 원칙 (project_migration_export_structure.md `정책 위반 단어 검사 통합 시점`):
// - 검출은 하되 자동 수정 X (기본값 = 표시만)
// - 자동 수정은 셀러가 명시적 활성화 시
// - 마켓별 정책 차이는 등록 시점 어댑터가 다시 검사 (안전망 2중)
//
// 기존 _shared/policy-words.js 모듈 재사용 (있으면) 또는 자체 사전 사용

let basePolicyWords;
try {
  basePolicyWords = require('../../policy-words');
} catch (_) {
  basePolicyWords = null;
}

// 자체 사전 (policy-words.js 미존재 또는 마이그레이션 전용 보강)
const MIGRATION_POLICY_WORDS = [
  { word: '최고', cause: '과대광고 우려', suggestion: '프리미엄' },
  { word: '최강', cause: '과대광고 우려', suggestion: '강력한' },
  { word: '특허', cause: '실증 가능 여부 검증 필요', suggestion: '특별한' },
  { word: '의학', cause: '의료기기 표시광고법 위반 가능', suggestion: '관리' },
  { word: '치료', cause: '의료기기 표시광고법 위반 가능', suggestion: '케어' },
  { word: '효과', cause: '실증 가능 여부 검증 필요', suggestion: '도움' },
  { word: '100%', cause: '단정 표현 금지', suggestion: '뛰어난' },
  { word: '국내 최저가', cause: '실증 가능 여부 검증 필요', suggestion: '합리적인 가격' },
  { word: '최저가', cause: '실증 가능 여부 검증 필요', suggestion: '합리적인 가격' },
  { word: '명품', cause: '브랜드 무단 사용 위험', suggestion: '고급' },
];

/**
 * 단일 텍스트에서 위반 단어 추출.
 * @param {string} text
 * @returns {Array<{ word: string, cause: string, suggestion: string, market: string }>}
 */
function checkText(text) {
  if (!text || typeof text !== 'string') return [];

  // 기존 policy-words 모듈 우선 (마켓별 정확)
  if (basePolicyWords && typeof basePolicyWords.checkPolicyWords === 'function') {
    try {
      const r = basePolicyWords.checkPolicyWords(text);
      if (Array.isArray(r) && r.length > 0) return r;
    } catch (_) { /* fallthrough */ }
  }

  const warnings = [];
  for (const entry of MIGRATION_POLICY_WORDS) {
    if (text.includes(entry.word)) {
      warnings.push({
        word: entry.word,
        cause: entry.cause,
        suggestion: entry.suggestion,
        market: 'common',
      });
    }
  }
  return warnings;
}

/**
 * 상품 배열 일괄 검사 — 마이그레이션 시점.
 * @param {Array<{ product_name?: string, title?: string }>} products
 * @returns {{ violatingCount: number, warnings: Array }}
 */
function checkProducts(products) {
  if (!Array.isArray(products)) return { violatingCount: 0, warnings: [] };

  let violatingCount = 0;
  const warnings = [];

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (!p) continue;
    const text = p.product_name || p.title || '';
    const found = checkText(text);
    if (found.length > 0) {
      violatingCount++;
      warnings.push({
        index: i,
        sku_code: p.sku_code,
        title: text,
        violations: found,
      });
    }
  }

  return { violatingCount, warnings };
}

module.exports = {
  checkText,
  checkProducts,
  MIGRATION_POLICY_WORDS,
};
