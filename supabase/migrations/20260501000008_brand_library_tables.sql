-- 브랜드 라이브러리 시스템 테이블
-- brand_content_library, brand_weekday_schedule
-- 원본: db/add_brand_library.sql
-- 관련 함수: daily-content-background, generate-library-background,
--            admin-library-list, admin-library-regenerate, admin-brand-status,
--            scheduled-weekday-shuffle-background, admin-shuffle-weekday
-- RLS 정책은 20260422000000_security_hardening.sql에서 IF NOT EXISTS 가드로 적용됨

-- ============================================================
-- 1. brand_content_library — 업종별 생성 이미지/영상 라이브러리
-- ============================================================
CREATE TABLE IF NOT EXISTS public.brand_content_library (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  industry       TEXT NOT NULL,
  content_type   TEXT NOT NULL CHECK (content_type IN ('image', 'video')),
  storage_bucket TEXT NOT NULL,
  storage_path   TEXT NOT NULL,
  public_url     TEXT,
  prompt         TEXT,
  generated_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ,
  use_count      INTEGER DEFAULT 0,
  status         TEXT DEFAULT 'ready' CHECK (status IN ('generating', 'ready', 'failed')),
  error_message  TEXT,
  UNIQUE (industry, content_type, storage_path)
);

CREATE INDEX IF NOT EXISTS idx_brand_library_pickup
  ON public.brand_content_library (industry, content_type, status, last_used_at NULLS FIRST);

-- ============================================================
-- 2. brand_weekday_schedule — 요일별 업종 매핑 (주간 셔플)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.brand_weekday_schedule (
  weekday         INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  industry        TEXT NOT NULL,
  week_start_date DATE NOT NULL,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 초기 시드 (이미 존재하면 스킵)
INSERT INTO public.brand_weekday_schedule (weekday, industry, week_start_date) VALUES
  (0, 'cafe',       CURRENT_DATE),
  (1, 'restaurant', CURRENT_DATE),
  (2, 'beauty',     CURRENT_DATE),
  (3, 'nail',       CURRENT_DATE),
  (4, 'flower',     CURRENT_DATE),
  (5, 'clothing',   CURRENT_DATE),
  (6, 'gym',        CURRENT_DATE)
ON CONFLICT (weekday) DO NOTHING;
