-- 튜토리얼 데모 이미지 bucket (public)
-- 사장님 결정 2026-05-17: 튜토리얼의 9장 cafe demo 사진을 gpt-image-2 로 생성해서
-- supabase storage 에 두고 lumi.it.kr/tutorial 에서 직접 참조.
-- bucket: tutorial-demo (public read, service-role write)
-- 경로: tutorial-demo/cafe-1.jpg ~ cafe-9.jpg

BEGIN;

INSERT INTO storage.buckets (id, name, public)
VALUES ('tutorial-demo', 'tutorial-demo', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- public read 정책 — anyone 이 GET 가능 (튜토리얼 페이지가 anon 으로 접근)
DROP POLICY IF EXISTS "tutorial_demo_public_read" ON storage.objects;
CREATE POLICY "tutorial_demo_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'tutorial-demo');

-- 쓰기는 service_role 만 (admin function 만 upload)
DROP POLICY IF EXISTS "tutorial_demo_service_role_write" ON storage.objects;
CREATE POLICY "tutorial_demo_service_role_write"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'tutorial-demo') WITH CHECK (bucket_id = 'tutorial-demo');

COMMIT;
