-- 신규 OAuth 가입 흐름 호환을 위해 sellers 일부 컬럼의 NOT NULL 제약 제거
-- 매장 정보는 signup-complete (onboarding) 단계에서 입력받음
-- business_number, phone은 추후 사업자 인증·알림톡 동의 시점에 채워짐

alter table public.sellers alter column business_number drop not null;
alter table public.sellers alter column owner_name drop not null;
alter table public.sellers alter column phone drop not null;

-- age_range 컬럼이 누락된 경우 추가 (이전 마이그레이션 미적용 환경 호환)
alter table public.sellers add column if not exists age_range text;
comment on column public.sellers.age_range is '카카오 OAuth 연령대 ("20~29", "30~39" 등) — 통계·맞춤 콘텐츠용';
