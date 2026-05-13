-- seller_post_history.insights_finalized_at — 게시 후 24h 가 지나 reach 가 안정화된 시점의
-- 최종 측정 시각. scheduled-post-insights-background 가 2-stage 측정의 final 단계에 채움.
--
-- 의도:
--   기존: 게시 다음날 03:30 cron 1회 측정 → insights_fetched_at 채워지면 끝.
--   변경: cron 30분 주기 + (1차) posted_at+1h 통과 시 fetched_at 채움 (2차) posted_at+24h 통과
--         시 한 번 더 측정해서 reach 안정값으로 갱신, 그제서야 insights_finalized_at 채움.
--   이미 finalized_at 채워진 row 는 후보 query 에서 자연 제외.

ALTER TABLE seller_post_history
  ADD COLUMN IF NOT EXISTS insights_finalized_at TIMESTAMPTZ;

-- 후보 query 가속 — (insights_finalized_at IS NULL AND insights_fetched_at IS NOT NULL)
-- 인 row 만 stage-2 후보. 부분 인덱스로 비용 최소화.
CREATE INDEX IF NOT EXISTS idx_seller_post_history_pending_finalize
  ON seller_post_history (posted_at)
  WHERE insights_finalized_at IS NULL AND insights_fetched_at IS NOT NULL;
