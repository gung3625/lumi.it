-- ============================================================
-- set_threads_token — Threads access token Vault RPC
-- 2026-05-12 | Threads M1.3b (HANDOFF §12-A #1 revised)
--
-- 변경 내용:
--   1. public.set_threads_token(p_user_id uuid, p_existing_secret uuid, p_token text)
--      RETURNS uuid
--      — Threads access token 을 vault.create_secret / vault.update_secret
--        로 저장하고 secret_id 반환.
--
-- 의도:
--   set_ig_access_token / set_ig_page_access_token 와 1:1 대응. ig_accounts
--   가 access_token_secret_id 만 보관하듯 threads_token_secret_id 만 보관.
--   threads-oauth.js 콜백에서 호출 → 반환된 secret_id 를 ig_accounts.
--   threads_token_secret_id 에 upsert.
--
--   IG 측 RPC 들은 식별자로 ig_user_id(text) 를 받지만 Threads 는 사장님
--   user_id(uuid) 가 더 안정적 — Threads user_id 가 아직 없을 수도 있고
--   사장님 단위로 단일 토큰이라 user_id 가 자연스러움.
--
-- 보안: SECURITY DEFINER + search_path 고정 (set_ig_access_token 패턴 준수).
--       호출은 service_role 만 가능 (Netlify Function 에서 getAdminClient 사용).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.set_threads_token(
  p_user_id          uuid,
  p_existing_secret  uuid,
  p_token            text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
declare
  v_new_id uuid;
begin
  if p_existing_secret is null then
    v_new_id := vault.create_secret(
      new_secret      => p_token,
      new_name        => 'threads_token:' || p_user_id::text,
      new_description => 'Threads API access token'
    );
    return v_new_id;
  else
    perform vault.update_secret(p_existing_secret, p_token);
    return p_existing_secret;
  end if;
end;
$function$;

COMMENT ON FUNCTION public.set_threads_token(uuid, uuid, text) IS
  'Threads access token Vault 저장. NULL secret 이면 create_secret, 아니면 update_secret. set_ig_access_token 패턴 1:1. service_role 호출 전용.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- DOWN (롤백) — 필요 시 수동 실행
-- ============================================================
-- DROP FUNCTION IF EXISTS public.set_threads_token(uuid, uuid, text);
