-- ig_accounts.threads_username — Threads 본인 핸들 (@ 제외).
-- threads-oauth.js 가 /me?fields=id,username 응답에서 채움.
--
-- 의도:
--   Threads 답글 (reply-comment.js 채널 분기) 시 본인 답글 정확 필터.
--   현재 IG 댓글 필터는 `ig_accounts.ig_username` 으로 본인 답글 제외 중.
--   Threads 도 동일 패턴이 가능하도록 username 저장.

ALTER TABLE ig_accounts
  ADD COLUMN IF NOT EXISTS threads_username TEXT;
