-- ============================================================
-- 정보고시 AI 자동 생성 — DB 스키마 마이그레이션
-- 2026-04-29 | Task 3 (info-disclosure-ai.md)
--
-- 변경 내용:
--   1. products 테이블에 정보고시 관련 컬럼 4개 추가
--   2. audit_logs 테이블에 셀러 본인 조회 RLS 정책 추가
--      (테이블 신규 생성 X — 기존 audit_logs 재사용)
--
-- 멱등성: ADD COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS 사용
-- 실행: Supabase 대시보드 SQL Editor에서 사장님이 직접 실행
--   https://supabase.com/dashboard/project/cldsozdocxpvkbuxwqep/sql
-- ============================================================

-- ============================================================
-- Part 1. products 테이블 — 정보고시 컬럼 4개 추가
--
-- 기존 컬럼 (확인됨):
--   id, seller_id, title, description, price_suggested,
--   ai_confidence, image_urls, primary_image_url,
--   category_suggestions, keywords, market_overrides,
--   policy_warnings, raw_ai, status, created_at, updated_at,
--   source, migration_id
--
-- 신규 컬럼:
--   info_disclosure          JSONB    — AI 생성 정보고시 항목 초안
--                                       { key: { value, confidence, source } }
--                                       source: 'image'|'text'|'inferred'|'missing'
--   info_disclosure_confirmed BOOLEAN — 사장님 검수·승인 여부 (발행 전 필수)
--   info_disclosure_confirmed_at TIMESTAMPTZ — 사장님이 확인한 시각
--   info_disclosure_category TEXT    — 적용된 정보고시 카테고리
--                                       food/cosmetic/electric/clothing/living/kids
-- ============================================================

-- AI 생성 정보고시 항목 초안 (JSONB key-value 구조)
alter table public.products
  add column if not exists info_disclosure jsonb default null;

comment on column public.products.info_disclosure is
  'AI 생성 정보고시 초안. { key: { value, confidence, source } } 구조.'
  ' source: image|text|inferred|missing. nullable = 아직 생성 안 됨';

-- 사장님 검수·승인 여부 (false = 미검수, true = 검수 완료)
alter table public.products
  add column if not exists info_disclosure_confirmed boolean default false;

comment on column public.products.info_disclosure_confirmed is
  '사장님이 정보고시 항목을 검수·승인했는지 여부.'
  ' false(기본) = 미검수. 발행 시 true 필수 (책임 경계 명시).';

-- 사장님이 검수 완료한 시각
alter table public.products
  add column if not exists info_disclosure_confirmed_at timestamptz default null;

comment on column public.products.info_disclosure_confirmed_at is
  '사장님이 정보고시 검수 완료 버튼을 누른 시각. info_disclosure_confirmed=true 시 함께 기록.';

-- 적용된 정보고시 카테고리 (6종 Phase A)
alter table public.products
  add column if not exists info_disclosure_category text default null;

comment on column public.products.info_disclosure_category is
  '정보고시 카테고리 키. 허용값: food, cosmetic, electric, clothing, living, kids.'
  ' NULL = 카테고리 미분류 또는 해당 없음.';

-- ============================================================
-- Part 2. audit_logs 테이블 — 셀러 본인 조회 RLS 정책 추가
--
-- 기존 audit_logs 컬럼 (확인됨):
--   id, actor_id (UUID), actor_type, action,
--   resource_type, resource_id, metadata (JSONB),
--   ip_address, user_agent, created_at, integrity_hash
--
-- 매핑 (plan ↔ 기존 컬럼):
--   entity_type  → resource_type
--   entity_id    → resource_id
--   actor        → actor_type  ('ai' | 'seller')
--   payload      → metadata    (변경 내용 snapshot)
--   seller_id    → actor_id    (셀러가 actor인 경우)
--
-- 정보고시 관련 action 값 예시:
--   'info_disclosure.ai_generated'  — AI가 초안 생성
--   'info_disclosure.seller_edited' — 사장님이 값 수정
--   'info_disclosure.confirmed'     — 사장님이 검수 완료 체크
--   'info_disclosure.published'     — 마켓에 등록(발행)
--
-- RLS 현황: audit_logs 테이블에 RLS가 활성화되어 있는지 확인 필요.
--   아래 블록은 멱등성 보장 (이미 정책이 있으면 drop 후 재생성).
-- ============================================================

-- audit_logs RLS 활성화 (이미 활성화된 경우 무해)
alter table public.audit_logs enable row level security;

-- 기존 정책 제거 (재실행 안전)
drop policy if exists "audit_logs_select_own_seller" on public.audit_logs;

-- 셀러 본인 레코드 조회 정책
-- actor_id = auth.uid() : 본인이 actor인 레코드만 조회 가능
-- INSERT/UPDATE/DELETE 정책 없음 → service_role(Netlify Functions)만 기록 가능
create policy "audit_logs_select_own_seller"
  on public.audit_logs
  for select
  using (actor_id = auth.uid());

comment on table public.audit_logs is
  '시스템 감사 로그. AI 생성·사장님 수정·발행 이력 포함.'
  ' RLS: 셀러는 본인(actor_id=auth.uid()) 레코드만 조회.'
  ' INSERT/UPDATE/DELETE: service_role(Netlify Functions) 전용.';

-- ============================================================
-- PostgREST 스키마 리로드
-- ============================================================
notify pgrst, 'reload schema';

-- ============================================================
-- DOWN (롤백) — 필요 시 수동 실행
-- ============================================================
-- alter table public.products drop column if exists info_disclosure;
-- alter table public.products drop column if exists info_disclosure_confirmed;
-- alter table public.products drop column if exists info_disclosure_confirmed_at;
-- alter table public.products drop column if exists info_disclosure_category;
-- drop policy if exists "audit_logs_select_own_seller" on public.audit_logs;
