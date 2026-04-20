-- reservations 테이블 브랜드 자동게시 플래그 + 업종 컬럼 추가.
-- daily-content-background 에서 insert 하는 행을 일반 사용자 예약과 구분하기 위함.
-- Supabase SQL Editor 에서 1회 수동 실행.

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS is_brand_auto BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS industry TEXT;

-- 브랜드 자동 예약 빠른 조회용 인덱스 (선택)
CREATE INDEX IF NOT EXISTS idx_reservations_is_brand_auto
  ON reservations (is_brand_auto)
  WHERE is_brand_auto = true;
