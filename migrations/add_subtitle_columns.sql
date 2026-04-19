-- ============================================================
-- Phase 2b: 자막 burn-in 결과 저장용 컬럼
-- 2026-04-19
--
-- subtitle_status: 'pending' | 'applied' | 'skipped' | 'failed'
--   - pending : 아직 처리 전(기본값 없음, nullable)
--   - applied : Modal burn-in 성공 → reservations.video_url을 새 subtitled URL로 교체 완료
--   - skipped : SRT 생성 실패 또는 Modal 호출 실패 (원본 video_url 그대로 게시)
--   - failed  : Supabase 업로드 실패 등 복구 불가 에러
-- subtitle_srt: GPT-4o-mini가 생성한 원본 SRT 텍스트 (디버깅/재처리용)
--
-- 적용:
--   supabase db push  (또는 SQL 에디터에서 직접 실행)
-- ============================================================

alter table public.reservations
  add column if not exists subtitle_status text,
  add column if not exists subtitle_srt text;

-- 상태 값 제약 (nullable 허용)
alter table public.reservations
  drop constraint if exists reservations_subtitle_status_check;
alter table public.reservations
  add constraint reservations_subtitle_status_check
  check (subtitle_status is null or subtitle_status in ('pending','applied','skipped','failed'));
