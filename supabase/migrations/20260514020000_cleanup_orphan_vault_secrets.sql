-- ============================================================
-- cleanup_orphan_vault_secrets() — Vault orphan 청소 cron 헬퍼
-- 2026-05-14 | HANDOFF §12-A 남은 후속
--
-- 의도:
--   disconnect-ig / disconnect-threads 가 정상 호출되면 delete_vault_secret
--   으로 즉시 청소 중. 하지만 다음 경로로 orphan 이 누적될 수 있음:
--     - 사장님 탈퇴 (CASCADE 로 ig_accounts/tiktok_accounts row 삭제) →
--       vault.secrets 는 cascade 안 됨
--     - disconnect 호출 직후 Vault 청소가 best-effort 라 실패할 가능성
--     - 옛 마이그레이션 잔재
--
--   본 함수는 lumi 명명규약 (ig_access_token:* / ig_page_access_token:* /
--   threads_token:* / tiktok_access_token:* / tiktok_refresh_token:*) 인
--   secret 중 어느 ig_accounts/tiktok_accounts row 에도 참조되지 않는
--   것만 삭제.
--
-- 보안: service_role 호출 전용 (anon/authenticated GRANT 없음).
-- 호출 빈도: 주 1회 cron (scheduled-vault-cleanup-background).
-- 멱등: 호출마다 현재 시점 orphan 만 삭제. 동시 실행이 안전.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.cleanup_orphan_vault_secrets()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
declare
  v_deleted integer := 0;
begin
  with referenced as (
    -- ig_accounts 의 3종 secret_id 참조
    select access_token_secret_id      as id from public.ig_accounts where access_token_secret_id      is not null
    union
    select page_access_token_secret_id as id from public.ig_accounts where page_access_token_secret_id is not null
    union
    select threads_token_secret_id     as id from public.ig_accounts where threads_token_secret_id     is not null
    -- tiktok_accounts 2종 (현재 비활성 영역 — 안전망)
    union
    select access_token_secret_id      as id from public.tiktok_accounts where access_token_secret_id  is not null
    union
    select refresh_token_secret_id     as id from public.tiktok_accounts where refresh_token_secret_id is not null
  ),
  deleted as (
    delete from vault.secrets s
    where (
        s.name like 'ig_access_token:%'
        or s.name like 'ig_page_access_token:%'
        or s.name like 'threads_token:%'
        or s.name like 'tiktok_access_token:%'
        or s.name like 'tiktok_refresh_token:%'
      )
      and s.id not in (select id from referenced where id is not null)
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;
  return v_deleted;
end;
$function$;

COMMENT ON FUNCTION public.cleanup_orphan_vault_secrets() IS
  'lumi 명명규약 vault secret 중 ig_accounts/tiktok_accounts 에 참조 안 된 orphan 삭제. 주 1회 cron 호출. service_role 전용.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- DOWN (롤백) — 필요 시 수동 실행
-- ============================================================
-- DROP FUNCTION IF EXISTS public.cleanup_orphan_vault_secrets();
