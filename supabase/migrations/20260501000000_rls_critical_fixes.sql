-- 2026-05-01 — Beta launch RLS critical fixes
--
-- 사전 점검 결과 (production DB 직접 조회):
-- 1. SECURITY DEFINER RPC 3개 (bump_rate_limit_atomic / bump_alimtalk_rate_limit_atomic
--    / bump_insight_cost_atomic) — production DB에 미존재. /migrations/2026-04-29-atomic-rate-limit-rpc.sql
--    이 미적용 상태. 적용해야 한다면 그 SQL에서 GRANT TO anon 부분을 제거하고 적용할 것.
--    이번 마이그레이션에서는 REVOKE 불가(존재하지 않음) → 작업 제외.
-- 2. shopping_insights — RLS 활성화 되어 있고 SELECT 정책 0개 = service_role(=Netlify
--    Functions)만 접근 가능. 클라이언트 anon 접근 0건. 현 상태가 가장 안전 → 작업 제외.
-- 3. linkpages — `USING (true)` 공개 SELECT 정책 실재. published 조건부로 강화 필요.
--
-- 이 마이그레이션은 linkpages SELECT 정책만 수정.

BEGIN;

DROP POLICY IF EXISTS "linkpages: 공개 읽기 (/p/:handle)" ON public.linkpages;

CREATE POLICY "linkpages: 공개 읽기 (published만)"
  ON public.linkpages
  FOR SELECT
  USING (published = true OR auth.uid() = user_id);

COMMIT;
