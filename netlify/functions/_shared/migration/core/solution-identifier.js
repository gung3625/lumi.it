// 솔루션 자동 감지 — Sprint 3.5 마이그레이션
// 엑셀 첫 행 헤더로 사방넷·샵링커·이지어드민·플레이오토 추론
//
// 사용처:
//   const headers = ['판매자상품코드', 'it_name', 'it_price', ...];
//   const detected = identifySolution(headers);
//   // { solution: 'sabangnet', confidence: 0.95, matchedFields: [...] }
//
// 설계 원칙 (project_migration_export_structure.md):
// - 셀러는 컬럼 순서를 자기 편한 대로 바꿈 → 텍스트 매칭만 사용
// - 시그니처 = "이 솔루션에서만 등장하는 헤더 조합"
// - 신뢰도 < 0.6 → 'unknown' 반환 → AI 헤더 매핑 폴백

/** @typedef {'sabangnet'|'shoplinker'|'ezadmin'|'plto'|'unknown'} SolutionType */

/**
 * 솔루션별 시그니처 헤더 (memory `lumi-product-schema.md` 검증)
 * - primary: 가장 확실한 시그니처 (1개만 매치돼도 점수 높음)
 * - secondary: 보조 헤더 (조합으로 점수 가산)
 */
const SIGNATURES = {
  sabangnet: {
    primary: ['it_name', 'it_price', 'it_stock', 'it_img'],
    secondary: ['판매자상품코드', '카테고리코드', 'it_title'],
  },
  shoplinker: {
    primary: ['판매자관리코드', '마스터상품ID'],
    secondary: ['공급가', '소비자가', '판매가', '대표이미지'],
  },
  ezadmin: {
    primary: ['상품관리코드', '현재고', '이지카테고리'],
    secondary: ['바코드', '판매단가', '상품이미지', '제조사', '보관위치'],
  },
  plto: {
    primary: ['자체상품코드', 'EMP상품코드', '메인이미지'],
    secondary: ['확장필드1', '확장필드2', '마켓카테고리'],
  },
};

/**
 * 헤더 배열 정규화 (공백·대소문자·특수문자 제거)
 * @param {string} h
 */
function normalize(h) {
  if (h == null) return '';
  return String(h).trim().replace(/\s+/g, '').toLowerCase();
}

/**
 * 헤더 집합으로부터 솔루션 추론.
 * @param {string[]} headers - 엑셀 첫 행
 * @returns {{ solution: SolutionType, confidence: number, matchedFields: string[] }}
 */
function identifySolution(headers) {
  if (!Array.isArray(headers) || headers.length === 0) {
    return { solution: 'unknown', confidence: 0, matchedFields: [] };
  }

  const headerSet = new Set(headers.map(normalize).filter(Boolean));

  let bestSolution = 'unknown';
  let bestScore = 0;
  let bestMatched = [];

  for (const [solution, sig] of Object.entries(SIGNATURES)) {
    const matched = [];
    let score = 0;

    for (const h of sig.primary) {
      if (headerSet.has(normalize(h))) {
        score += 0.3;
        matched.push(h);
      }
    }
    for (const h of sig.secondary) {
      if (headerSet.has(normalize(h))) {
        score += 0.1;
        matched.push(h);
      }
    }

    // primary 1개 이상 + 총점 >= 0.4
    if (matched.length > bestMatched.length && score >= 0.3) {
      bestSolution = solution;
      bestScore = Math.min(score, 0.99);
      bestMatched = matched;
    }
  }

  if (bestScore < 0.3) {
    return { solution: 'unknown', confidence: 0, matchedFields: [] };
  }

  return {
    solution: bestSolution,
    confidence: Number(bestScore.toFixed(2)),
    matchedFields: bestMatched,
  };
}

/**
 * 셀러에게 보일 친화 라벨 (경쟁사명 노출 금지 — 일반 표현)
 * memory `feedback_no_competitor_mention_in_copy.md` 준수
 * @param {SolutionType} solution
 * @returns {string}
 */
function friendlyLabel(solution) {
  // 셀러 화면에는 솔루션명을 노출하지 않음 — 표준 양식 안내만
  if (solution === 'unknown') return '사용자 정의 양식 (AI가 자동 매핑할게요)';
  return '표준 양식이 확인되었습니다';
}

module.exports = {
  identifySolution,
  friendlyLabel,
  SIGNATURES,
};
