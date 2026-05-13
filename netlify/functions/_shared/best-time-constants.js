// best-time-constants.js — 베스트 시간 추천 임계값·윈도우 상수
//
// 단일 source of truth. get-best-time.js 와 (필요 시) UI 가 import.
//
// PR #237 에서 옛 Tier 1 (게시 reach 가중치) 폐기 — 사장님 통찰 "내가 어느 시간에
// 자주 올리는지가 왜 필요해? 팔로워가 언제 보는지가 중요" 반영. 현재 신호는:
//   Tier 1a: Meta online_followers (즉시, 요일 분리 없음)
//   Tier 2:  follower_activity_snapshots (28일 누적, 요일별 분리)

// Tier 2 (팔로워 활동 매트릭스) — follower_activity_snapshots 윈도우·임계
const ACTIVITY_WINDOW_DAYS = 28;
const ACTIVITY_THRESHOLDS = { weekday: 15, weekend: 6 };   // 약 3주 분

module.exports = {
  ACTIVITY_WINDOW_DAYS,
  ACTIVITY_THRESHOLDS,
};
