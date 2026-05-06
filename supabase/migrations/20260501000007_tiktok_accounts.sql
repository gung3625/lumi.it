-- ============================================================
-- TikTok Content Posting API 지원 — 계정 연동 + 예약 채널 확장
-- 2026-05-06
--
-- 포함 내용:
--   1. tiktok_accounts 테이블 (IG ig_accounts 패턴 동일)
--   2. tiktok_accounts_decrypted 뷰 (IG ig_accounts_decrypted 패턴 동일)
--   3. set_tiktok_access_token RPC (IG set_ig_access_token 패턴 동일)
--   4. tiktok_accounts 삭제 시 Vault secret 정리 트리거
--   5. reservations 테이블 — TikTok 게시 컬럼 추가
--   6. sellers 테이블 — TikTok 연동 상태 컬럼 추가
--
-- 멱등성: 모든 CREATE는 IF NOT EXISTS, ALTER ADD COLUMN은 IF NOT EXISTS
-- 패턴 출처:
--   - 20260418000000_initial_schema.sql (ig_accounts 테이블 구조)
--   - 20260418000002_pgsodium_encryption.sql (vault 암호화·뷰·RPC)
--   - 20260418000001_rls_policies.sql (RLS 정책)
-- ============================================================

-- ============================================================
-- 1. tiktok_accounts 테이블
--    IG ig_accounts 패턴과 동일. seller_id UUID PRIMARY KEY (FK → sellers).
--    access_token / refresh_token 은 Vault secret_id 만 보관.
-- ============================================================
create table if not exists public.tiktok_accounts (
  seller_id                     uuid primary key references public.sellers(id) on delete cascade,
  open_id                       text not null,              -- TikTok user open_id
  union_id                      text,                       -- TikTok union_id (있을 경우)
  display_name                  text,
  avatar_url                    text,
  access_token_secret_id        uuid,                       -- vault.secrets(id)
  refresh_token_secret_id       uuid,                       -- vault.secrets(id)
  access_token_expires_at       timestamptz,
  refresh_token_expires_at      timestamptz,
  scope                         text,                       -- 부여된 스코프 (e.g. "video.publish,user.info.basic")
  token_status                  text not null default 'active'
                                  check (token_status in ('active', 'expired', 'revoked')),
  last_refreshed_at             timestamptz,
  connected_at                  timestamptz not null default now(),
  disconnected_at               timestamptz
);

create index if not exists idx_tiktok_accounts_open_id on public.tiktok_accounts (open_id);

comment on table public.tiktok_accounts is
  'TikTok Content Posting API 연동. access_token/refresh_token은 Vault에 저장, 이 테이블에는 secret_id(uuid)만 보관.';
comment on column public.tiktok_accounts.open_id is 'TikTok user open_id (앱 내 고유 식별자)';
comment on column public.tiktok_accounts.union_id is 'TikTok union_id (동일 개발자 계정의 여러 앱 간 공유 식별자, 없을 수 있음)';
comment on column public.tiktok_accounts.token_status is 'active | expired | revoked';

-- ============================================================
-- 2. RLS — ig_accounts 패턴 동일
--    seller 본인만 SELECT, INSERT/UPDATE/DELETE는 service_role 전용
-- ============================================================
alter table public.tiktok_accounts enable row level security;

drop policy if exists "tiktok_accounts: 본인 연동 정보 읽기 (토큰 제외)" on public.tiktok_accounts;
create policy "tiktok_accounts: 본인 연동 정보 읽기 (토큰 제외)"
  on public.tiktok_accounts for select
  using (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

-- INSERT/UPDATE/DELETE 는 service_role 전용 (토큰 관리 책임)

-- ============================================================
-- 3. tiktok_accounts_decrypted 뷰
--    IG ig_accounts_decrypted 패턴 동일.
--    vault.decrypted_secrets JOIN으로 토큰 평문 노출.
--    service_role 만 SELECT 가능.
-- ============================================================
create or replace view public.tiktok_accounts_decrypted
  with (security_invoker = true) as
select
  ta.seller_id,
  ta.open_id,
  ta.union_id,
  ta.display_name,
  ta.avatar_url,
  at_sec.decrypted_secret   as access_token,
  rt_sec.decrypted_secret   as refresh_token,
  ta.access_token_expires_at,
  ta.refresh_token_expires_at,
  ta.scope,
  ta.token_status,
  ta.last_refreshed_at,
  ta.connected_at,
  ta.disconnected_at
from public.tiktok_accounts ta
left join vault.decrypted_secrets at_sec on at_sec.id = ta.access_token_secret_id
left join vault.decrypted_secrets rt_sec on rt_sec.id = ta.refresh_token_secret_id;

-- 권한: anon/authenticated 접근 금지, service_role 만 허용 (IG 동일 패턴)
revoke all on public.tiktok_accounts_decrypted from anon, authenticated;
grant  select on public.tiktok_accounts_decrypted to service_role;

comment on view public.tiktok_accounts_decrypted is
  'service_role 전용: Vault에 저장된 TikTok 토큰을 복호화하여 조회. 프론트/anon 노출 금지.';

-- ============================================================
-- 4. set_tiktok_access_token RPC
--    IG set_ig_access_token 패턴 동일.
--    tiktok_accounts UPSERT + access/refresh 토큰 Vault 처리.
--    SECURITY DEFINER, service_role 전용.
--
--    인자:
--      p_seller_id         : sellers.id
--      p_open_id           : TikTok user open_id
--      p_access_token      : 평문 access token
--      p_refresh_token     : 평문 refresh token
--      p_access_expires_at : access token 만료 시각
--      p_refresh_expires_at: refresh token 만료 시각 (없으면 NULL)
--      p_scope             : 부여된 스코프 문자열 (없으면 NULL)
-- ============================================================
create or replace function public.set_tiktok_access_token(
  p_seller_id          uuid,
  p_open_id            text,
  p_access_token       text,
  p_refresh_token      text,
  p_access_expires_at  timestamptz,
  p_refresh_expires_at timestamptz default null,
  p_scope              text        default null
) returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_at_id  uuid;
  v_existing_rt_id  uuid;
  v_new_at_id       uuid;
  v_new_rt_id       uuid;
begin
  -- 기존 secret_id 조회 (있으면 update_secret, 없으면 create_secret)
  select access_token_secret_id, refresh_token_secret_id
    into v_existing_at_id, v_existing_rt_id
    from public.tiktok_accounts
   where seller_id = p_seller_id;

  -- access_token vault 처리 (IG set_ig_access_token 패턴 동일)
  if v_existing_at_id is null then
    v_new_at_id := vault.create_secret(
      new_secret      => p_access_token,
      new_name        => 'tiktok_access_token:' || p_seller_id::text,
      new_description => 'TikTok Content Posting API access token'
    );
  else
    perform vault.update_secret(v_existing_at_id, p_access_token);
    v_new_at_id := v_existing_at_id;
  end if;

  -- refresh_token vault 처리
  if p_refresh_token is not null then
    if v_existing_rt_id is null then
      v_new_rt_id := vault.create_secret(
        new_secret      => p_refresh_token,
        new_name        => 'tiktok_refresh_token:' || p_seller_id::text,
        new_description => 'TikTok Content Posting API refresh token'
      );
    else
      perform vault.update_secret(v_existing_rt_id, p_refresh_token);
      v_new_rt_id := v_existing_rt_id;
    end if;
  else
    v_new_rt_id := v_existing_rt_id;
  end if;

  -- tiktok_accounts UPSERT
  insert into public.tiktok_accounts (
    seller_id,
    open_id,
    access_token_secret_id,
    refresh_token_secret_id,
    access_token_expires_at,
    refresh_token_expires_at,
    scope,
    token_status,
    last_refreshed_at,
    connected_at
  ) values (
    p_seller_id,
    p_open_id,
    v_new_at_id,
    v_new_rt_id,
    p_access_expires_at,
    p_refresh_expires_at,
    p_scope,
    'active',
    now(),
    now()
  )
  on conflict (seller_id) do update set
    open_id                  = excluded.open_id,
    access_token_secret_id   = excluded.access_token_secret_id,
    refresh_token_secret_id  = excluded.refresh_token_secret_id,
    access_token_expires_at  = excluded.access_token_expires_at,
    refresh_token_expires_at = excluded.refresh_token_expires_at,
    scope                    = coalesce(excluded.scope, public.tiktok_accounts.scope),
    token_status             = 'active',
    last_refreshed_at        = now(),
    disconnected_at          = null;
end;
$$;

-- 권한: service_role 만 호출 가능 (IG 동일 패턴)
revoke all on function public.set_tiktok_access_token(uuid, text, text, text, timestamptz, timestamptz, text)
  from public, anon, authenticated;
grant  execute on function public.set_tiktok_access_token(uuid, text, text, text, timestamptz, timestamptz, text)
  to service_role;

-- ============================================================
-- 5. tiktok_accounts 삭제 시 Vault secret 정리
--    IG tg_ig_accounts_delete_secrets 패턴 동일
-- ============================================================
create or replace function public.tg_tiktok_accounts_delete_secrets()
returns trigger
language plpgsql
security definer
set search_path = vault
as $$
begin
  if old.access_token_secret_id is not null then
    delete from vault.secrets where id = old.access_token_secret_id;
  end if;
  if old.refresh_token_secret_id is not null then
    delete from vault.secrets where id = old.refresh_token_secret_id;
  end if;
  return old;
end;
$$;

drop trigger if exists tiktok_accounts_delete_secrets on public.tiktok_accounts;
create trigger tiktok_accounts_delete_secrets
  after delete on public.tiktok_accounts
  for each row execute function public.tg_tiktok_accounts_delete_secrets();

-- ============================================================
-- 6. reservations 테이블 — TikTok 게시 컬럼 추가
--    post_channel: 'instagram'(기본) | 'tiktok' | 'both'
-- ============================================================
alter table public.reservations
  add column if not exists post_channel            text default 'instagram',
  add column if not exists tiktok_publish_id       text,
  add column if not exists tiktok_status           text,
  add column if not exists tiktok_error            text,
  add column if not exists tiktok_privacy_level    text,
  add column if not exists tiktok_disable_comment  boolean default false,
  add column if not exists tiktok_disable_duet     boolean default false,
  add column if not exists tiktok_disable_stitch   boolean default false;

comment on column public.reservations.post_channel is 'instagram | tiktok | both';
comment on column public.reservations.tiktok_publish_id is 'TikTok Content Posting API publish_id';
comment on column public.reservations.tiktok_status is 'ok | failed | token_expired';
comment on column public.reservations.tiktok_error is 'TikTok 게시 실패 에러 메시지';
comment on column public.reservations.tiktok_privacy_level is 'PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS | FOLLOWER_OF_CREATOR | SELF_ONLY';
comment on column public.reservations.tiktok_disable_comment is 'TikTok 댓글 비활성화 여부';
comment on column public.reservations.tiktok_disable_duet is 'TikTok 듀엣 비활성화 여부';
comment on column public.reservations.tiktok_disable_stitch is 'TikTok 스티치 비활성화 여부';

-- ============================================================
-- 7. sellers 테이블 — TikTok 연동 상태 컬럼 추가
--    settings.html에서 tiktok_connected, tiktok_handle, tiktok_connected_at 참조
-- ============================================================
alter table public.sellers
  add column if not exists tiktok_connected       boolean default false,
  add column if not exists tiktok_handle          text,
  add column if not exists tiktok_connected_at    timestamptz,
  add column if not exists tiktok_disconnected_at timestamptz;

comment on column public.sellers.tiktok_connected is 'TikTok 연동 여부';
comment on column public.sellers.tiktok_handle is 'TikTok 표시 이름 (display_name)';
comment on column public.sellers.tiktok_connected_at is 'TikTok 최초 연동 시각';
comment on column public.sellers.tiktok_disconnected_at is 'TikTok 연동 해제 시각';

-- ============================================================
-- PostgREST 스키마 리로드
-- ============================================================
notify pgrst, 'reload schema';
