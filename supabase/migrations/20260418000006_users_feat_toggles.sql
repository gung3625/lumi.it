-- ============================================================
-- users.feat_toggles 컬럼 추가
-- 2026-04-18 — 프론트 index.html L4010 update-profile DIRECT 교체 준비.
-- 기존 Blobs user.featToggles 객체 → users.feat_toggles(jsonb) 으로 이전.
-- ============================================================

alter table public.users
  add column if not exists feat_toggles jsonb not null default '{}'::jsonb;

comment on column public.users.feat_toggles is
  '프론트 UI 기능 토글(jsonb). 예: { autoStory:true, autoFestival:false }. 앱에서 read/write.';
