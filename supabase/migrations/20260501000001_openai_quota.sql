-- ============================================================
-- OpenAI 호출 비용 한도 — DB 스키마 마이그레이션
-- 2026-05-01 | openai-quota.js 헬퍼 대응
--
-- 변경 내용:
--   1. openai_quota 테이블 신규 생성
--      (셀러별 일일/월간 호출 카운트 + 비용 추적)
--   2. bump_openai_quota_atomic RPC — INSERT ... ON CONFLICT 원자 증가
--   3. RLS: service_role 전용 (anon GRANT 절대 없음)
--
-- 멱등성: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION 사용
-- 실행: 사용자 승인 후 apply-one.js 로 적용
--   https://supabase.com/dashboard/project/cldsozdocxpvkbuxwqep/sql
-- ============================================================

BEGIN;

-- ============================================================
-- Part 1. openai_quota 테이블
--
-- 컬럼 설명:
--   seller_id          UUID     — 셀러 UUID (또는 '__service__' 서비스 전체 합산용)
--   daily_date         DATE     — KST 기준 날짜 (YYYY-MM-DD)
--   month_date         DATE     — KST 기준 월 첫날 (YYYY-MM-01)
--   daily_count        INT      — 당일 호출 횟수
--   daily_cost_krw     NUMERIC  — 당일 누적 추정 비용 (원)
--   monthly_count      INT      — 당월 호출 횟수
--   monthly_cost_krw   NUMERIC  — 당월 누적 추정 비용 (원)
--   updated_at         TIMESTAMPTZ
--
-- PK: (seller_id, daily_date) — 셀러당 하루 1행
-- ============================================================

CREATE TABLE IF NOT EXISTS public.openai_quota (
  seller_id         TEXT        NOT NULL,
  daily_date        DATE        NOT NULL,
  month_date        DATE        NOT NULL,
  daily_count       INTEGER     NOT NULL DEFAULT 0,
  daily_cost_krw    NUMERIC     NOT NULL DEFAULT 0,
  monthly_count     INTEGER     NOT NULL DEFAULT 0,
  monthly_cost_krw  NUMERIC     NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT openai_quota_pk PRIMARY KEY (seller_id, daily_date)
);

COMMENT ON TABLE public.openai_quota IS
  'OpenAI 호출 비용 한도 추적. 셀러당 일/월 추정 비용 누적.'
  ' seller_id = ''__service__'' 는 서비스 전체 합산 행.';

COMMENT ON COLUMN public.openai_quota.seller_id IS
  '셀러 UUID 또는 ''__service__'' (서비스 전체 집계용 가상 ID).';

COMMENT ON COLUMN public.openai_quota.daily_date IS
  'KST 기준 날짜 (YYYY-MM-DD). 일 리셋 키.';

COMMENT ON COLUMN public.openai_quota.month_date IS
  'KST 기준 월 첫날 (YYYY-MM-01). 월 집계용.';

COMMENT ON COLUMN public.openai_quota.daily_cost_krw IS
  '당일 누적 추정 비용 (원). 모델별 호출당 추정값 기반.'
  ' gpt-5.4=₩100, gpt-4o=₩50, gpt-4o-mini=₩5, embedding=₩1.';

COMMENT ON COLUMN public.openai_quota.monthly_cost_krw IS
  '당월 누적 추정 비용 (원). 월말 초과 경보 및 청구 대조용.';

-- 월별 집계 조회용 인덱스
CREATE INDEX IF NOT EXISTS openai_quota_month_idx
  ON public.openai_quota (seller_id, month_date);

-- ============================================================
-- Part 2. RLS — service_role 전용
--
-- anon / authenticated 에는 GRANT 없음 (보안 감사 패턴 준수).
-- Netlify Functions 는 SUPABASE_SERVICE_ROLE_KEY 로 service_role 로 동작.
-- ============================================================

ALTER TABLE public.openai_quota ENABLE ROW LEVEL SECURITY;

-- 기존 정책 제거 (재실행 안전)
DROP POLICY IF EXISTS "openai_quota_service_role_all" ON public.openai_quota;

-- service_role 전용: 모든 operation
CREATE POLICY "openai_quota_service_role_all"
  ON public.openai_quota
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- Part 3. bump_openai_quota_atomic RPC
--
-- INSERT ... ON CONFLICT DO UPDATE 원자성 보장.
-- 동시 호출에도 카운트 손실 없음.
--
-- 파라미터:
--   p_seller_id  TEXT    — 셀러 UUID 또는 '__service__'
--   p_daily_date DATE    — KST 오늘 날짜
--   p_month_date DATE    — KST 이번 달 첫날
--   p_cost_krw   NUMERIC — 이번 호출 추정 비용
--
-- 반환: (daily_cost_krw NUMERIC, daily_count INT)
-- ============================================================

CREATE OR REPLACE FUNCTION public.bump_openai_quota_atomic(
  p_seller_id  TEXT,
  p_daily_date DATE,
  p_month_date DATE,
  p_cost_krw   NUMERIC
)
RETURNS TABLE (daily_cost_krw NUMERIC, daily_count INT) AS $$
BEGIN
  RETURN QUERY
  INSERT INTO public.openai_quota
    (seller_id, daily_date, month_date,
     daily_count, daily_cost_krw,
     monthly_count, monthly_cost_krw,
     updated_at)
  VALUES
    (p_seller_id, p_daily_date, p_month_date,
     1, p_cost_krw,
     1, p_cost_krw,
     now())
  ON CONFLICT (seller_id, daily_date)
  DO UPDATE SET
    daily_count      = public.openai_quota.daily_count      + 1,
    daily_cost_krw   = public.openai_quota.daily_cost_krw   + p_cost_krw,
    monthly_count    = public.openai_quota.monthly_count    + 1,
    monthly_cost_krw = public.openai_quota.monthly_cost_krw + p_cost_krw,
    updated_at       = now()
  RETURNING
    public.openai_quota.daily_cost_krw,
    public.openai_quota.daily_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.bump_openai_quota_atomic IS
  'OpenAI 호출 카운터 원자 증가. INSERT ... ON CONFLICT 기반.'
  ' SECURITY DEFINER — service_role 에서만 호출 (anon GRANT 없음).';

-- service_role 에만 실행 권한 (anon/authenticated GRANT 절대 없음)
GRANT EXECUTE ON FUNCTION public.bump_openai_quota_atomic(TEXT, DATE, DATE, NUMERIC)
  TO service_role;

-- ============================================================
-- PostgREST 스키마 리로드
-- ============================================================
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- DOWN (롤백) — 필요 시 수동 실행
-- ============================================================
-- DROP FUNCTION IF EXISTS public.bump_openai_quota_atomic(TEXT, DATE, DATE, NUMERIC);
-- DROP TABLE IF EXISTS public.openai_quota;
