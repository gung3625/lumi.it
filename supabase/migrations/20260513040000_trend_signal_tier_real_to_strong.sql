-- trend_keywords.signal_tier 통일 (2026-05-13).
-- 기존 분류: cross_source >= 2 ? 'real' : 'weak' (이분법)
-- 신규 분류 (scheduled-trends-v2-background.js): 다축 3-tier
--   strong: 2개 이상 시그널 (cross_source, 검색량≥5k, velocity≥30%)
--   medium: 1개 시그널
--   weak:   시그널 없음
-- 옛 'real' row 를 'strong' 으로 통일 — get-trends backward-compat 도 적용돼 있지만
-- DB schema 도 새 분류값으로 정리.
UPDATE trend_keywords SET signal_tier='strong' WHERE signal_tier='real';
