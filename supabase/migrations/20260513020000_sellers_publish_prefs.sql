-- sellers.publish_prefs: register-product 토글 마지막 상태 영속화 (UX)
-- key: storyEnabled, weatherEnabled, threadsEnabled (Boolean)
-- 첫 사용자는 {} → 코드 디폴트 (story/threads OFF, weather ON) 유지.
-- JSONB 로 두는 이유: 향후 토글 추가 시 마이그레이션 불필요.

ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS publish_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN sellers.publish_prefs IS
  'register-product 자동 게시 토글 마지막 상태 (storyEnabled/weatherEnabled/threadsEnabled). reserve.js 가 게시 submit 시 함께 update.';
