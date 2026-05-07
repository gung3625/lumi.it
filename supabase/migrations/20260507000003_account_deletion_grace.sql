-- 30일 유예 회원 탈퇴 시스템
-- 흐름: 탈퇴 요청 → deletion_requested_at = now, deletion_scheduled_at = now + 30일
--      → 30일 내 다시 로그인 시 deletion_cancelled_at = now 으로 복구
--      → 만료 cron 이 cascade DELETE (auth.users + sellers + ig/tiktok/reservations)

ALTER TABLE public.sellers
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_reminder_sent_at timestamptz;

-- 만료 후보 빠른 조회용 부분 인덱스 (cron 성능)
CREATE INDEX IF NOT EXISTS idx_sellers_deletion_pending
  ON public.sellers(deletion_scheduled_at)
  WHERE deletion_requested_at IS NOT NULL AND deletion_cancelled_at IS NULL;

COMMENT ON COLUMN public.sellers.deletion_requested_at IS '회원 탈퇴 요청 시각 (NULL 이면 정상 회원)';
COMMENT ON COLUMN public.sellers.deletion_scheduled_at IS '실제 영구 삭제 예정 시각 (요청 + 30일)';
COMMENT ON COLUMN public.sellers.deletion_cancelled_at IS '복구 처리 시각 (NOT NULL 이면 탈퇴 취소된 상태)';
COMMENT ON COLUMN public.sellers.deletion_reminder_sent_at IS '7일 전 reminder 이메일 마지막 발송 시각';
