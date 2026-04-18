-- ============================================================
-- lumi.it RLS 정책 (Phase 1)
-- 2026-04-18
-- ⚠️ 모든 public 테이블에 RLS 활성화 필수
--    anon key가 클라이언트에 노출되므로 정책 누락 시 전체 데이터 유출 위험
-- ============================================================

-- ============================================================
-- users: 본인 행만 select/update 가능, insert는 service_role만
--   (회원가입은 auth.admin.createUser + insert 둘 다 server 쪽에서)
-- ============================================================
alter table public.users enable row level security;

create policy "users: 본인 프로필 읽기"
  on public.users for select
  using (auth.uid() = id);

create policy "users: 본인 프로필 수정"
  on public.users for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- INSERT / DELETE 는 service_role (RLS 우회)만 허용
-- (명시적으로 anon/authenticated INSERT 정책을 만들지 않음 → 기본 거부)

-- ============================================================
-- ig_accounts: 본인 행 select만 허용, 쓰기는 service_role만
--   (토큰 조회는 복호화 뷰 ig_accounts_decrypted 경유, 그쪽은 service_role 전용)
-- ============================================================
alter table public.ig_accounts enable row level security;

create policy "ig_accounts: 본인 연동 정보 읽기 (토큰 제외)"
  on public.ig_accounts for select
  using (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE 는 service_role 전용 (토큰 관리 책임)

-- ============================================================
-- reservations: 본인 예약만 CRUD
-- ============================================================
alter table public.reservations enable row level security;

create policy "reservations: 본인 예약 읽기"
  on public.reservations for select
  using (auth.uid() = user_id);

create policy "reservations: 본인 예약 생성"
  on public.reservations for insert
  with check (auth.uid() = user_id);

create policy "reservations: 본인 예약 수정"
  on public.reservations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "reservations: 본인 예약 삭제"
  on public.reservations for delete
  using (auth.uid() = user_id);

-- ============================================================
-- orders: 본인 주문만 읽기, 쓰기는 결제 Function에서 service_role로
-- ============================================================
alter table public.orders enable row level security;

create policy "orders: 본인 주문 읽기"
  on public.orders for select
  using (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE 는 service_role 전용 (결제 검증 책임)

-- ============================================================
-- tone_feedback: 본인 피드백만 CRUD
-- ============================================================
alter table public.tone_feedback enable row level security;

create policy "tone_feedback: 본인 데이터 모든 작업"
  on public.tone_feedback for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- caption_history: 본인 이력만 CRUD
-- ============================================================
alter table public.caption_history enable row level security;

create policy "caption_history: 본인 이력 모든 작업"
  on public.caption_history for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- linkpages: 본인만 수정, 공개 읽기 허용 (/p/:handle)
-- ============================================================
alter table public.linkpages enable row level security;

create policy "linkpages: 공개 읽기 (/p/:handle)"
  on public.linkpages for select
  using (true);

create policy "linkpages: 본인 페이지 생성"
  on public.linkpages for insert
  with check (auth.uid() = user_id);

create policy "linkpages: 본인 페이지 수정"
  on public.linkpages for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "linkpages: 본인 페이지 삭제"
  on public.linkpages for delete
  using (auth.uid() = user_id);

-- ============================================================
-- trends: 인증 사용자 읽기 가능, 쓰기는 service_role만
-- ============================================================
alter table public.trends enable row level security;

create policy "trends: 인증 사용자 읽기"
  on public.trends for select
  to authenticated
  using (true);

-- INSERT/UPDATE/DELETE 는 service_role 전용 (스케줄러 cron)

alter table public.caption_bank enable row level security;

create policy "caption_bank: 인증 사용자 읽기"
  on public.caption_bank for select
  to authenticated
  using (true);

-- ============================================================
-- beta_applicants / beta_waitlist:
--   INSERT는 anon 허용 (비로그인 상태 베타 신청), SELECT/UPDATE/DELETE는 service_role만
-- ============================================================
alter table public.beta_applicants enable row level security;

create policy "beta_applicants: 누구나 신청 가능"
  on public.beta_applicants for insert
  to anon, authenticated
  with check (true);

-- SELECT/UPDATE/DELETE 는 service_role 전용 (관리자 대시보드 LUMI_SECRET 토큰)

alter table public.beta_waitlist enable row level security;

create policy "beta_waitlist: 누구나 대기 신청 가능"
  on public.beta_waitlist for insert
  to anon, authenticated
  with check (true);

-- SELECT/UPDATE/DELETE 는 service_role 전용

-- ============================================================
-- rate_limits: service_role만 접근 (클라이언트 직접 접근 금지)
-- ============================================================
alter table public.rate_limits enable row level security;
-- 정책 없음 → 모든 anon/authenticated 요청 거부, service_role만 허용

-- ============================================================
-- oauth_nonces: service_role만 접근 (CSRF 방지용이므로 클라이언트 노출 금지)
-- ============================================================
alter table public.oauth_nonces enable row level security;
-- 정책 없음 → service_role만 허용
