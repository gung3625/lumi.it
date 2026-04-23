-- ============================================================
-- Phase 0: Trend Hub v2 Schema Foundation
-- Runs idempotent (CREATE IF NOT EXISTS)
-- Rollback: DROP TABLE IF EXISTS trend_keywords, trend_snapshots, trend_subcategories CASCADE;
-- ============================================================

-- 1. trend_keywords: 정규화된 키워드 저장소
CREATE TABLE IF NOT EXISTS public.trend_keywords (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  keyword            text NOT NULL,
  category           text NOT NULL,
  axis               text DEFAULT 'general',
  sub_category       text DEFAULT NULL,
  weighted_score     numeric(8,2) DEFAULT 0,
  cross_source_count smallint DEFAULT 0,
  velocity_pct       numeric(8,2) DEFAULT NULL,
  is_new             boolean DEFAULT false,
  signal_tier        text DEFAULT 'weak',
  narrative          text DEFAULT NULL,
  origin             jsonb DEFAULT NULL,
  related_keywords   text[] DEFAULT '{}',
  -- embedding은 Phase 4에서 pgvector 활성화 후 ALTER TABLE로 추가
  thumbnail_urls     jsonb DEFAULT NULL,
  sources            jsonb DEFAULT '{}',
  raw_mentions       jsonb DEFAULT '{}',
  collected_date     date NOT NULL DEFAULT CURRENT_DATE,
  collected_at       timestamptz NOT NULL DEFAULT now(),
  pipeline_version   smallint DEFAULT 2
);

-- UNIQUE 제약을 인덱스로 분리 — COALESCE로 NULL sub_category도 중복 감지
CREATE UNIQUE INDEX IF NOT EXISTS idx_tk_dedup ON public.trend_keywords
  (keyword, category, axis, COALESCE(sub_category, ''), collected_date);

-- pgvector extension + embedding column은 Phase 4에서 추가 예정
-- (Supabase Dashboard → Database → Extensions → vector 활성화 필요)

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_tk_cat_date ON trend_keywords (category, collected_date DESC);
CREATE INDEX IF NOT EXISTS idx_tk_cat_axis ON trend_keywords (category, axis, collected_date DESC);
CREATE INDEX IF NOT EXISTS idx_tk_subcat ON trend_keywords (sub_category, collected_date DESC) WHERE sub_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tk_signal ON trend_keywords (signal_tier, collected_date DESC);
CREATE INDEX IF NOT EXISTS idx_tk_velocity ON trend_keywords (velocity_pct DESC NULLS LAST) WHERE velocity_pct IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tk_new ON trend_keywords (is_new, collected_date DESC) WHERE is_new = true;
CREATE INDEX IF NOT EXISTS idx_tk_hotnow ON trend_keywords (signal_tier, collected_at DESC) WHERE signal_tier = 'hotnow';

-- 2. trend_snapshots: 일별 집계 JSON
CREATE TABLE IF NOT EXISTS public.trend_snapshots (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category      text NOT NULL,
  scope         text NOT NULL DEFAULT 'domestic',
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  keywords_json jsonb NOT NULL,
  rising_json   jsonb DEFAULT NULL,
  meta          jsonb DEFAULT '{}',
  created_at    timestamptz DEFAULT now(),
  UNIQUE (category, scope, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_ts_cat_date ON trend_snapshots (category, snapshot_date DESC);

-- 3. trend_subcategories: Long-tail 매핑 (Phase 3 대비 테이블만 미리)
CREATE TABLE IF NOT EXISTS public.trend_subcategories (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category      text NOT NULL,
  sub_category  text NOT NULL,
  label_ko      text NOT NULL,
  seed_queries  jsonb DEFAULT '[]',
  axis_default  text DEFAULT 'general',
  active        boolean DEFAULT true,
  UNIQUE (category, sub_category)
);

-- RLS 설정 (Supabase 기본)
ALTER TABLE public.trend_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trend_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trend_subcategories ENABLE ROW LEVEL SECURITY;

-- Admin client (service_role)만 쓰기 가능, 공개 읽기는 허용
-- CREATE POLICY는 IF NOT EXISTS 미지원 → DO 블록으로 idempotent 처리
DO $$ BEGIN
  CREATE POLICY "Public read" ON public.trend_keywords FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Public read" ON public.trend_snapshots FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Public read" ON public.trend_subcategories FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- service_role은 RLS 우회하므로 write는 자동 허용됨
