-- ============================================================
-- delete_vault_secret(p_secret_id uuid) — Vault secret 삭제 헬퍼
-- 2026-05-13 | 코드 리뷰 후속 #4
--
-- 변경 내용:
--   1. public.delete_vault_secret(p_secret_id uuid) RETURNS boolean
--      — vault.secrets 의 한 행을 안전하게 삭제. service_role 호출 전용.
--
-- 의도:
--   사장님이 IG/Threads 연결 해제 시 ig_accounts row 의 *_secret_id 만
--   NULL 로 비우고 vault.secrets 의 실제 행은 그대로 남았음 → orphan 누적.
--   token 이 vault 에 영구 보존되면 DB 유출 시 평문 노출 위험.
--   본 RPC 가 disconnect-ig.js / disconnect-threads.js 에서 호출돼 즉시 청소.
--
--   set_ig_access_token / set_ig_page_access_token / set_threads_token 의
--   대칭 함수. SECURITY DEFINER + search_path 고정 (set_* 패턴 준수).
--
-- 보안: service_role 만 호출 (anon/authenticated GRANT 없음 — RLS 가 아닌
--       호출 권한 자체가 service_role 전용).
-- 멱등: 존재하지 않는 secret_id 도 안전 (DELETE 가 0 row 영향, 에러 X).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_vault_secret(p_secret_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
begin
  if p_secret_id is null then
    return false;
  end if;
  delete from vault.secrets where id = p_secret_id;
  return true;
end;
$function$;

COMMENT ON FUNCTION public.delete_vault_secret(uuid) IS
  'Vault secret 안전 삭제. NULL 이면 false 반환 (no-op). disconnect 시점 orphan 청소용. service_role 호출 전용.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- DOWN (롤백) — 필요 시 수동 실행
-- ============================================================
-- DROP FUNCTION IF EXISTS public.delete_vault_secret(uuid);
