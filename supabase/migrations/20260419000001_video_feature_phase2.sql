-- ============================================================
-- Phase 2: 영상(릴스) 자동 게시 기능
-- 2026-04-19
--
-- 1. lumi-videos Storage 버킷 (public, 100MB, mp4/mov)
-- 2. RLS 정책 (lumi-images 패턴 동일)
-- 3. reservations 테이블 확장 (media_type, video_url 등)
-- ============================================================

-- ============================================================
-- 1. lumi-videos 버킷 생성 (idempotent)
--    file_size_limit: 100MB (IG Reels 규격)
--    allowed_mime_types: mp4, mov 2종
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lumi-videos',
  'lumi-videos',
  true,
  104857600,                                 -- 100 MiB
  array['video/mp4','video/quicktime']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================
-- 2. storage.objects 정책 (lumi-videos)
-- ============================================================

-- SELECT: 공개 (IG Graph API가 video_url을 fetch 해야 함)
drop policy if exists "lumi-videos: 공개 읽기" on storage.objects;
create policy "lumi-videos: 공개 읽기"
  on storage.objects for select
  using (bucket_id = 'lumi-videos');

-- INSERT: 인증 사용자, 업로드 경로 첫 segment가 본인 auth.uid()
drop policy if exists "lumi-videos: 본인 경로에만 업로드" on storage.objects;
create policy "lumi-videos: 본인 경로에만 업로드"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'lumi-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- UPDATE: owner만
drop policy if exists "lumi-videos: owner만 수정" on storage.objects;
create policy "lumi-videos: owner만 수정"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'lumi-videos' and owner = auth.uid())
  with check (bucket_id = 'lumi-videos' and owner = auth.uid());

-- DELETE: owner만
drop policy if exists "lumi-videos: owner만 삭제" on storage.objects;
create policy "lumi-videos: owner만 삭제"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'lumi-videos' and owner = auth.uid());

-- ============================================================
-- 3. reservations 테이블 확장
-- ============================================================
alter table public.reservations
  add column if not exists media_type text default 'IMAGE',
  add column if not exists video_url text,
  add column if not exists video_key text,
  add column if not exists frame_urls jsonb default '[]'::jsonb,
  add column if not exists subtitle_data jsonb;

-- media_type CHECK 제약 (IMAGE | REELS)
alter table public.reservations
  drop constraint if exists reservations_media_type_check;
alter table public.reservations
  add constraint reservations_media_type_check
  check (media_type in ('IMAGE', 'REELS'));
