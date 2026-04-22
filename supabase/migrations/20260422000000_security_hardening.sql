-- ============================================================
-- Security Hardening — RLS 정책 보강 + FK CASCADE 조정
-- 2026-04-22
--
-- 배경:
--   침투테스트(CSO) 결과 RLS 미적용 테이블이 공개 REST 엔드포인트로
--   anon 키를 통해 타인 데이터 접근 가능성 → 본 마이그레이션으로 전부 막음.
--   또한 PIPA §21(파기 의무) 대응으로 auto_reply_log FK를 CASCADE 로 변경,
--   탈퇴 시 고객 DM 원문이 user_id=NULL 상태로 영구 잔존하는 위험 제거.
--   결제/계약 테이블(orders)은 전자상거래법 §7(5년 보유)이라 손대지 않음.
--
-- 구성:
--   Part 1. auto_reply_log FK on delete cascade 로 교체
--   Part 2. 누락 테이블 RLS enable + 본인 user_id 정책 4종
--            (auto_reply_settings/_log/_corrections, store_context,
--             promo_schedule, brand_content_library, brand_weekday_schedule)
--   Part 3. account_deletion_log 감사 로그 테이블 신규
--   Part 4. auto_reply_log_safe 마스킹 뷰 (관리자 디버깅용)
--
-- 멱등성: 모든 블록은 if exists / drop policy if exists / do-block 으로 감쌈.
-- 기존 데이터 손실 없음 (컬럼 추가·삭제 없음, FK 재생성만).
-- ============================================================

-- ============================================================
-- Part 1. auto_reply_log.user_id FK → on delete cascade
--   기존: on delete set null  (고객 DM 원문이 고아 레코드로 잔존 → PIPA 위반)
--   변경: on delete cascade   (탈퇴 시 해당 사용자 로그 전부 삭제)
--
--   결제/계약 테이블(orders)은 전자상거래법 5년 보유 의무가 있으므로
--   CASCADE 금지. user_id 는 탈퇴 시 auth.users 삭제와 함께 자동 NULL 로
--   내려가지 않도록 orders.user_id 는 ON DELETE CASCADE 유지(이미 그러함).
--   만약 향후 결제 익명화가 필요하면 별도 scrub job 으로 user_id → hash 치환.
-- ============================================================
do $$
begin
  if to_regclass('public.auto_reply_log') is not null then
    execute 'alter table public.auto_reply_log drop constraint if exists auto_reply_log_user_id_fkey';
    execute $sql$
      alter table public.auto_reply_log
        add constraint auto_reply_log_user_id_fkey
        foreign key (user_id) references auth.users(id) on delete cascade
    $sql$;
  end if;
end $$;

-- ============================================================
-- Part 2. 누락 테이블 RLS enable + 4종 정책 (select/insert/update/delete)
--
--   service_role 은 RLS bypass 이므로 Netlify Functions(service_role 사용)는
--   영향 없음. anon/authenticated 키로 Supabase REST 직접 호출 시 타인 행
--   접근이 원천 차단됨.
--
--   테이블 존재 여부 방어: to_regclass() 로 선체크 후 execute.
-- ============================================================

-- 공통 매크로: 테이블명 → 4종 정책 생성 do-block
-- (PL/pgSQL 매크로가 없으므로 테이블마다 동일 패턴 반복)

-- ----- auto_reply_settings -----
do $$
begin
  if to_regclass('public.auto_reply_settings') is not null then
    execute 'alter table public.auto_reply_settings enable row level security';
    execute 'drop policy if exists "auto_reply_settings_select_own" on public.auto_reply_settings';
    execute 'drop policy if exists "auto_reply_settings_insert_own" on public.auto_reply_settings';
    execute 'drop policy if exists "auto_reply_settings_update_own" on public.auto_reply_settings';
    execute 'drop policy if exists "auto_reply_settings_delete_own" on public.auto_reply_settings';
    execute 'create policy "auto_reply_settings_select_own" on public.auto_reply_settings
              for select using (auth.uid() = user_id)';
    execute 'create policy "auto_reply_settings_insert_own" on public.auto_reply_settings
              for insert with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_settings_update_own" on public.auto_reply_settings
              for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_settings_delete_own" on public.auto_reply_settings
              for delete using (auth.uid() = user_id)';
  end if;
end $$;

-- ----- auto_reply_log -----
do $$
begin
  if to_regclass('public.auto_reply_log') is not null then
    execute 'alter table public.auto_reply_log enable row level security';
    execute 'drop policy if exists "auto_reply_log_select_own" on public.auto_reply_log';
    execute 'drop policy if exists "auto_reply_log_insert_own" on public.auto_reply_log';
    execute 'drop policy if exists "auto_reply_log_update_own" on public.auto_reply_log';
    execute 'drop policy if exists "auto_reply_log_delete_own" on public.auto_reply_log';
    execute 'create policy "auto_reply_log_select_own" on public.auto_reply_log
              for select using (auth.uid() = user_id)';
    -- INSERT 는 webhook(service_role) 경유가 기본이지만 클라이언트 재생성 대비 본인만 허용
    execute 'create policy "auto_reply_log_insert_own" on public.auto_reply_log
              for insert with check (auth.uid() = user_id)';
    -- UPDATE: 사용자가 rating/corrected_reply/feedback_note 작성
    execute 'create policy "auto_reply_log_update_own" on public.auto_reply_log
              for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_log_delete_own" on public.auto_reply_log
              for delete using (auth.uid() = user_id)';
  end if;
end $$;

-- ----- auto_reply_corrections -----
do $$
begin
  if to_regclass('public.auto_reply_corrections') is not null then
    execute 'alter table public.auto_reply_corrections enable row level security';
    execute 'drop policy if exists "auto_reply_corrections_select_own" on public.auto_reply_corrections';
    execute 'drop policy if exists "auto_reply_corrections_insert_own" on public.auto_reply_corrections';
    execute 'drop policy if exists "auto_reply_corrections_update_own" on public.auto_reply_corrections';
    execute 'drop policy if exists "auto_reply_corrections_delete_own" on public.auto_reply_corrections';
    execute 'create policy "auto_reply_corrections_select_own" on public.auto_reply_corrections
              for select using (auth.uid() = user_id)';
    execute 'create policy "auto_reply_corrections_insert_own" on public.auto_reply_corrections
              for insert with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_corrections_update_own" on public.auto_reply_corrections
              for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_corrections_delete_own" on public.auto_reply_corrections
              for delete using (auth.uid() = user_id)';
  end if;
end $$;

-- ----- store_context -----
do $$
begin
  if to_regclass('public.store_context') is not null then
    execute 'alter table public.store_context enable row level security';
    execute 'drop policy if exists "store_context_select_own" on public.store_context';
    execute 'drop policy if exists "store_context_insert_own" on public.store_context';
    execute 'drop policy if exists "store_context_update_own" on public.store_context';
    execute 'drop policy if exists "store_context_delete_own" on public.store_context';
    execute 'create policy "store_context_select_own" on public.store_context
              for select using (auth.uid() = user_id)';
    execute 'create policy "store_context_insert_own" on public.store_context
              for insert with check (auth.uid() = user_id)';
    execute 'create policy "store_context_update_own" on public.store_context
              for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    execute 'create policy "store_context_delete_own" on public.store_context
              for delete using (auth.uid() = user_id)';
  end if;
end $$;

-- ----- promo_schedule (user_id 컬럼이 없는 글로벌 스케줄러 테이블이면 service_role 전용으로 잠금) -----
do $$
declare
  has_user_id boolean;
begin
  if to_regclass('public.promo_schedule') is null then
    return;
  end if;
  select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='promo_schedule' and column_name='user_id'
  ) into has_user_id;

  execute 'alter table public.promo_schedule enable row level security';
  execute 'drop policy if exists "promo_schedule_select_own" on public.promo_schedule';
  execute 'drop policy if exists "promo_schedule_insert_own" on public.promo_schedule';
  execute 'drop policy if exists "promo_schedule_update_own" on public.promo_schedule';
  execute 'drop policy if exists "promo_schedule_delete_own" on public.promo_schedule';

  if has_user_id then
    execute 'create policy "promo_schedule_select_own" on public.promo_schedule
              for select using (auth.uid() = user_id)';
    execute 'create policy "promo_schedule_insert_own" on public.promo_schedule
              for insert with check (auth.uid() = user_id)';
    execute 'create policy "promo_schedule_update_own" on public.promo_schedule
              for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    execute 'create policy "promo_schedule_delete_own" on public.promo_schedule
              for delete using (auth.uid() = user_id)';
  else
    -- user_id 컬럼 부재 → 일반 사용자 전면 거부, service_role 만 허용 (정책 없음 = deny)
    null;
  end if;
end $$;

-- ----- brand_content_library (글로벌 업종 라이브러리 → 인증 사용자 read-only, 쓰기는 service_role) -----
do $$
begin
  if to_regclass('public.brand_content_library') is not null then
    execute 'alter table public.brand_content_library enable row level security';
    execute 'drop policy if exists "brand_content_library_read" on public.brand_content_library';
    execute 'create policy "brand_content_library_read" on public.brand_content_library
              for select to authenticated using (true)';
    -- INSERT/UPDATE/DELETE 정책 없음 → service_role 전용
  end if;
end $$;

-- ----- brand_weekday_schedule (글로벌 매핑 → 인증 사용자 read-only) -----
do $$
begin
  if to_regclass('public.brand_weekday_schedule') is not null then
    execute 'alter table public.brand_weekday_schedule enable row level security';
    execute 'drop policy if exists "brand_weekday_schedule_read" on public.brand_weekday_schedule';
    execute 'create policy "brand_weekday_schedule_read" on public.brand_weekday_schedule
              for select to authenticated using (true)';
  end if;
end $$;

-- ----- ig_accounts / reservations / captions 계열은 이미 20260418000001_rls_policies.sql 에서 처리됨 -----
-- (스킵) captions/scheduled_posts/subscriptions/payments 는 본 프로젝트에 독립 테이블로 존재하지 않음
-- (captions → reservations.captions jsonb + caption_history, 결제 → orders 테이블)

-- ============================================================
-- Part 3. account_deletion_log — 탈퇴 감사 로그
--   user_id 를 해시로 저장 (PII 아님), 서비스 계정(service_role)만 접근.
-- ============================================================
create table if not exists public.account_deletion_log (
  id uuid primary key default gen_random_uuid(),
  user_id_hash text not null,                       -- SHA-256 hex of deleted auth.uid()
  deleted_at timestamptz not null default now(),
  deleter_ip inet,
  retained_records text[],                          -- 예: ['payment_5y','contract_5y']
  notes text
);

create index if not exists idx_account_deletion_log_deleted_at
  on public.account_deletion_log(deleted_at desc);

alter table public.account_deletion_log enable row level security;

-- 정책 없음 = anon/authenticated 전면 거부, service_role 만 insert/select 가능
-- (혹시 과거 배포에서 남아있는 정책 제거)
drop policy if exists "account_deletion_log_read" on public.account_deletion_log;
drop policy if exists "account_deletion_log_insert" on public.account_deletion_log;

comment on table public.account_deletion_log is
  '탈퇴 감사 로그. user_id_hash=SHA-256(auth.uid()). PII 아님. service_role 전용.';

-- ============================================================
-- Part 4. auto_reply_log_safe — PII 마스킹 뷰
--   관리자 디버깅 시 원문 대신 본 뷰를 조회하도록 유도.
--   received_text / reply_text / corrected_reply 를 앞 8자 + 해시 suffix 로 마스킹.
-- ============================================================
do $$
begin
  if to_regclass('public.auto_reply_log') is not null then
    execute $v$
      create or replace view public.auto_reply_log_safe as
      select
        id,
        user_id,
        ig_user_id,
        event_type,
        case
          when received_text is null then null
          when length(received_text) <= 8 then repeat('*', length(received_text))
          else substr(received_text, 1, 8) || '…(' || length(received_text) || 'c)'
        end as received_text_masked,
        sender_id,
        category,
        sub_category,
        sentiment,
        confidence,
        replied,
        case
          when reply_text is null then null
          when length(reply_text) <= 8 then repeat('*', length(reply_text))
          else substr(reply_text, 1, 8) || '…(' || length(reply_text) || 'c)'
        end as reply_text_masked,
        escalated,
        escalation_reason,
        shadow_mode,
        rating,
        rated_at,
        created_at
      from public.auto_reply_log
    $v$;
  end if;
end $$;

comment on view public.auto_reply_log_safe is
  '관리자 디버깅용 마스킹 뷰. 원문 대신 앞 8자 + 길이만 노출. RLS 는 base table(auto_reply_log) 정책을 그대로 상속.';

-- ============================================================
-- PostgREST 스키마 리로드 (새 정책/뷰/FK 반영)
-- ============================================================
notify pgrst, 'reload schema';
