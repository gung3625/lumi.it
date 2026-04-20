-- users 테이블에 is_admin 컬럼 추가.
-- admin-auth-check.js 에서 관리자 여부 조회.
-- Supabase SQL Editor 에서 1회 수동 실행.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

UPDATE users SET is_admin = true
WHERE id = '47baf39a-a959-4431-9da9-0ef65a5e9465';

CREATE INDEX IF NOT EXISTS idx_users_is_admin
  ON users (is_admin) WHERE is_admin = true;
