-- sellers 테이블에 age_range 컬럼 추가 (카카오 OAuth 연령대 동의항목)
-- "20~29", "30~39" 등 카카오 표준 형식

alter table public.sellers
  add column if not exists age_range text;

comment on column public.sellers.age_range is '카카오 OAuth 연령대 ("20~29", "30~39" 등) — 통계·맞춤 콘텐츠용';
