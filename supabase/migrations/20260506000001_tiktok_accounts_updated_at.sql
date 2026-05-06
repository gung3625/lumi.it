-- ============================================================
-- BLOCKER #4: tiktok_accounts updated_at 컬럼 추가
-- BLOCKER #5: RLS auth.uid() 표준화
-- 2026-05-06
-- ============================================================

-- ============================================================
-- 1. updated_at 컬럼 + 자동 갱신 트리거
-- ============================================================
alter table public.tiktok_accounts
  add column if not exists updated_at timestamptz default now();

create or replace function public.tiktok_accounts_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tg_tiktok_accounts_updated_at on public.tiktok_accounts;
create trigger tg_tiktok_accounts_updated_at
  before update on public.tiktok_accounts
  for each row execute function public.tiktok_accounts_set_updated_at();

-- ============================================================
-- 2. RLS auth.uid() 표준화
--    sellers.id = auth.users(id) → auth.uid() = seller_id
--    기존 정책(current_setting 방식) 교체
-- ============================================================
drop policy if exists "tiktok_accounts: 본인 연동 정보 읽기 (토큰 제외)" on public.tiktok_accounts;
create policy "tiktok_accounts: 본인 연동 정보 읽기 (토큰 제외)"
  on public.tiktok_accounts for select
  using (auth.uid() = seller_id);

-- ============================================================
-- PostgREST 스키마 리로드
-- ============================================================
notify pgrst, 'reload schema';
