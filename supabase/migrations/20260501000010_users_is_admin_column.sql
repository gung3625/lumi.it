-- users 테이블에 is_admin 컬럼 추가
-- 원본: db/add_is_admin.sql
-- 관련 함수: admin-auth-check, admin-shuffle-weekday, admin-library-list,
--            admin-library-regenerate, admin-list-testers, admin-mark-invited,
--            admin-promo-publish, scheduled-promo-publisher,
--            generate-library-background

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

-- 관리자 조회 인덱스 (partial index — true인 행만 포함)
CREATE INDEX IF NOT EXISTS idx_users_is_admin
  ON public.users (is_admin) WHERE is_admin = true;

-- 초기 관리자 계정 설정 (이미 true면 멱등)
UPDATE public.users
  SET is_admin = true
  WHERE id = '47baf39a-a959-4431-9da9-0ef65a5e9465'
    AND is_admin IS DISTINCT FROM true;
