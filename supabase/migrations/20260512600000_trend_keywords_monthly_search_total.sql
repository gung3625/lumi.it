-- trend_keywords 에 monthly_search_total (네이버 검색광고 API 의 월간 PC + 모바일 합산) 추가.
--
-- 배경:
--   기존 ranking 은 velocityPct (상승률) 1차 정렬 → 1회 spike 가 1위 되는 위험.
--   네이버 검색광고 API 가 실 검색량 (월간 누적) 제공 → ranking 1차 정렬을 절대량
--   기반으로 전환. monthlyTotal 자체가 1달 누적이라 1일 spike 자동 감쇄.
--
-- env 부재 시 NULL 적재 → velocity 기반 fallback (회귀 0).

ALTER TABLE public.trend_keywords
  ADD COLUMN IF NOT EXISTS monthly_search_total INTEGER;

COMMENT ON COLUMN public.trend_keywords.monthly_search_total IS
  '네이버 검색광고 API (api.searchad.naver.com/keywordstool) 의 월간 PC + 모바일 검색 합산.
   ranking 1차 정렬 기준. env (NAVER_AD_API_KEY/SECRET/CUSTOMER_ID) 부재 시 NULL.';

-- ranking 최적화 인덱스
CREATE INDEX IF NOT EXISTS trend_keywords_category_monthly_idx
  ON public.trend_keywords (category, collected_date DESC, monthly_search_total DESC NULLS LAST);
