-- ============================================================================
-- lumi 보안 하드닝 SQL  (사장님이 Supabase SQL Editor 에서 직접 실행)
-- 생성: 2026-06-07 / 근거: Supabase Security Advisor 현재 상태
--
-- ⚠️ 이 SQL 은 접근권한(EXECUTE 권한 / 스토리지 정책) 변경이라 어시스턴트가
--    프로덕션에 직접 실행하지 않고 사장님 검토·실행용으로 준비했습니다.
--
-- 안전성 검증 완료 (영향 0):
--   - lumi 백엔드는 전부 service_role(getAdminClient)로 DB·스토리지 접근.
--   - service_role 은 함수 EXECUTE 권한과 스토리지 RLS 정책을 둘 다 "우회"하므로
--     아래 REVOKE / DROP 후에도 앱 동작에 영향이 없습니다.
--   - 호출처 확인: bump_openai_quota_atomic←openai-quota.js(admin),
--     set_threads_token←threads-oauth.js(admin), delete_vault_secret←
--     disconnect-ig/data-deletion-callback(admin), cleanup_orphan_vault_secrets←
--     scheduled-vault-cleanup(admin). 나머지 4개는 트리거 함수(RPC 호출 없음).
--   - 공개버킷 이미지는 /storage/v1/object/public/ URL(버킷 public 플래그)로
--     서빙돼, listing 정책을 지워도 이미지 표시는 그대로 동작합니다.
--
-- 실행: 전체 복사 → SQL Editor 붙여넣기 → Run. 트랜잭션으로 감싸 일부 실패 시 롤백.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- PART A. anon / authenticated 가 호출 가능한 SECURITY DEFINER 함수 8개
--          EXECUTE 권한 회수 (외부에서 /rest/v1/rpc/ 로 직접 호출 차단).
--          service_role 은 명시적으로 다시 GRANT 해 앱 호출 100% 보존.
-- ────────────────────────────────────────────────────────────────────────

-- 1) OpenAI 예산 차감 (백엔드 openai-quota.js 가 service_role 로 호출)
REVOKE EXECUTE ON FUNCTION public.bump_openai_quota_atomic(text, date, date, numeric) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bump_openai_quota_atomic(text, date, date, numeric) TO service_role;

-- 2) Threads 토큰 Vault 저장 (threads-oauth.js, service_role)
REVOKE EXECUTE ON FUNCTION public.set_threads_token(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_threads_token(uuid, uuid, text) TO service_role;

-- 3) Vault 시크릿 삭제 (disconnect-ig.js, data-deletion-callback.js, service_role)
REVOKE EXECUTE ON FUNCTION public.delete_vault_secret(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_vault_secret(uuid) TO service_role;

-- 4) 고아 Vault 시크릿 정리 (scheduled-vault-cleanup, service_role)
REVOKE EXECUTE ON FUNCTION public.cleanup_orphan_vault_secrets() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cleanup_orphan_vault_secrets() TO service_role;

-- 5) auth 유저 동기화 — 트리거 함수 (RPC 호출 경로 없음 → 회수만)
REVOKE EXECUTE ON FUNCTION public.handle_auth_user_sync() FROM PUBLIC, anon, authenticated;

-- 6) RLS 자동 활성화 — 트리거/유지보수 함수 (RPC 호출 경로 없음)
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

-- 7) IG 계정 삭제 시 시크릿 정리 — 트리거 함수
REVOKE EXECUTE ON FUNCTION public.tg_ig_accounts_delete_secrets() FROM PUBLIC, anon, authenticated;

-- 8) TikTok 계정 삭제 시 시크릿 정리 — 트리거 함수
REVOKE EXECUTE ON FUNCTION public.tg_tiktok_accounts_delete_secrets() FROM PUBLIC, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────
-- PART B. 공개버킷 6개의 "전체 listing 허용" SELECT 정책 제거.
--          공개 URL 서빙(/object/public/)은 유지되고, 익명 파일 목록 열람만 차단.
--          (앱의 .list() 는 service_role 이라 영향 없음.)
-- ────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "link_assets_public_read"      ON storage.objects;  -- link-assets
DROP POLICY IF EXISTS "lumi-images: 공개 읽기"        ON storage.objects;  -- lumi-images
DROP POLICY IF EXISTS "lumi-promo public read"       ON storage.objects;  -- lumi-promo
DROP POLICY IF EXISTS "lumi-videos: 공개 읽기"        ON storage.objects;  -- lumi-videos
DROP POLICY IF EXISTS "Public read product images"   ON storage.objects;  -- product-images
DROP POLICY IF EXISTS "tutorial_demo_public_read"    ON storage.objects;  -- tutorial-demo

COMMIT;

-- ============================================================================
-- 검증
-- ============================================================================
-- 가장 확실한 방법: Supabase 대시보드 → Advisors → Security 재실행.
--   "Public Can Execute SECURITY DEFINER Function" 8건과
--   "Public Bucket Allows Listing" 6건이 사라졌으면 적용 완료.
--
-- SQL 로 빠르게 확인하려면 (각각 따로 Run):
--   -- A) anon 이 아직 실행 가능한 함수가 있나 (0행이면 OK):
--   SELECT proname FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('bump_openai_quota_atomic','set_threads_token','delete_vault_secret',
--                     'cleanup_orphan_vault_secrets','handle_auth_user_sync','rls_auto_enable',
--                     'tg_ig_accounts_delete_secrets','tg_tiktok_accounts_delete_secrets')
--     AND has_function_privilege('anon', oid, 'EXECUTE');
--
--   -- B) 남은 공개버킷 listing 정책 (0행이면 OK):
--   SELECT policyname FROM pg_policies
--   WHERE schemaname='storage' AND tablename='objects'
--     AND policyname IN ('link_assets_public_read','lumi-images: 공개 읽기','lumi-promo public read',
--                        'lumi-videos: 공개 읽기','Public read product images','tutorial_demo_public_read');

-- ============================================================================
-- 추가 권장(이 파일 밖, 선택):
--   1) Supabase 대시보드 → Authentication → Policies →
--      "Leaked password protection" 켜기 (HaveIBeenPwned 대조, 클릭 한 번).
--   2) SECURITY DEFINER 함수 search_path 고정(WARN) 은 하드닝이지만 런칭 차단 아님.
--      필요 시 ALTER FUNCTION ... SET search_path = '' 로 별도 처리.
-- ============================================================================
