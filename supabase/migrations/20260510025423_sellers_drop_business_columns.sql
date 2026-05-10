-- 옛 멀티마켓 셀러 SaaS 잔재 정리 — 사업자 인증 컬럼 제거
-- 배경:
--   초기 스키마는 사장님 진위확인(NTS API)을 가입 단계에 포함했었으나,
--   현재 lumi 는 동네 사장님 도구로 방향이 바뀌어 사업자 인증을 받지 않음.
--   PR #43 에서 business-verify.js 등 본체 함수는 삭제됨. 본 마이그레이션은
--   남아 있는 컬럼/제약을 정리한다.
--
-- 영향:
--   sellers.business_number, business_verified, business_verified_at 컬럼 drop.
--   me.js / update-profile.js / onboarding-utils.js / seller-jwt.js 의 참조도
--   같은 PR 에서 함께 제거됨.

alter table public.sellers drop column if exists business_number;
alter table public.sellers drop column if exists business_verified;
alter table public.sellers drop column if exists business_verified_at;
