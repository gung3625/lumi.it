-- 옛 멀티마켓·dormant 기능 잔재 테이블 일괄 정리
--
-- 정리 대상 (코드베이스 grep 검증, 사용처 0):
--   audit_logs          — _shared/audit-log.js / onboarding-utils.recordAudit 폐지에 따른 dead
--   orders              — 옛 멀티마켓 주문 (현재 lumi 는 주문 처리 안 함)
--   linkpages           — 옛 링크 페이지 기능 (현재 미사용)
--   beta_waitlist       — 옛 베타 대기열 (현재 미사용)
--   beta_applicants     — 옛 베타 신청자 (현재 미사용)
--
-- 베타 단계 + 사장님 본인 확인: 데이터 손실 우려 없음.
-- 코드 측 정리는 같은 PR 에서 동반.

drop table if exists public.audit_logs cascade;
drop table if exists public.orders cascade;
drop table if exists public.linkpages cascade;
drop table if exists public.beta_waitlist cascade;
drop table if exists public.beta_applicants cascade;
