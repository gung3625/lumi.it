-- migrations/004-trend-regions.sql
-- 트렌드 지역 분할 기반 구조 (Phase 1)
-- 광역시 6개 + 전국(all) 지역 분할 수집을 위한 스키마 변경

-- 1. region 컬럼 추가 (기존 데이터는 'all'로 기본값 채워짐)
ALTER TABLE public.trend_keywords
  ADD COLUMN IF NOT EXISTS region text DEFAULT 'all';

-- 2. 기존 데이터 region='all' 명시적 업데이트 (DEFAULT로 이미 채워지지만 확실히)
UPDATE public.trend_keywords
  SET region = 'all'
  WHERE region IS NULL;

-- 3. 기존 dedup 인덱스 제거 후 region 포함으로 재생성
DROP INDEX IF EXISTS idx_tk_dedup;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tk_dedup ON public.trend_keywords
  (keyword, category, axis, COALESCE(sub_category, ''), region, collected_date);

-- 4. region + category + collected_date 복합 인덱스 (조회 최적화)
CREATE INDEX IF NOT EXISTS idx_tk_region ON public.trend_keywords
  (region, category, collected_date DESC);
