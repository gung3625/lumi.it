-- 구글 OAuth 제거 — 한국 시장 전용으로 카카오 단독 가입 방향.
-- PR #59 (UI/함수/redirect 제거) 의 후속.
--
-- 정리 대상:
--   sellers.google_id 컬럼 drop
--   sellers.signup_method='google' row 삭제 (베타 단계, 데이터 손실 무영향)
--   incomplete row(email/store_name 모두 null) 삭제
--
-- admin 권한은 사장님 카카오 계정(gung3625@kakao.com)으로 이전 (Netlify env 별도 처리).

-- 구글 가입자 row 삭제 (signup_method='google' 또는 google_id 보유)
delete from public.sellers
 where signup_method = 'google'
    or google_id is not null;

-- 옛 incomplete row (email/store_name 둘 다 null) 정리
delete from public.sellers
 where email is null and store_name is null and signup_method is null;

-- 컬럼 drop
alter table public.sellers drop column if exists google_id;
