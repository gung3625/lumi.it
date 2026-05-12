-- trend_keywords.is_new 컬럼 제거 — 2026-05-12
--
-- PR #130 으로 응답·UI 의 NEW 라벨/신조어 분기 모두 제거.
-- PR #131 로 scheduled-trends-v2 의 checkIsNew/classifyNewConfidence 함수 + 호출 + raw_mentions.is_new_confidence 매핑 제거.
-- 이번 PR 로 마지막 잔존: rows 의 is_new: false 명시 매핑 제거 + 컬럼 자체 drop.
--
-- 데이터 손실 없음 — 모든 row 가 false 값 (의미 없는 컬럼). 진단 SQL:
--   SELECT count(*) FILTER (WHERE is_new IS TRUE) FROM trend_keywords; → 0
--
-- 호환성: select 측 (get-trends.js) 도 PR #131 에서 컬럼 제거됨. 코드↔DB 동기.

BEGIN;

ALTER TABLE public.trend_keywords DROP COLUMN IF EXISTS is_new;

NOTIFY pgrst, 'reload schema';

COMMIT;
