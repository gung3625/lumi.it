-- =====================================================================
-- 링크인바이오 (lumi Link-in-Bio) DB 스키마
-- ---------------------------------------------------------------------
-- 실행 방법:
--   Supabase Dashboard → SQL Editor → New Query 로 열어서 전체 붙여넣기
--   → Run. (idempotent: 재실행해도 안전하도록 IF NOT EXISTS 패턴 사용)
--
-- 이 파일은 자동 실행되지 않으며 사용자가 직접 Supabase에서 실행해야 합니다.
--
-- 포함 내용:
--   1) link_pages 테이블 (1:1 with auth.users)
--   2) link_blocks 테이블 (1:N with link_pages)
--   3) RLS 정책 (public read / authenticated self-write)
--   4) 업데이트 트리거 (updated_at 자동 갱신)
--   5) Storage bucket 'link-assets' 생성 + public read + 소유자 CRUD 정책
--   6) 데모 slug='demo' 시드 row (공개 페이지 테스트용)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) link_pages : 한 유저당 한 페이지
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.link_pages (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  slug text UNIQUE NOT NULL,
  theme text NOT NULL DEFAULT 'light' CHECK (theme IN ('light','dark')),
  profile_image_url text,
  store_name text NOT NULL DEFAULT '',
  headline text DEFAULT '',
  bio text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_pages_slug ON public.link_pages(slug);

-- ---------------------------------------------------------------------
-- 2) link_blocks : 블록 목록 (position 순 정렬)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.link_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES public.link_pages(user_id) ON DELETE CASCADE,
  block_type text NOT NULL CHECK (block_type IN (
    'header','social','link','hours','map','menu','notice','kakao','phone','delivery'
  )),
  position integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_blocks_page_position
  ON public.link_blocks(page_id, position);

-- ---------------------------------------------------------------------
-- 3) updated_at 자동 갱신 트리거
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_pages_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_link_pages_updated_at ON public.link_pages;
CREATE TRIGGER trg_link_pages_updated_at
  BEFORE UPDATE ON public.link_pages
  FOR EACH ROW EXECUTE FUNCTION public.link_pages_set_updated_at();

CREATE OR REPLACE FUNCTION public.link_blocks_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_link_blocks_updated_at ON public.link_blocks;
CREATE TRIGGER trg_link_blocks_updated_at
  BEFORE UPDATE ON public.link_blocks
  FOR EACH ROW EXECUTE FUNCTION public.link_blocks_set_updated_at();

-- ---------------------------------------------------------------------
-- 4) RLS : public read + authenticated self-write only
-- ---------------------------------------------------------------------
ALTER TABLE public.link_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.link_blocks ENABLE ROW LEVEL SECURITY;

-- 기존 정책 제거 (재실행 대비)
DROP POLICY IF EXISTS "link_pages_public_read" ON public.link_pages;
DROP POLICY IF EXISTS "link_pages_owner_insert" ON public.link_pages;
DROP POLICY IF EXISTS "link_pages_owner_update" ON public.link_pages;
DROP POLICY IF EXISTS "link_pages_owner_delete" ON public.link_pages;

DROP POLICY IF EXISTS "link_blocks_public_read" ON public.link_blocks;
DROP POLICY IF EXISTS "link_blocks_owner_insert" ON public.link_blocks;
DROP POLICY IF EXISTS "link_blocks_owner_update" ON public.link_blocks;
DROP POLICY IF EXISTS "link_blocks_owner_delete" ON public.link_blocks;

-- 공개 read (익명도 slug로 조회 가능)
CREATE POLICY "link_pages_public_read" ON public.link_pages
  FOR SELECT USING (true);

-- 본인만 insert/update/delete
CREATE POLICY "link_pages_owner_insert" ON public.link_pages
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "link_pages_owner_update" ON public.link_pages
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "link_pages_owner_delete" ON public.link_pages
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "link_blocks_public_read" ON public.link_blocks
  FOR SELECT USING (true);
CREATE POLICY "link_blocks_owner_insert" ON public.link_blocks
  FOR INSERT WITH CHECK (auth.uid() = page_id);
CREATE POLICY "link_blocks_owner_update" ON public.link_blocks
  FOR UPDATE USING (auth.uid() = page_id) WITH CHECK (auth.uid() = page_id);
CREATE POLICY "link_blocks_owner_delete" ON public.link_blocks
  FOR DELETE USING (auth.uid() = page_id);

-- ---------------------------------------------------------------------
-- 5) Storage bucket 'link-assets' (public read, 소유자 CRUD)
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('link-assets', 'link-assets', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 기존 정책 제거
DROP POLICY IF EXISTS "link_assets_public_read" ON storage.objects;
DROP POLICY IF EXISTS "link_assets_owner_insert" ON storage.objects;
DROP POLICY IF EXISTS "link_assets_owner_update" ON storage.objects;
DROP POLICY IF EXISTS "link_assets_owner_delete" ON storage.objects;

-- 공개 read
CREATE POLICY "link_assets_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'link-assets');

-- 업로드/수정/삭제: 경로 첫 세그먼트가 auth.uid()와 일치해야 함
-- 예: link-assets/{user_id}/{uuid}.jpg
CREATE POLICY "link_assets_owner_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'link-assets'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
CREATE POLICY "link_assets_owner_update" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'link-assets'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
CREATE POLICY "link_assets_owner_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'link-assets'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------
-- 6) 데모 slug='demo' 시드 (공개 페이지 테스트용)
--    user_id는 고정 UUID (00000000-0000-0000-0000-000000000000)
--    auth.users FK 제약 때문에 해당 더미 유저가 필요하므로
--    시드는 건너뛰고, 대신 link-pages 테이블에 FK 검사 우회용 옵션을 안내.
--    (운영 환경에선 실제 계정으로 /p/{slug} 를 만들어 쓰세요.)
--
--    ※ 자동 시드가 필요하면 아래 블록을 수동 uncomment하여 실행:
--    ※ 먼저 auth.users에 더미 레코드를 만들어야 FK가 통과합니다.
-- ---------------------------------------------------------------------

-- (옵션) 데모 시드: auth.users에 dummy row가 이미 있을 때만 실행하세요.
-- DO $$
-- DECLARE demo_uid uuid;
-- BEGIN
--   SELECT id INTO demo_uid FROM auth.users WHERE email = 'demo@lumi.it.kr' LIMIT 1;
--   IF demo_uid IS NOT NULL THEN
--     INSERT INTO public.link_pages (user_id, slug, theme, store_name, headline, bio, profile_image_url)
--     VALUES (demo_uid, 'demo', 'light', '루미 데모 카페', '디저트 & 스페셜티 커피',
--             '인스타 프로필 한 페이지에 매장 정보를 전부 모았어요.', null)
--     ON CONFLICT (user_id) DO UPDATE
--       SET slug='demo', store_name=EXCLUDED.store_name, headline=EXCLUDED.headline, bio=EXCLUDED.bio;
--
--     DELETE FROM public.link_blocks WHERE page_id = demo_uid;
--
--     INSERT INTO public.link_blocks (page_id, block_type, position, data) VALUES
--       (demo_uid,'header',0,'{"accent":"pink"}'::jsonb),
--       (demo_uid,'social',1,'{"items":[{"platform":"instagram","url":"https://instagram.com/lumi.it.kr"}]}'::jsonb),
--       (demo_uid,'notice',2,'{"title":"오늘 영업 안내","body":"평일 10:00-21:00, 주말 11:00-22:00"}'::jsonb),
--       (demo_uid,'hours',3,'{"schedule":[{"day":"월","open":"10:00","close":"21:00"},{"day":"화","open":"10:00","close":"21:00"},{"day":"수","open":"10:00","close":"21:00"},{"day":"목","open":"10:00","close":"21:00"},{"day":"금","open":"10:00","close":"22:00"},{"day":"토","open":"11:00","close":"22:00"},{"day":"일","open":"11:00","close":"21:00"}]}'::jsonb),
--       (demo_uid,'menu',4,'{"items":[{"name":"루미 라떼","price":"5,500원","image":""},{"name":"바닐라 빈 크림","price":"6,000원","image":""}]}'::jsonb),
--       (demo_uid,'map',5,'{"address":"서울특별시 강남구 테헤란로 123","lat":37.5,"lng":127.04}'::jsonb),
--       (demo_uid,'link',6,'{"label":"네이버 예약","subtitle":"지금 바로 자리 예약","url":"https://booking.naver.com"}'::jsonb),
--       (demo_uid,'delivery',7,'{"baemin":"https://baemin.me","yogiyo":"https://yogiyo.co.kr","coupang":"https://coupang.com"}'::jsonb),
--       (demo_uid,'kakao',8,'{"channelUrl":"https://pf.kakao.com/_xXXXX"}'::jsonb),
--       (demo_uid,'phone',9,'{"number":"02-1234-5678","label":"지금 전화하기"}'::jsonb);
--   END IF;
-- END $$;

-- 실행 후 확인:
--   SELECT * FROM public.link_pages;
--   SELECT block_type, position FROM public.link_blocks WHERE page_id='<demo_uid>' ORDER BY position;
