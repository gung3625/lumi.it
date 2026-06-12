// trend-guards.js — 트렌드 카테고리 교차 오염 가드 (쓰기·읽기 공용)
//
// 배경 (2026-06-12): food 카테고리에 우베라떼·노티드도넛 등 카페 키워드가
// 4/24부터 43건 적재·노출. 원인 = 시드 오염 + GPT 분류 규칙이 OpenAI-off 모드에서
// 미작동. 재발 방지를 위해 같은 가드를 적재(scheduled-trends-v2)와
// 읽기(get-trends) 양쪽에 적용한다. 새 오염 유형 발견 시 이 파일만 갱신하면 양쪽 반영.
//
// 한계(정직): 수동 패턴 목록 — 새 키워드 유형은 목록 갱신 필요.
// 쓰기 가드가 거른 키워드는 console.log 로 남아 Netlify 함수 로그에서 추적 가능.

// 디저트·음료·베이커리류 = cafe 전용
const CAFE_ONLY_RE = /라떼|아메리카노|에스프레소|원두|도넛|도너츠|베이글|크로플|마카롱|케이크|베이커리|스콘|휘낭시에|마들렌|빙수|푸딩|소금빵|타르트|쿠키|브라우니|디저트|노티드/;

// 카테고리 → 그 카테고리에 있으면 안 되는 패턴
const CATEGORY_EXCLUDE = {
  food: CAFE_ONLY_RE,
  flower: CAFE_ONLY_RE,
};

/**
 * 카테고리 교차 오염 필터.
 * @param {Array<{keyword: string}>} keywords
 * @param {string} category
 * @param {string} [stage] - 'write' | 'read' (로그 라벨용)
 * @returns {Array} 걸러진 목록
 */
function applyCategoryGuard(keywords, category, stage) {
  const re = CATEGORY_EXCLUDE[category];
  if (!re || !Array.isArray(keywords)) return keywords || [];
  const dropped = [];
  const kept = keywords.filter((k) => {
    const kw = String((k && k.keyword) || '');
    if (re.test(kw)) { dropped.push(kw); return false; }
    return true;
  });
  if (dropped.length && stage === 'write') {
    console.log(`[trend-guard] ${category} 적재에서 교차 오염 ${dropped.length}건 차단:`, dropped.join(', '));
  }
  return kept;
}

module.exports = { applyCategoryGuard, CATEGORY_EXCLUDE, CAFE_ONLY_RE };
