-- 브랜드 라이브러리 시스템 테이블 마이그레이션
-- 묶음 2: 라이브러리 시스템
-- 실행: Supabase Dashboard SQL Editor 또는 psql

-- 라이브러리 콘텐츠 테이블
CREATE TABLE IF NOT EXISTS brand_content_library (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  industry TEXT NOT NULL,  -- cafe | restaurant | beauty | nail | flower | clothing | gym
  content_type TEXT NOT NULL CHECK (content_type IN ('image', 'video')),
  storage_bucket TEXT NOT NULL,  -- 'lumi-images' or 'lumi-videos'
  storage_path TEXT NOT NULL,  -- 'brand-library/cafe/image-1-20260420.jpg'
  public_url TEXT,  -- Supabase Storage public URL (캐싱)
  prompt TEXT,  -- 생성에 사용한 프롬프트 (나중 재현용)
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  use_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ready' CHECK (status IN ('generating', 'ready', 'failed')),
  error_message TEXT,
  UNIQUE (industry, content_type, storage_path)
);

CREATE INDEX IF NOT EXISTS idx_brand_library_pickup
  ON brand_content_library (industry, content_type, status, last_used_at NULLS FIRST);

-- 요일 → 업종 매핑 (주간 셔플)
CREATE TABLE IF NOT EXISTS brand_weekday_schedule (
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),  -- 0=일, 1=월, ... 6=토
  industry TEXT NOT NULL,
  week_start_date DATE NOT NULL,  -- 이 매핑이 설정된 주의 월요일
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 초기 시드 (임의 고정값, 다음 월요일 자동 셔플)
INSERT INTO brand_weekday_schedule (weekday, industry, week_start_date) VALUES
  (0, 'cafe', CURRENT_DATE),
  (1, 'restaurant', CURRENT_DATE),
  (2, 'beauty', CURRENT_DATE),
  (3, 'nail', CURRENT_DATE),
  (4, 'flower', CURRENT_DATE),
  (5, 'clothing', CURRENT_DATE),
  (6, 'gym', CURRENT_DATE)
ON CONFLICT (weekday) DO NOTHING;
