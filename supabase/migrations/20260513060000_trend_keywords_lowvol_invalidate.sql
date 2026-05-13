-- 검증 2026-05-13: monthly_search_total < 100 인 row 가 사장님 트렌드 페이지
-- TOP 10 에 noise 노출되는 사고. 한국 월 검색량 100 미만 = 거의 검색 없음 =
-- 트렌드 아님. 코드의 fetchKeywordSearchVolume / estimateByDataLabRatio 에
-- threshold 100 적용 + 옛 row 도 즉시 무효화.

UPDATE trend_keywords
SET monthly_search_total = NULL,
    search_volume_match_type = NULL,
    search_volume_root_keyword = NULL
WHERE monthly_search_total IS NOT NULL
  AND monthly_search_total < 100;
