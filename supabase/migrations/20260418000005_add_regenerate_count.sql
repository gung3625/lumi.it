-- 캡션 재생성 횟수 컬럼 추가 (건당 최대 3회 제한)
-- regenerate-caption.js 에서 사용
alter table public.reservations
  add column if not exists regenerate_count int not null default 0;

comment on column public.reservations.regenerate_count is '캡션 재생성 횟수 (예약 건당 최대 3회)';
