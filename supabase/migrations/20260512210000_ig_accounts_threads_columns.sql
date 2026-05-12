-- ============================================================
-- ig_accounts — Threads 토큰·계정 컬럼 추가 (Vault 패턴)
-- 2026-05-12 | Threads M1.3a (HANDOFF §12-A #1)
--
-- 변경 내용:
--   1. ig_accounts 에 threads_* 컬럼 4개 추가
--      · threads_user_id          (text)         — Threads user id
--      · threads_token_secret_id  (uuid)         — Vault secret id
--      · threads_token_expires_at (timestamptz)  — 예상 만료
--      · threads_token_invalid_at (timestamptz)  — 실 API 호출 401/190 시각
--   2. ig_accounts_decrypted 뷰에 위 컬럼들 + 복호화된 threads_token 노출
--
-- 의도:
--   결정사항 §12-A #1 — Meta 통합 OAuth 로 IG·Threads 를 한 번에 연동.
--   즉 별도 threads_accounts 테이블을 두지 않고 `ig_accounts` 의 확장으로
--   처리. 토큰 자체는 IG 와 동일하게 Vault 에 암호화 저장하고
--   `ig_accounts_decrypted` 뷰에서 복호화 노출.
--
--   _shared/threads-graph.js (M1.2) 의 getThreadsTokenForSeller /
--   markThreadsTokenInvalid 가 이 컬럼·뷰에 의존. 본 마이그레이션 적용
--   후부터 정상 동작.
--
-- 멱등성: ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE VIEW
-- 백필: 없음. 기존 사장님은 threads_user_id=NULL (Threads 미연동 상태).
-- ============================================================

BEGIN;

ALTER TABLE public.ig_accounts
  ADD COLUMN IF NOT EXISTS threads_user_id          TEXT,
  ADD COLUMN IF NOT EXISTS threads_token_secret_id  UUID,
  ADD COLUMN IF NOT EXISTS threads_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS threads_token_invalid_at TIMESTAMPTZ;

COMMENT ON COLUMN public.ig_accounts.threads_user_id           IS
  'Threads user ID — Meta 통합 OAuth 결과 (결정 §12-A #1). NULL = Threads 미연동.';
COMMENT ON COLUMN public.ig_accounts.threads_token_secret_id   IS
  'Threads access token 의 vault.secrets.id. ig_accounts_decrypted 뷰에서 복호화 노출.';
COMMENT ON COLUMN public.ig_accounts.threads_token_expires_at  IS
  'Threads access token 예상 만료 시각 (Meta long-lived token).';
COMMENT ON COLUMN public.ig_accounts.threads_token_invalid_at  IS
  '실 Threads API 호출에서 401/code 190 받은 시각. cron 들이 사전 차단용으로 체크. _shared/threads-graph.js 의 markThreadsTokenInvalid 가 마킹.';

-- ============================================================
-- ig_accounts_decrypted 뷰 갱신 — threads 컬럼 4개 추가
-- ============================================================
CREATE OR REPLACE VIEW public.ig_accounts_decrypted AS
SELECT
  ig.ig_user_id,
  ig.user_id,
  ig.ig_username,
  ig.page_id,
  at_sec.decrypted_secret AS access_token,
  pt_sec.decrypted_secret AS page_access_token,
  ig.token_expires_at,
  ig.connected_at,
  ig.updated_at,
  ig.threads_user_id,
  th_sec.decrypted_secret AS threads_token,
  ig.threads_token_expires_at,
  ig.threads_token_invalid_at
FROM public.ig_accounts ig
  LEFT JOIN vault.decrypted_secrets at_sec ON at_sec.id = ig.access_token_secret_id
  LEFT JOIN vault.decrypted_secrets pt_sec ON pt_sec.id = ig.page_access_token_secret_id
  LEFT JOIN vault.decrypted_secrets th_sec ON th_sec.id = ig.threads_token_secret_id;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- DOWN (롤백) — 필요 시 수동 실행
-- ============================================================
-- CREATE OR REPLACE VIEW public.ig_accounts_decrypted AS
--   SELECT ig.ig_user_id, ig.user_id, ig.ig_username, ig.page_id,
--     at_sec.decrypted_secret AS access_token,
--     pt_sec.decrypted_secret AS page_access_token,
--     ig.token_expires_at, ig.connected_at, ig.updated_at
--   FROM public.ig_accounts ig
--     LEFT JOIN vault.decrypted_secrets at_sec ON at_sec.id = ig.access_token_secret_id
--     LEFT JOIN vault.decrypted_secrets pt_sec ON pt_sec.id = ig.page_access_token_secret_id;
-- ALTER TABLE public.ig_accounts
--   DROP COLUMN IF EXISTS threads_token_invalid_at,
--   DROP COLUMN IF EXISTS threads_token_expires_at,
--   DROP COLUMN IF EXISTS threads_token_secret_id,
--   DROP COLUMN IF EXISTS threads_user_id;
