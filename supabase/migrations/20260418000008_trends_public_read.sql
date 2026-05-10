-- trends 공개 읽기 허용 (레거시 클라이언트 세션 호환)
drop policy if exists "trends: 인증 사용자 읽기" on public.trends;
create policy "trends: 전체 공개 읽기"
  on public.trends for select
  using (true);
