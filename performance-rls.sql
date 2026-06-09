-- ============================================================================
-- lumi 성능: RLS auth 함수 per-row 재평가 최적화  (사장님이 SQL Editor 에서 실행)
-- 생성: 2026-06-07 / 근거: Supabase Performance Advisor (auth_rls_initplan, WARN)
--
-- 무엇: RLS 정책의 auth.uid() / current_setting(...) 이 "행마다" 재평가되던 것을
--       (select ...) 로 감싸 쿼리당 1회만 평가되게 함 (Supabase 공식 권장).
--       정책 로직(누가 무엇을 보는지)은 100% 동일 — 평가 횟수만 줄임.
--
-- ⚠️ 우선순위: 이 최적화는 "대규모(행 많을 때)"에서만 체감됩니다. 현재 lumi 는
--    유료 0명·reservations/caption_history 0행이라 체감 효과 0 = 런칭 차단 아님.
--    정식 스케일 전 정리용으로 준비. 급하지 않으면 런칭 후 실행해도 됩니다.
--
-- ⚠️ 접근권한 정의 변경이라 어시스턴트가 직접 실행하지 않고 준비만 했습니다.
--    아래는 현재 pg_policies 정의를 그대로 읽어 auth 호출만 (select ...) 로 감싼 것.
--
-- 실행: 전체 복사 → SQL Editor → Run. 트랜잭션으로 감싸 일부 실패 시 전체 롤백.
-- ============================================================================

BEGIN;

-- ── caption_history (본인 user_id) ──────────────────────────────────────
ALTER POLICY "caption_history: 본인 DELETE" ON public.caption_history
  USING ((select auth.uid()) = user_id);
ALTER POLICY "caption_history: 본인 INSERT" ON public.caption_history
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "caption_history: 본인 이력 SELECT (generated 제외)" ON public.caption_history
  USING (((select auth.uid()) = user_id) AND (caption_type <> 'generated'::text));
ALTER POLICY "caption_history: 본인 UPDATE" ON public.caption_history
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ── ig_accounts (본인 user_id) ──────────────────────────────────────────
ALTER POLICY "ig_accounts_delete_own" ON public.ig_accounts
  USING ((select auth.uid()) = user_id);
ALTER POLICY "ig_accounts: 본인 연동 정보 읽기 (토큰 제외)" ON public.ig_accounts
  USING ((select auth.uid()) = user_id);

-- ── link_blocks (page_id = 소유자 uid) ──────────────────────────────────
ALTER POLICY "link_blocks_owner_delete" ON public.link_blocks
  USING ((select auth.uid()) = page_id);
ALTER POLICY "link_blocks_owner_insert" ON public.link_blocks
  WITH CHECK ((select auth.uid()) = page_id);
ALTER POLICY "link_blocks_owner_update" ON public.link_blocks
  USING ((select auth.uid()) = page_id)
  WITH CHECK ((select auth.uid()) = page_id);

-- ── link_pages (본인 user_id) ───────────────────────────────────────────
ALTER POLICY "link_pages_owner_delete" ON public.link_pages
  USING ((select auth.uid()) = user_id);
ALTER POLICY "link_pages_owner_insert" ON public.link_pages
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "link_pages_owner_update" ON public.link_pages
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ── migration_history (seller_id) ───────────────────────────────────────
ALTER POLICY "Sellers see own migrations" ON public.migration_history
  USING (((select auth.uid()))::text = (seller_id)::text);

-- ── reservations (본인 user_id) — 핵심 게시 테이블 ──────────────────────
ALTER POLICY "reservations: 본인 예약 삭제" ON public.reservations
  USING ((select auth.uid()) = user_id);
ALTER POLICY "reservations: 본인 예약 생성" ON public.reservations
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "reservations: 본인 예약 읽기" ON public.reservations
  USING ((select auth.uid()) = user_id);
ALTER POLICY "reservations: 본인 예약 수정" ON public.reservations
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ── tiktok_accounts (seller_id) ─────────────────────────────────────────
ALTER POLICY "tiktok_accounts: 본인 연동 정보 읽기 (토큰 제외)" ON public.tiktok_accounts
  USING ((select auth.uid()) = seller_id);

-- ── tone_feedback (본인 user_id, ALL) ───────────────────────────────────
ALTER POLICY "tone_feedback: 본인 데이터 모든 작업" ON public.tone_feedback
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ── user_trend_feedback (user_id 텍스트, ALL) ───────────────────────────
ALTER POLICY "Users rate own feedback" ON public.user_trend_feedback
  USING (((select auth.uid()))::text = user_id);

-- ── current_setting(jwt) 기반 (seller_id 클레임) ────────────────────────
ALTER POLICY "failures_seller_own" ON public.failure_log
  USING ((seller_id)::text = (select (current_setting('request.jwt.claims'::text, true))::jsonb ->> 'seller_id'::text));
ALTER POLICY "Sellers read own consents" ON public.seller_consents
  USING ((seller_id)::text = (select (current_setting('request.jwt.claims'::text, true))::jsonb ->> 'seller_id'::text));
ALTER POLICY "Sellers can read own row" ON public.sellers
  USING ((id)::text = (select (current_setting('request.jwt.claims'::text, true))::jsonb ->> 'seller_id'::text));

COMMIT;

-- ============================================================================
-- 검증: Supabase 대시보드 → Advisors → Performance 재실행 →
--       "Auth RLS Initialization Plan" WARN 이 0 이면 완료.
-- 롤백 불필요 — 로직 동일, 평가 방식만 변경. 문제 시 위 (select auth.uid()) 를
--       다시 auth.uid() 로 되돌리면 원복.
-- ============================================================================
