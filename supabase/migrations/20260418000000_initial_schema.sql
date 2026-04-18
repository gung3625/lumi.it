-- ============================================================
-- lumi.it 초기 스키마 (Phase 1)
-- 2026-04-18 — Blobs → Supabase 마이그레이션
-- 계획서: .omc/plans/supabase-migration.md Phase 1
-- ============================================================

-- 필수 확장
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ============================================================
-- 1. users (public.users)
--    auth.users와 1:1 매핑. id = auth.users.id
-- ============================================================
create table public.users (
  id                      uuid primary key references auth.users(id) on delete cascade,
  email                   text not null unique,
  name                    text not null,
  store_name              text not null,
  phone                   text,
  birthdate               date,
  gender                  text,
  instagram_handle        text unique,                          -- '@' 제거, lowercase 저장
  store_desc              text,
  region                  text,
  sido_code               text,
  sigungu_code            text,
  store_sido              text,
  biz_category            text default 'cafe',
  caption_tone            text default 'warm',
  tag_style               text default 'mid',
  custom_captions         text[] default '{}'::text[],
  plan                    text default 'trial' check (plan in ('trial','standard','pro')),
  trial_start             timestamptz,
  auto_renew              boolean default true,
  agree_marketing         boolean default false,
  agree_marketing_at      timestamptz,
  auto_story              boolean default false,
  auto_festival           boolean default false,
  retention_unsubscribed  boolean default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index users_email_idx on public.users (email);
create index users_plan_idx on public.users (plan);
create index users_instagram_handle_idx on public.users (instagram_handle) where instagram_handle is not null;

-- updated_at 자동 갱신 트리거
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger users_set_updated_at before update on public.users
  for each row execute function public.tg_set_updated_at();

-- ============================================================
-- 2. ig_accounts — Instagram 연동
--    토큰(access_token / page_access_token)은 Supabase Vault 로 분리 저장.
--    이 테이블에는 vault.secrets(id)을 가리키는 uuid 만 보관.
--    (암호화 로직은 20260418000002_pgsodium_encryption.sql 참조)
-- ============================================================
create table public.ig_accounts (
  ig_user_id                    text primary key,               -- Instagram Graph API IG User ID
  user_id                       uuid not null references public.users(id) on delete cascade,
  ig_username                   text,
  page_id                       text,
  access_token_secret_id        uuid,                           -- vault.secrets(id)
  page_access_token_secret_id   uuid,                           -- vault.secrets(id)
  token_expires_at              timestamptz,
  connected_at                  timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);
create index ig_accounts_user_id_idx on public.ig_accounts (user_id);

create trigger ig_accounts_set_updated_at before update on public.ig_accounts
  for each row execute function public.tg_set_updated_at();

-- ============================================================
-- 3. reservations — 예약 게시물
-- ============================================================
create table public.reservations (
  id                      bigserial primary key,
  reserve_key             text not null unique,                 -- 기존 'reserve:{ts}' 포맷 유지
  user_id                 uuid not null references public.users(id) on delete cascade,
  user_message            text,
  biz_category            text,
  caption_tone            text,
  tag_style               text,
  weather                 jsonb,
  trends                  jsonb,
  store_profile           jsonb,
  post_mode               text default 'immediate' check (post_mode in ('immediate','scheduled')),
  scheduled_at            timestamptz,
  submitted_at            timestamptz not null default now(),
  story_enabled           boolean default false,
  post_to_thread          boolean default false,
  nearby_event            boolean default false,
  nearby_festivals        text,
  tone_likes              text,
  tone_dislikes           text,
  custom_captions         text,
  relay_mode              boolean default true,                 -- 레거시 호환 필드
  use_weather             boolean default true,
  is_sent                 boolean default false,
  cancelled               boolean default false,
  caption_status          text default 'pending' check (caption_status in ('pending','ready','scheduled','posting','posted','failed')),
  caption_error           text,
  generated_captions      jsonb,
  captions                jsonb,
  selected_caption_index  int,
  image_analysis          text,
  image_urls              text[],
  image_keys              text[],                               -- Storage 객체 경로
  captions_generated_at   timestamptz,
  posted_at               timestamptz,
  ig_post_id              text,
  created_at              timestamptz not null default now()
);
create index reservations_user_scheduled_idx on public.reservations (user_id, scheduled_at desc);
create index reservations_pending_idx on public.reservations (caption_status) where is_sent = false;
create index reservations_user_id_idx on public.reservations (user_id);

-- ============================================================
-- 4. orders — 결제 주문
-- ============================================================
create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users(id) on delete cascade,
  portone_payment_id  text unique,
  amount              integer not null check (amount >= 0),
  plan                text not null check (plan in ('standard','pro')),
  status              text not null check (status in ('prepared','paid','cancelled','failed','refunded')),
  raw                 jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index orders_user_created_idx on public.orders (user_id, created_at desc);
create index orders_status_idx on public.orders (status);

create trigger orders_set_updated_at before update on public.orders
  for each row execute function public.tg_set_updated_at();

-- ============================================================
-- 5. tone_feedback — 말투 학습
-- ============================================================
create table public.tone_feedback (
  id              bigserial primary key,
  user_id         uuid not null references public.users(id) on delete cascade,
  kind            text not null check (kind in ('like','dislike')),
  caption         text not null,
  reservation_id  bigint references public.reservations(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index tone_feedback_user_kind_created_idx on public.tone_feedback (user_id, kind, created_at desc);

-- ============================================================
-- 6. caption_history — 캡션 이력
-- ============================================================
create table public.caption_history (
  id            bigserial primary key,
  user_id       uuid not null references public.users(id) on delete cascade,
  caption       text not null,
  caption_type  text default 'posted' check (caption_type in ('posted','selected','saved')),
  created_at    timestamptz not null default now()
);
create index caption_history_user_created_idx on public.caption_history (user_id, created_at desc);

-- ============================================================
-- 7. linkpages — 링크인바이오
-- ============================================================
create table public.linkpages (
  user_id     uuid primary key references public.users(id) on delete cascade,
  links       jsonb not null default '[]'::jsonb,
  theme       text default 'pink',
  published   boolean default true,
  updated_at  timestamptz not null default now()
);

create trigger linkpages_set_updated_at before update on public.linkpages
  for each row execute function public.tg_set_updated_at();

-- ============================================================
-- 8. trends — 네이버 DataLab 트렌드 캐시
-- ============================================================
create table public.trends (
  category      text primary key,
  keywords      jsonb not null,
  insights      text,
  collected_at  timestamptz not null default now()
);
create index trends_collected_at_idx on public.trends (collected_at desc);

-- 캡션 뱅크 (trends와 관련된 카테고리별 문구)
create table public.caption_bank (
  id          bigserial primary key,
  category    text not null,
  caption     text not null,
  rank        int,
  created_at  timestamptz not null default now()
);
create index caption_bank_category_rank_idx on public.caption_bank (category, rank);

-- ============================================================
-- 9. beta_applicants / beta_waitlist
-- ============================================================
create table public.beta_applicants (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  store_name   text not null,
  store_type   text not null,
  phone        text not null,
  insta        text,
  referral     text,
  utm          jsonb,
  applied_at   timestamptz not null default now()
);
create index beta_applicants_applied_at_idx on public.beta_applicants (applied_at desc);

create table public.beta_waitlist (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  store_name   text not null,
  store_type   text not null,
  phone        text not null,
  insta        text,
  referral     text,
  utm          jsonb,
  applied_at   timestamptz not null default now()
);
create index beta_waitlist_applied_at_idx on public.beta_waitlist (applied_at desc);

-- ============================================================
-- 10. rate_limits — IP × action 복합 키
-- ============================================================
create table public.rate_limits (
  kind        text not null,                                    -- 'login' | 'register' | 'otp' | 'find-id' | 'beta-admin' ...
  ip          text not null,
  count       int not null default 0,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  primary key (kind, ip)
);
create index rate_limits_last_at_idx on public.rate_limits (last_at);

-- ============================================================
-- 11. oauth_nonces — IG OAuth CSRF 방지 (10분 TTL)
-- ============================================================
create table public.oauth_nonces (
  nonce       text primary key,
  user_id     uuid references public.users(id) on delete cascade,
  lumi_token  text,                                             -- 마이그레이션 기간 호환용 (향후 제거)
  created_at  timestamptz not null default now()
);
create index oauth_nonces_created_at_idx on public.oauth_nonces (created_at);

-- 코멘트 (문서화 목적)
comment on table public.users is 'Supabase auth.users와 1:1 매핑되는 앱 프로필. auth.uid()로 본인 확인';
comment on table public.ig_accounts is 'Instagram Graph API 연동. access_token, page_access_token은 pgsodium으로 암호화';
comment on table public.reservations is '예약 게시물. 캡션 생성·IG 게시 플로우 전체의 중심 테이블';
comment on table public.orders is 'PortOne 결제 주문 기록';
comment on table public.tone_feedback is '말투 학습 피드백 (좋아요/싫어요). 20개 롤링 윈도우는 앱에서 처리';
comment on table public.caption_history is '생성·게시된 캡션 이력';
comment on table public.linkpages is '/p/:handle 링크인바이오 페이지';
comment on table public.trends is '네이버 DataLab + LLM 요약 트렌드 캐시';
comment on table public.caption_bank is '카테고리별 캡션 뱅크';
comment on table public.beta_applicants is '베타 신청자 (정원 20명)';
comment on table public.beta_waitlist is '베타 마감 후 대기 명단';
comment on table public.rate_limits is 'IP 기반 rate limiting (kind, ip) 복합키';
comment on table public.oauth_nonces is 'IG OAuth CSRF nonce (10분 TTL)';
