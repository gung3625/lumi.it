-- reservations.deleted_at: 사장님 본인이 history 에서 기록 삭제 시 soft delete 마킹.
-- list-reservations 가 deleted_at IS NULL 필터 자동 적용 → 화면에서 숨김.
-- tone_feedback 등 학습 데이터는 user_id 기반이라 row 가 살아있어야 보존됨.
-- IG/Threads 실제 게시물은 손대지 않음 (사장님이 인스타 앱에서 별도 처리).

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_reservations_user_not_deleted
  ON reservations(user_id, created_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN reservations.deleted_at IS
  '사장님이 history 에서 기록 삭제 시 마킹 (soft delete). list-reservations 는 NULL 만 조회. IG/Threads 실 게시물은 별도.';
