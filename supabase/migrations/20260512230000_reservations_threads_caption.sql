-- ============================================================
-- reservations.generated_threads_caption — Threads 전용 본문
-- 2026-05-12 | Threads M2.2 (HANDOFF §12-A #4)
--
-- 변경 내용:
--   1. reservations 에 generated_threads_caption (text) 컬럼 추가
--
-- 의도:
--   결정 §12-A #4 — IG 캡션은 첫 125자 + 해시태그 구조 / Threads 는 500자
--   + 대화체. process-and-post-background 가 두 캡션을 각각 생성해 저장.
--   select-and-post-background 의 Threads 게시 분기에서 이 값을 우선 사용
--   (NULL 이면 IG 캡션 fallback).
--
-- 백필: 없음. 기존 reservation 은 NULL — Threads 게시 안 트리거되므로 무영향.
-- ============================================================

BEGIN;

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS generated_threads_caption TEXT;

COMMENT ON COLUMN public.reservations.generated_threads_caption IS
  'Threads 전용 본문 — IG 캡션과 별도로 생성 (결정 §12-A #4). 300~500자 + 대화체. post_to_thread=true 일 때만 채워짐. NULL 이면 IG 캡션 fallback.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- DOWN (롤백) — 필요 시 수동 실행
-- ============================================================
-- ALTER TABLE public.reservations DROP COLUMN IF EXISTS generated_threads_caption;
