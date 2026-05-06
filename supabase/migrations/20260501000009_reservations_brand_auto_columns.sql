-- reservations 테이블에 브랜드 자동게시 컬럼 추가
-- 원본: db/add_is_brand_auto.sql
-- 관련 함수: daily-content-background, process-and-post-background,
--            admin-brand-status (is_brand_auto, industry 컬럼 사용)

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS is_brand_auto BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS industry       TEXT;

-- 브랜드 자동 예약 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_reservations_is_brand_auto
  ON public.reservations (is_brand_auto)
  WHERE is_brand_auto = true;
