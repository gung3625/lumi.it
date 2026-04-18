-- ============================================================
-- lumi.it Storage 버킷 + RLS 정책 (Phase 1)
-- 2026-04-18
--
-- 김현님 결정 #7: Public 버킷 + 예측 불가능한 파일명(nonce)
-- 버킷: lumi-images (public=true)
-- 경로 규칙: {user_id}/{reserve_key|timestamp}/{nonce}-{i}.jpg
-- ============================================================

-- ============================================================
-- 1. 버킷 생성 (idempotent)
--    file_size_limit: 10MB (IG 업로드 규격 내)
--    allowed_mime_types: 이미지 3종만
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lumi-images',
  'lumi-images',
  true,
  10485760,                              -- 10 MiB
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================
-- 2. storage.objects 정책 (버킷 한정)
--    SELECT: 누구나 (public 버킷이므로 CDN 경로 접근 허용)
--    INSERT: 인증 사용자만, 경로 prefix가 본인 user_id 여야 함
--    UPDATE/DELETE: owner만
-- ============================================================

-- SELECT: 공개 (이미지 URL이 예측 불가능한 nonce 포함이므로 안전)
create policy "lumi-images: 공개 읽기"
  on storage.objects for select
  using (bucket_id = 'lumi-images');

-- INSERT: 인증 사용자, 업로드 경로 첫 segment가 본인 auth.uid()
create policy "lumi-images: 본인 경로에만 업로드"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'lumi-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- UPDATE: owner만 (storage.objects.owner = auth.uid())
create policy "lumi-images: owner만 수정"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'lumi-images' and owner = auth.uid())
  with check (bucket_id = 'lumi-images' and owner = auth.uid());

-- DELETE: owner만
create policy "lumi-images: owner만 삭제"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'lumi-images' and owner = auth.uid());
