-- users.plan CHECK 제약에 'free' 추가 (구독 취소 상태와 미가입 신규를 구분)
alter table public.users drop constraint if exists users_plan_check;
alter table public.users
  add constraint users_plan_check
  check (plan in ('trial','free','standard','pro'));
