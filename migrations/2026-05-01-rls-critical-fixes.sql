-- 2026-05-01 — Beta launch RLS critical fixes
-- 1. SECURITY DEFINER RPC 3개의 anon EXECUTE 권한 회수 (DoS 방어)
-- 2. shopping_insights 테이블 RLS 활성화
-- 3. linkpages 공개 SELECT를 published 조건부로 강화

BEGIN;

-- =========================================================================
-- 1. SECURITY DEFINER RPC anon 권한 회수
-- 이전: anon이 이 RPC들을 호출해서 임의 seller_id의 카운터를 조작 가능했음
-- 이후: service_role + authenticated만 (functions 내부 호출 + 인증된 셀러)
-- =========================================================================

REVOKE EXECUTE ON FUNCTION public.bump_rate_limit_atomic(UUID, TEXT, DATE) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bump_alimtalk_rate_limit_atomic(UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bump_insight_cost_atomic(UUID, DATE, NUMERIC) FROM anon;

-- =========================================================================
-- 2. shopping_insights — RLS 활성화
-- 이전: RLS 없음 → anon key로 누구나 GET 가능 (네이버 쇼핑 인사이트 전체 노출)
-- 이후: authenticated만 SELECT, INSERT/UPDATE/DELETE는 service_role 전용
-- =========================================================================

ALTER TABLE public.shopping_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shopping_insights: authenticated read" ON public.shopping_insights;
CREATE POLICY "shopping_insights: authenticated read"
  ON public.shopping_insights
  FOR SELECT
  TO authenticated
  USING (true);

-- =========================================================================
-- 3. linkpages — 공개 SELECT 강화 (published만 또는 본인)
-- 이전: USING (true) → 비공개 페이지도 누구나 조회 가능
-- 이후: published=true 또는 본인만
-- (참고: link 페이지 기능 자체는 폐기됐으나 Phase 2 대비 + 데이터 보존)
-- =========================================================================

DROP POLICY IF EXISTS "linkpages: 공개 읽기 (/p/:handle)" ON public.linkpages;
CREATE POLICY "linkpages: 공개 읽기 (published만)"
  ON public.linkpages
  FOR SELECT
  USING (published = true OR auth.uid() = user_id);

COMMIT;
