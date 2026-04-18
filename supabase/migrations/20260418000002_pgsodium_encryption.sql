-- ============================================================
-- lumi.it 토큰 암호화 (Phase 1) — Supabase Vault 기반
-- 2026-04-18
--
-- 배경:
--   당초 계획(`pgsodium`)은 Supabase 2025년 이후 deprecated.
--   현 Supabase 인프라에는 `supabase_vault` 0.3.1 만 제공됨.
--   → Transparent Column Encryption 대신,
--      `vault.create_secret(text)` 로 토큰을 Vault에 저장하고
--      `ig_accounts` 테이블에는 secret_id(uuid)만 보관.
--      복호화는 service_role 만 `vault.decrypted_secrets` 또는
--      보조 함수 `public.get_ig_tokens()` 를 통해 읽는다.
-- ============================================================

-- 1. ig_accounts 에 secret_id 컬럼 추가, 기존 텍스트 토큰 컬럼 제거.
alter table public.ig_accounts
  add column if not exists access_token_secret_id      uuid,
  add column if not exists page_access_token_secret_id uuid;

-- 기존 plaintext 컬럼 제거 (이전 단계에서 비어 있으므로 안전하게 drop)
alter table public.ig_accounts
  drop column if exists access_token,
  drop column if exists page_access_token;

-- access_token 은 필수, page_access_token 은 선택
alter table public.ig_accounts
  alter column access_token_secret_id set not null;

-- ============================================================
-- 2. 토큰 저장 헬퍼 (service_role 전용).
--    - 새 연동: insert 전에 secret_id 를 얻어 ig_accounts 에 저장
--    - 재연결/토큰 갱신: 동일 secret_id 에 update_secret 으로 덮어쓰기
--
--    (앱 서버 코드에서 SQL/RPC 로 호출. RLS 우회를 위해 definer 권한 사용)
-- ============================================================

-- 토큰 upsert 헬퍼.
-- 인자:
--   p_ig_user_id       : IG Graph API User ID (ig_accounts.ig_user_id)
--   p_existing_secret  : 기존 secret_id (없으면 NULL) — 호출 측이 ig_accounts 에서 SELECT 해서 넘김
--   p_access_token     : 평문 토큰
-- 반환:
--   upsert 후 사용해야 할 secret_id. 첫 저장이면 신규 uuid, 갱신이면 기존 uuid 그대로.
create or replace function public.set_ig_access_token(
  p_ig_user_id       text,
  p_existing_secret  uuid,
  p_access_token     text
) returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_new_id uuid;
begin
  if p_existing_secret is null then
    v_new_id := vault.create_secret(
      new_secret      => p_access_token,
      new_name        => 'ig_access_token:' || p_ig_user_id,
      new_description => 'Instagram Graph API access token'
    );
    return v_new_id;
  else
    perform vault.update_secret(p_existing_secret, p_access_token);
    return p_existing_secret;
  end if;
end;
$$;

create or replace function public.set_ig_page_access_token(
  p_ig_user_id       text,
  p_existing_secret  uuid,
  p_page_token       text
) returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_new_id uuid;
begin
  if p_existing_secret is null then
    v_new_id := vault.create_secret(
      new_secret      => p_page_token,
      new_name        => 'ig_page_access_token:' || p_ig_user_id,
      new_description => 'Instagram Facebook Page access token'
    );
    return v_new_id;
  else
    perform vault.update_secret(p_existing_secret, p_page_token);
    return p_existing_secret;
  end if;
end;
$$;

-- 권한: service_role 만 호출 가능
revoke all on function public.set_ig_access_token(text, uuid, text)       from public, anon, authenticated;
revoke all on function public.set_ig_page_access_token(text, uuid, text)  from public, anon, authenticated;
grant  execute on function public.set_ig_access_token(text, uuid, text)       to service_role;
grant  execute on function public.set_ig_page_access_token(text, uuid, text)  to service_role;

-- ============================================================
-- 3. 복호화 뷰 — service_role 전용
--    vault.decrypted_secrets 는 기본적으로 privileged role 만 접근 가능.
--    JOIN 편의를 위해 public.ig_accounts_decrypted 래퍼 제공.
-- ============================================================
create or replace view public.ig_accounts_decrypted
  with (security_invoker = true) as
select
  ig.ig_user_id,
  ig.user_id,
  ig.ig_username,
  ig.page_id,
  at_sec.decrypted_secret   as access_token,
  pt_sec.decrypted_secret   as page_access_token,
  ig.token_expires_at,
  ig.connected_at,
  ig.updated_at
from public.ig_accounts ig
left join vault.decrypted_secrets at_sec on at_sec.id = ig.access_token_secret_id
left join vault.decrypted_secrets pt_sec on pt_sec.id = ig.page_access_token_secret_id;

-- 권한: anon/authenticated 접근 금지, service_role 만 허용
revoke all on public.ig_accounts_decrypted from anon, authenticated;
grant  select on public.ig_accounts_decrypted to service_role;

comment on view public.ig_accounts_decrypted is
  'service_role 전용: Vault 에 저장된 IG 토큰을 복호화하여 조회. 프론트/anon 노출 금지';

-- ============================================================
-- 4. ig_accounts 삭제 시 Vault secret 도 함께 정리 (cascading cleanup)
-- ============================================================
create or replace function public.tg_ig_accounts_delete_secrets()
returns trigger
language plpgsql
security definer
set search_path = vault
as $$
begin
  if old.access_token_secret_id is not null then
    delete from vault.secrets where id = old.access_token_secret_id;
  end if;
  if old.page_access_token_secret_id is not null then
    delete from vault.secrets where id = old.page_access_token_secret_id;
  end if;
  return old;
end;
$$;

drop trigger if exists ig_accounts_delete_secrets on public.ig_accounts;
create trigger ig_accounts_delete_secrets
  after delete on public.ig_accounts
  for each row execute function public.tg_ig_accounts_delete_secrets();
