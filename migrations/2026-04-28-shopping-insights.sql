-- 2026-04-28-shopping-insights.sql
-- 네이버 데이터랩 쇼핑인사이트 9 엔드포인트 응답 저장 테이블
--
-- B 그룹 (분야만): category_overall / category_device / category_gender / category_age
-- C 그룹 (분야+키워드): category_keywords / category_keyword_device / category_keyword_gender / category_keyword_age
--
-- 적용:
--   psql $DATABASE_URL -f migrations/2026-04-28-shopping-insights.sql
--   또는 Supabase SQL Editor 에 붙여넣기

CREATE TABLE IF NOT EXISTS shopping_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 카테고리 (네이버 데이터랩 8자리 코드)
  category_code TEXT NOT NULL,
  category_name TEXT NOT NULL,

  -- 메트릭 타입 (9개 중 1개)
  metric_type TEXT NOT NULL CHECK (metric_type IN (
    'category_overall',
    'category_device',
    'category_gender',
    'category_age',
    'category_keywords',
    'category_keyword_device',
    'category_keyword_gender',
    'category_keyword_age'
  )),

  -- C 그룹용 키워드 단위 (B 그룹은 NULL, '' 빈문자열로 UNIQUE 충돌 방지)
  keyword TEXT NOT NULL DEFAULT '',

  -- 시계열 범위
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- 응답 원본 + 셀러 친화 요약 (JSONB)
  --   data: 정규화된 results 배열 (시계열)
  --   summary: { device_split, gender_split, age_split, top_keywords } 등 분포 요약
  data JSONB NOT NULL,
  summary JSONB,

  -- 메타
  collected_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT DEFAULT 'naver_datalab_shopping',

  UNIQUE (category_code, metric_type, keyword, period_end)
);

-- 카테고리·메트릭별 최신 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_shopping_insights_cat_metric
  ON shopping_insights (category_code, metric_type, period_end DESC);

-- 키워드 검색 인덱스 (C 그룹)
CREATE INDEX IF NOT EXISTS idx_shopping_insights_keyword
  ON shopping_insights (category_code, keyword, period_end DESC)
  WHERE keyword <> '';

-- 수집 시각 인덱스 (운영 모니터링용)
CREATE INDEX IF NOT EXISTS idx_shopping_insights_collected_at
  ON shopping_insights (collected_at DESC);

COMMENT ON TABLE shopping_insights IS '네이버 데이터랩 쇼핑인사이트 9 엔드포인트 수집 데이터 (B/C 그룹)';
COMMENT ON COLUMN shopping_insights.metric_type IS 'category_overall|device|gender|age (B 그룹) + category_keywords|keyword_device|keyword_gender|keyword_age (C 그룹)';
COMMENT ON COLUMN shopping_insights.keyword IS 'C 그룹 전용. B 그룹은 빈 문자열 ('''' )로 UNIQUE 충돌 방지';
COMMENT ON COLUMN shopping_insights.data IS '네이버 응답 results 배열 정규화 (시계열 ratio)';
COMMENT ON COLUMN shopping_insights.summary IS '셀러 친화 분포 요약 (device/gender/age split %)';
