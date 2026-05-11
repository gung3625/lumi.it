-- ig_accounts 에 token_invalid_at 추가 — 실 API 호출에서 토큰 실패 감지
-- 2026-05-12
--
-- 기존 token_expires_at 은 Meta 가 알려준 만료 예정 시각.
-- 그러나 그 전에 사용자 측 (비번 변경, 권한 회수) 으로 토큰 무효화될 수 있음.
-- cron 이 401/code 190 받으면 token_invalid_at = now() 로 set 해서
-- 1) 다음 cron 들이 호출 스킵 (rate limit 낭비 방지)
-- 2) 사장님 대시보드에 "IG 재연동 필요" 안내 가능
-- 재연동(ig-oauth 콜백) 시 NULL 로 복구.

BEGIN;

ALTER TABLE public.ig_accounts
  ADD COLUMN IF NOT EXISTS token_invalid_at TIMESTAMPTZ;

COMMENT ON COLUMN public.ig_accounts.token_invalid_at IS
  '실제 API 호출에서 401/code 190 받은 시각. 재연동 시 NULL 복구. token_expires_at 과 별개 — 예상 만료 vs 실 무효화.';

NOTIFY pgrst, 'reload schema';

COMMIT;
