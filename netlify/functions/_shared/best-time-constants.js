// best-time-constants.js — 베스트 시간 추천 임계값·윈도우 상수
//
// 단일 source of truth. get-best-time.js 와 (필요 시) UI 가 import.
// 변경 시 HANDOFF.md 의 다음 단계 섹션도 같이 갱신할 것.

// Tier 1 (도달 데이터 기반) — 카테고리 안 reach 채워진 row 임계 (요일별 독립)
const HISTORY_THRESHOLDS = { weekday: 5, weekend: 3 };

// Tier 1/3 데이터 윈도우 — 최근 N일치 seller_post_history 조회
const HISTORY_WINDOW_DAYS = 90;

// 안전 상한 — seller_post_history SELECT row 수 max (정상 운영 시 도달 X)
const HISTORY_LIMIT = 500;

// Tier 2 (팔로워 활동 매트릭스) — follower_activity_snapshots 윈도우·임계
const ACTIVITY_WINDOW_DAYS = 28;
const ACTIVITY_THRESHOLDS = { weekday: 15, weekend: 6 };   // 약 3주 분

module.exports = {
  HISTORY_THRESHOLDS,
  HISTORY_WINDOW_DAYS,
  HISTORY_LIMIT,
  ACTIVITY_WINDOW_DAYS,
  ACTIVITY_THRESHOLDS,
};
