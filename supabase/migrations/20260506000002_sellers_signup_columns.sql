-- ============================================================
-- sellers 테이블 — 새 회원가입 흐름용 컬럼 추가
-- 2026-05-06
--
-- 포함 내용:
--   1. OAuth 식별자 컬럼 (kakao_id, google_id)
--   2. 가입 완료 플래그 (onboarded)
--   3. 가입 메서드 (signup_method)
--   4. 프로필 컬럼 (display_name, avatar_url)
--   5. 업종 (industry)
--   6. 인덱스 (kakao_id, google_id, email, onboarded)
--
-- skip 컬럼 (이미 존재):
--   email, store_name, signup_completed_at, phone
--
-- 멱등성: 모든 ALTER ADD COLUMN은 IF NOT EXISTS
--         모든 CREATE INDEX는 IF NOT EXISTS
-- ============================================================

ALTER TABLE public.sellers
  ADD COLUMN IF NOT EXISTS onboarded            boolean         DEFAULT false,
  ADD COLUMN IF NOT EXISTS signup_method        text,
  ADD COLUMN IF NOT EXISTS kakao_id             text,
  ADD COLUMN IF NOT EXISTS google_id            text,
  ADD COLUMN IF NOT EXISTS display_name         text,
  ADD COLUMN IF NOT EXISTS avatar_url           text,
  ADD COLUMN IF NOT EXISTS industry             text;

COMMENT ON COLUMN public.sellers.onboarded IS '회원가입 + 매장 정보 입력 완료 시 true. auth-guard에서 체크.';
COMMENT ON COLUMN public.sellers.signup_method IS 'kakao | google — 어떤 OAuth로 가입했는지 추적';
COMMENT ON COLUMN public.sellers.kakao_id IS '카카오 user id (OAuth 식별자)';
COMMENT ON COLUMN public.sellers.google_id IS 'Google subject (sub) — OAuth 식별자';
COMMENT ON COLUMN public.sellers.display_name IS '카카오 닉네임 또는 Google 이름';
COMMENT ON COLUMN public.sellers.avatar_url IS '프로필 이미지 URL';
COMMENT ON COLUMN public.sellers.industry IS '업종';

-- ============================================================
-- 인덱스
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_sellers_kakao_id
  ON public.sellers (kakao_id)
  WHERE kakao_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sellers_google_id
  ON public.sellers (google_id)
  WHERE google_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sellers_email
  ON public.sellers (email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sellers_onboarded
  ON public.sellers (onboarded)
  WHERE onboarded = true;

-- ============================================================
-- PostgREST 스키마 리로드
-- ============================================================
notify pgrst, 'reload schema';
