# lumi.it Netlify Blobs → Supabase 마이그레이션 계획

**작성일:** 2026-04-18
**대상 리포지토리:** `/Users/kimhyun/lumi.it`
**결과물:** Supabase 단일 백엔드 (Auth + PostgreSQL + Storage) 전환
**총 예상 공수:** 12 ~ 16 영업일 (1인 기준, 집중 투입 시)

---

## 목차

1. [배경 & 원칙](#배경--원칙)
2. [Phase 0 — 인벤토리 (실스캔 결과)](#phase-0--인벤토리-실스캔-결과)
3. [Phase 1 — DB 스키마 설계](#phase-1--db-스키마-설계)
4. [Phase 2 — Supabase 프로젝트 셋업](#phase-2--supabase-프로젝트-셋업)
5. [Phase 3 — 데이터 마이그레이션 스크립트](#phase-3--데이터-마이그레이션-스크립트)
6. [Phase 4 — Functions 재작성](#phase-4--functions-재작성)
7. [Phase 5 — 프론트엔드 전환](#phase-5--프론트엔드-전환)
8. [Phase 6 — 테스트 & 배포](#phase-6--테스트--배포)
9. [Phase 7 — 정리 & 회수](#phase-7--정리--회수)
10. [리스크 매트릭스](#리스크-매트릭스)
11. [오픈 이슈](#오픈-이슈)

---

## 배경 & 원칙

### 왜 전환하나
- Netlify Blobs의 자동 컨텍스트(`getStore({ name })`만)는 서버리스 런타임에서 `environment not configured` 에러로 실패 확정 (2번 실험 완료) → siteID/token 명시 필수
- siteID + PAT 명시 = PAT rate limit(100/min, 동시성 burst에 취약) 유발 → 간헐적 401 → 로그아웃/예약 실패/IG 토큰 조회 실패 반복
- 지수 백오프 재시도(총 6.2s)는 증상 완화일 뿐 근본 해결 아님. 결제·게시 같은 타임센시티브 경로에서 UX 붕괴
- 관계형 데이터(users/reservations/orders)와 인덱스가 필요한 쿼리(`user-index:`, `insta:`)가 점점 늘어남 → KV로 커버하기 어려움

### 전환 대상
- **백엔드 저장소** — Netlify Blobs → Supabase Postgres
- **인증 발급/검증** — 자체 PBKDF2 + 랜덤 토큰 → Supabase Auth (이메일 + JWT)
- **이미지 저장** — `temp-images`, `last-post-images` Blobs → Supabase Storage
- **이미지 serving** — `serve-image.js` / `/ig-img/*` → Supabase Storage public/signed URL

### 유지 대상 (바꾸지 않음)
- Netlify Functions 런타임 자체는 유지 (배포·스케줄러·비용·CDN 이미 안정화)
- Netlify Scheduled Functions (`scheduled-trends`, `send-daily-schedule`, `check-expiry`, `send-notifications`, `scheduler`) 및 cron 설정
- 기존 HTML/JS 로그인·회원가입 **UI 디자인 그대로 유지** (백엔드만 Supabase로)
- 외부 API 연동 (PortOne 결제, 솔라피 알림톡, Resend 이메일, Meta Graph, OpenAI)

### 전환 원칙
- **점진적 교체**: 함수 단위로 순차 배포, 한 번에 다 바꾸지 않음 (롤백 용이)
- **무손실**: Blobs 원본은 `.archive-blobs` 접두사/별도 스토어로 보관 (최소 2주 유지)
- **인증 호환 구간**: 기존 PBKDF2 해시는 Supabase Auth로 바로 못 넣음 → 최초 로그인 시 "재설정 유도" + 병행 기간 두어 매끄럽게
- **베타 상태 활용**: 고객 0명·Meta 심사 중 → 가장 안전한 타이밍. 단, 베타 신청자 20명 명단은 반드시 보존

---

## Phase 0 — 인벤토리 (실스캔 결과)

### 0-1. Blobs 스토어 목록 (총 8개)

| 스토어 이름 | 용도 | 키 구조 | 주요 사용 함수 |
|---|---|---|---|
| `users` | 유저 프로필 + 세션 토큰 + IG 연동 + 말투학습 | `user:{email}`, `token:{random}`, `insta:{igId}`, `email-ig:{email}`, `ig:{igUserId}`, `tone-like:{email}`, `tone-dislike:{email}`, `caption-history:{email}`, `linkpage:{email}` | register, login, reserve, payment-confirm, update-profile, ig-oauth, serve-image, 전 handler |
| `reservations` | 예약·게시 대상 레코드 | `reserve:{timestamp}`, `user-index:{email}` (→ reserveKey 배열) | reserve, select-caption, scheduler, process-and-post-background, select-and-post-background, last-post, relay-list, admin-reservations |
| `orders` | 결제 주문 | (결제 paymentId 기반) | payment-prepare, payment-confirm |
| `rate-limit` | IP 기반 rate limiting | `login:{ip}`, `register:{ip}`, `find-id:{ip}`, `otp:{ip}` | login, register, find-id, send-otp, verify-otp, beta-admin |
| `oauth-nonce` | Meta OAuth CSRF nonce (10분 TTL) | `nonce:{random}` | ig-oauth |
| `trends` | 트렌드 키워드 + 캡션뱅크 | 카테고리별 키워드 캐시, `caption-bank:{bizCategory}` | get-trends, update-trends, scheduled-trends, regenerate-caption, process-and-post-background |
| `beta-applicants` | 베타 신청 명단 (정원 20) | `applicant_{timestamp}` | beta-apply, beta-admin |
| `beta-waitlist` | 마감 후 대기 명단 | `waitlist_{timestamp}` | beta-apply |
| `temp-images` | IG 게시용 임시 이미지 (base64 JPEG) | `temp-img:{reserveKey}:{i}` | reserve, process-and-post-background, serve-image, select-and-post-background |
| `last-post-images` | 최근 게시 이미지 사용자별 저장 | `last-post:{email}:{i}` | last-post, serve-image |

> 실질적으로 `users` 스토어가 5개 도메인(유저·세션·IG·말투·링크페이지)을 혼재시키고 있음 → Postgres로 옮기며 자연스럽게 5개 이상의 테이블로 분해

### 0-2. Netlify Functions 목록 (총 61개 + 3 CLAUDE.md/AGENTS.md)

**인증 (6)**
- `register.js` — 가입 + 웰컴 메일/알림톡
- `login.js` — 로그인 + 토큰 발급 (PBKDF2 600k/10k 호환)
- `find-id.js` — 이메일 찾기
- `send-otp.js`, `verify-otp.js` — 비밀번호 재설정 OTP
- `reset-password.js` — 비밀번호 재설정

**프로필/설정 (4)**
- `update-profile.js` — 프로필 필드 업데이트
- `check-plan.js` — 플랜/쿼터 확인
- `unsubscribe-retention.js` — 리텐션 이메일 구독 해제
- `disconnect-ig.js` — IG 연동 해제

**예약/게시 (12)**
- `reserve.js` — 예약 생성 (사진 base64 포함)
- `save-reservation.js` — 예약 저장 (별도 경로)
- `get-reservation.js` — 예약 조회 (폴링)
- `cancel-reservation.js` — 예약 취소
- `select-caption.js` — 캡션 선택 확정
- `edit-caption.js` — 캡션 수정
- `regenerate-caption.js` — 캡션 재생성 (쿼터 감소)
- `scheduler.js` — 1분 cron (예약 발송 트리거)
- `process-and-post-background.js` — 캡션 생성 + (사전) IG 게시
- `select-and-post-background.js` — 선택된 캡션 IG 게시
- `relay-list.js` — 릴레이 목록 (현재 폐지된 기능이나 파일 존재)
- `admin-reservations.js` — 운영자 예약 대시보드

**이미지 (1)**
- `serve-image.js` — `/ig-img/*` Netlify rewrite 대상, Blobs 이미지 바이트 서빙

**말투/캡션 부가 (4)**
- `save-caption.js` — 캡션 이력 저장
- `get-caption-history.js` — 캡션 이력 조회
- `tone-feedback.js` — 좋아요/싫어요 라벨링
- `welcome-caption.js`, `demo-caption.js` — 첫 사용자/체험용 캡션

**결제 (3)**
- `payment-prepare.js` — PortOne 주문 사전 등록
- `payment-confirm.js` — 결제 확정 (플랜 변경)
- `cancel-subscription.js` — 구독 해지
- `check-expiry.js` — cron, 만료 임박 알림

**IG 연동 (4)**
- `ig-oauth.js` — Facebook Login + IG Business 연결
- `save-ig-token.js` — 수동 토큰 저장
- `meta-webhook.js` — DM/댓글 웹훅
- `save-auto-reply.js` — 자동 응답 저장

**트렌드 (3)**
- `scheduled-trends.js` — 일 1회 cron, 트렌드 수집
- `get-trends.js`, `update-trends.js` — 트렌드 캐시 read/write

**기타 (14)**
- `get-weather-kma.js`, `get-air-quality.js`, `get-festival.js` — 외부 API 프록시 (Blobs 미사용)
- `get-best-time.js`, `get-calendar.js`, `generate-calendar.js` — 캘린더
- `count-post.js` — 포스트 개수
- `last-post.js` — 최근 게시
- `feedback.js` — 피드백 수집
- `send-kakao.js` — 솔라피 알림톡 전송
- `send-daily-schedule.js` — 일 1회 아침 알림톡
- `send-notifications.js` — 일 1회 종합 알림 cron
- `beta-apply.js` — 베타 신청
- `beta-admin.js` — 베타 운영자 CRUD
- `get-link-page.js`, `update-link-page.js` — `/p/:id` 공개 페이지
- `migrate-user-index.js` — 기존 reservations → user-index 역인덱스 빌더 (일회성)
- `diag-blobs.js` — Blobs 진단용

### 0-3. 프론트엔드 접점

**페이지 파일**
`index.html`, `settings.html`, `subscribe.html`, `support.html`, `privacy.html`, `terms.html`, `guide.html`, `ig-guide.html`, `feature-time.html`, `office/index.html`, (`dashboard.html`은 현재 존재하지 않음 — `netlify.toml` 라우팅만 있음)

**호출하는 `/api/*` 엔드포인트 (25종)**
`/api/register`, `/api/login`, `/api/find-id`, `/api/send-otp`, `/api/verify-otp`, `/api/reset-password`, `/api/update-profile`, `/api/disconnect-ig`, `/api/check-plan`, `/api/reserve`, `/api/get-reservation`, `/api/cancel-reservation`, `/api/regenerate-caption`, `/api/select-caption`, `/api/payment-prepare`, `/api/payment-confirm`, `/api/cancel-subscription`, `/api/beta-apply`, `/api/last-post`, `/api/get-caption-history`, `/api/tone-feedback`, `/api/get-trends`, `/api/get-weather-kma`, `/api/get-air-quality`, `/api/get-festival`

**localStorage 키 (세션/유저)**
- `lumi_token` — 32바이트 hex 랜덤 (현 자체 토큰)
- `lumi_user` — 유저 객체 JSON (이메일, 이름, 스토어명, 플랜 등)
- `lumi_settings`, `lumi_dark_mode`, `lumi_feat_toggles`, `lumi_trend_cache`, `lumi_ig_guide` — UI 상태 (전환 무관, 유지)

**로그인/회원가입 코드 위치**
- 회원가입: `index.html:4651` (`fetch('/api/register')`), 성공 후 `index.html:4656-4657`에 `lumi_token`/`lumi_user` 저장
- 로그인: `index.html:4824` (`fetch('/api/login')`), 성공 후 `index.html:4829-4830`에 저장
- 비번재설정: `index.html:4907, 4929, 4956` (`send-otp` → `verify-otp` → `reset-password`)
- 세션 검사: `index.html:1718, 1751, 1831, 2013, 2096, 2124, 2218, 2303, 2779, 2800, 2962, 3238, 3444, 3735, 3747, 3810` 등 `localStorage.getItem('lumi_token')` 체크

---

## Phase 1 — DB 스키마 설계

> **전제**: Supabase = Postgres + Auth + Storage + RLS. 유저 id는 `auth.users.id` (UUID). 앱 테이블은 `public.*`.

### 1-1. 테이블 매핑 요약

| Blobs 키 | Postgres 테이블 | PK |
|---|---|---|
| `user:{email}` | `public.profiles` (auth.users 1:1) | `id uuid` = auth.users.id |
| `token:{random}` | **삭제** — Supabase Auth JWT가 대체 | - |
| `insta:{igId}` / `email-ig:{email}` | `public.profiles.instagram_handle` 컬럼 + UNIQUE 인덱스 | - |
| `ig:{igUserId}` | `public.ig_accounts` | `ig_user_id text` |
| `tone-like:{email}` / `tone-dislike:{email}` | `public.tone_feedback` | `(user_id, kind, created_at)` |
| `caption-history:{email}` | `public.caption_history` | `id bigserial` |
| `linkpage:{email}` | `public.link_pages` | `user_id uuid` (1:1) |
| `reserve:{timestamp}` | `public.reservations` | `id bigserial` + `reserve_key text UNIQUE` |
| `user-index:{email}` | **삭제** — `reservations.user_id` 인덱스로 대체 | - |
| `orders:{*}` | `public.orders` | `id uuid` |
| `rate-limit:{kind}:{ip}` | `public.rate_limits` (혹은 Supabase Edge의 `ratelimit` 유틸 권장) | `(kind, ip)` |
| `nonce:{r}` | `public.oauth_nonces` (10분 TTL) | `nonce text` |
| `caption-bank:{category}` | `public.caption_bank` | `(category, rank)` |
| 트렌드 카테고리별 캐시 | `public.trend_cache` | `(category, collected_at)` |
| `applicant_{ts}` | `public.beta_applicants` | `id uuid` |
| `waitlist_{ts}` | `public.beta_waitlist` | `id uuid` |
| `temp-img:{reserveKey}:{i}` | Supabase Storage `temp-images` 버킷 (DB 아님) | - |
| `last-post:{email}:{i}` | Supabase Storage `last-post-images` 버킷 | - |

### 1-2. 핵심 테이블 DDL 초안

```sql
-- 유저 프로필 (auth.users 확장)
create table public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  email              text not null,
  name               text not null,
  store_name         text not null,
  phone              text,
  birthdate          date,
  gender             text,
  instagram_handle   text unique,        -- '@' 제거, lowercase 저장
  store_desc         text,
  region             text,
  sido_code          text,
  sigungu_code       text,
  store_sido         text,
  biz_category       text default 'cafe',
  caption_tone       text default 'warm',
  tag_style          text default 'mid',
  custom_captions    text[] default '{}',
  plan               text default 'trial',       -- trial/standard/pro
  trial_start        timestamptz,
  auto_renew         boolean default true,
  agree_marketing    boolean default false,
  agree_marketing_at timestamptz,
  auto_story         boolean default false,
  auto_festival      boolean default false,
  retention_unsubscribed boolean default false,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create index on public.profiles (email);
create index on public.profiles (plan);

-- Instagram 연동
create table public.ig_accounts (
  ig_user_id           text primary key,
  user_id              uuid not null references public.profiles(id) on delete cascade,
  access_token         text not null,      -- 암호화 권장 (pgsodium / Vault)
  page_access_token    text,
  connected_at         timestamptz default now(),
  updated_at           timestamptz default now()
);
create index on public.ig_accounts (user_id);

-- 예약/게시
create table public.reservations (
  id                   bigserial primary key,
  reserve_key          text not null unique,   -- 기존 'reserve:{ts}' 그대로 보존 (로그/알림과 상호참조 용이)
  user_id              uuid not null references public.profiles(id) on delete cascade,
  user_message         text,
  biz_category         text,
  caption_tone         text,
  tag_style            text,
  weather              jsonb,
  trends               jsonb,
  store_profile        jsonb,
  post_mode            text default 'immediate',
  scheduled_at         timestamptz,
  submitted_at         timestamptz default now(),
  story_enabled        boolean default false,
  post_to_thread       boolean default false,
  nearby_event         boolean default false,
  nearby_festivals     text,
  tone_likes           text,
  tone_dislikes        text,
  custom_captions      text,
  relay_mode           boolean default true,    -- 레거시 필드 (폐지된 기능이지만 호환)
  use_weather          boolean default true,
  is_sent              boolean default false,
  cancelled            boolean default false,
  caption_status       text default 'pending',  -- pending/ready/scheduled/posting/posted/failed
  caption_error        text,
  generated_captions   jsonb,
  captions             jsonb,
  selected_caption_index int,
  image_analysis       text,
  image_urls           text[],
  image_keys           text[],                  -- Storage 객체 경로
  captions_generated_at timestamptz,
  posted_at            timestamptz,
  ig_post_id           text,
  created_at           timestamptz default now()
);
create index on public.reservations (user_id, scheduled_at desc);
create index on public.reservations (caption_status) where is_sent = false;

-- 말투 학습 피드백
create table public.tone_feedback (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('like','dislike')),
  caption     text not null,
  reservation_id bigint references public.reservations(id) on delete set null,
  created_at  timestamptz default now()
);
create index on public.tone_feedback (user_id, kind, created_at desc);

-- 캡션 이력
create table public.caption_history (
  id           bigserial primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  caption      text not null,
  caption_type text default 'posted',  -- posted/selected/saved
  created_at   timestamptz default now()
);
create index on public.caption_history (user_id, created_at desc);

-- 링크 페이지 (/p/:instagram_handle)
create table public.link_pages (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  links       jsonb default '[]'::jsonb,
  theme       text default 'pink',
  updated_at  timestamptz default now()
);

-- 주문
create table public.orders (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  portone_payment_id text,
  amount          integer not null,
  plan            text not null,
  status          text not null,  -- prepared/paid/cancelled/failed
  raw             jsonb,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index on public.orders (user_id, created_at desc);

-- 트렌드 캐시
create table public.trend_cache (
  category    text not null,
  keywords    jsonb not null,
  insights    text,
  collected_at timestamptz default now(),
  primary key (category)
);
create table public.caption_bank (
  id          bigserial primary key,
  category    text not null,
  caption     text not null,
  rank        int,
  created_at  timestamptz default now()
);
create index on public.caption_bank (category, rank);

-- 베타 신청
create table public.beta_applicants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  store_name  text not null,
  store_type  text not null,
  phone       text not null,
  insta       text,
  referral    text,
  utm         jsonb,
  applied_at  timestamptz default now()
);
create table public.beta_waitlist (like public.beta_applicants including all);

-- OAuth nonce (10분 TTL — pg_cron으로 정리)
create table public.oauth_nonces (
  nonce       text primary key,
  lumi_token  text,                 -- 마이그레이션 후에는 user_id uuid로 치환 가능
  created_at  timestamptz default now()
);

-- Rate limit (선택. Supabase Edge Function이라면 Upstash Redis 권장)
create table public.rate_limits (
  kind        text not null,       -- 'login' | 'register' | 'otp' | ...
  ip          text not null,
  count       int default 0,
  first_at    timestamptz default now(),
  primary key (kind, ip)
);
```

### 1-3. Row Level Security 정책

**원칙**
- Service Role 키를 쓰는 Netlify Functions는 RLS 우회 — 보안은 Function 내부에서 `auth.uid()` 체크
- 프론트엔드에서 anon 키로 직접 Supabase 접근하는 경우를 대비해 **모든 테이블 RLS 기본 ON**

**예시 정책**
```sql
alter table public.profiles enable row level security;
create policy "own profile read"   on public.profiles for select using (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id);
-- 가입은 Service Role로 처리 (가입 전 auth.uid() 없음)

alter table public.reservations enable row level security;
create policy "own reservations"   on public.reservations for select using (auth.uid() = user_id);
create policy "insert own"         on public.reservations for insert with check (auth.uid() = user_id);
create policy "update own"         on public.reservations for update using (auth.uid() = user_id);

alter table public.ig_accounts enable row level security;
create policy "own ig only"        on public.ig_accounts for select using (auth.uid() = user_id);
-- ig_accounts는 외부 노출 금지 → client SELECT 금지 정책이 기본, Service Role로만 조작

alter table public.link_pages enable row level security;
create policy "public link pages read" on public.link_pages for select using (true); -- /p/:id 공개
create policy "own link pages write"   on public.link_pages for all using (auth.uid() = user_id);

alter table public.tone_feedback enable row level security;
create policy "own tone feedback" on public.tone_feedback for all using (auth.uid() = user_id);

alter table public.caption_history enable row level security;
create policy "own caption history" on public.caption_history for all using (auth.uid() = user_id);

alter table public.orders enable row level security;
create policy "own orders read" on public.orders for select using (auth.uid() = user_id);
-- 결제 완료 update는 Service Role

alter table public.beta_applicants enable row level security;
-- 모두 Service Role로만 R/W (공개 SELECT/INSERT 모두 금지)
```

### 1-4. Storage 버킷 설계

- `temp-images` (private) — 게시 직전 업로드, 게시 완료 시 삭제. signed URL 1시간.
  경로: `{user_id}/{reserve_key}/{i}.jpg`
- `last-post-images` (private) — 마지막 게시 이미지 백업. signed URL 1시간.
  경로: `{user_id}/{timestamp}-{i}.jpg`
- Instagram Graph API는 **public URL을 요구** → 공개 버킷 or `getPublicUrl()` + 단명 signed URL
  - 권장: `temp-images` 버킷을 **public read + path에 랜덤 nonce**로 설정 (추측 불가). 24시간 CDN 캐시.
  - 대안: Netlify Function에서 Storage `createSignedUrl`로 1시간 URL 발급 → IG API에 전달. IG는 다운로드 완료 시까지 URL 유효성 확보되면 됨.

---

## Phase 2 — Supabase 프로젝트 셋업

### 체크리스트

- [ ] Supabase 프로젝트 생성 (region: `ap-northeast-2` 서울 권장 — Netlify KR edge와 지연 최소)
- [ ] `package.json`에 `@supabase/supabase-js@^2` 추가 (SSR 모드 아니므로 `@supabase/ssr`는 불필요 — Netlify Functions는 Node 핸들러)
- [ ] Netlify env 추가
  - `SUPABASE_URL` (공개)
  - `SUPABASE_ANON_KEY` (공개, 프론트에서도 사용 가능)
  - `SUPABASE_SERVICE_ROLE_KEY` (서버 전용, **프론트 번들 금지**)
- [ ] 위 DDL 순서 적용
  1. `profiles` (auth.users 트리거로 자동 생성할지, 가입 Function에서 명시 삽입할지 결정 — 본 계획은 **Function 명시 삽입** 택)
  2. 나머지 앱 테이블
  3. RLS 정책 (테이블 생성 후 한 번에)
  4. `oauth_nonces`, `rate_limits` TTL 정리용 `pg_cron`
- [ ] Storage 버킷 2개 생성 + CORS + 파일 크기 제한 (10MB) + MIME 화이트리스트
- [ ] `gen_random_uuid()` 확장 확인 (`create extension if not exists pgcrypto;`)
- [ ] Auth 이메일 템플릿 한국어로 커스터마이즈 (비밀번호 재설정, 이메일 확인)
  - 또는 확인 이메일 비활성 → 현 플로우(OTP via 솔라피 or Resend)와 충돌 방지
- [ ] Auth 설정: Site URL = `https://lumi.it.kr`, Redirect URLs 추가
- [ ] (선택) `pgsodium` 또는 Supabase Vault로 `ig_accounts.access_token` 암호화

---

## Phase 3 — 데이터 마이그레이션 스크립트

### 3-1. 전체 전략

- 일회용 Node 스크립트 `scripts/migrate-blobs-to-supabase.js` 작성
- 실행 방식: 로컬에서 `.env` 로드 → NETLIFY_SITE_ID/NETLIFY_TOKEN + SUPABASE_SERVICE_ROLE_KEY 동시 소유 상태에서 실행
- Phase별 분리: (1) users (2) reservations (3) orders (4) trends/caption-bank (5) beta (6) tone/caption-history/link-pages (7) ig-accounts
- **무손실 검증**: 각 Phase 종료 후 `{blobs.list.length}` vs `SELECT count(*)` 비교, 랜덤 샘플 10건 JSON diff
- **원본 보존**: Blobs 삭제 금지. 대신 옮겼다는 메타 컬럼 `migrated_from_blob_key text` 저장 (추적용)

### 3-2. 인증(유저) 마이그레이션 — 가장 어려운 부분

PBKDF2 해시는 Supabase Auth에 직접 넣을 수 없음. 3가지 옵션:

**Option A — 이메일 매직링크 강제 재설정 (권장)**
- 스크립트: `auth.admin.createUser({ email, email_confirm: true, user_metadata: ... })` — 비밀번호 없이 생성
- 모든 유저에게 "비밀번호 재설정 링크" 발송 (Resend + 템플릿)
- 첫 로그인 시 신규 비밀번호 설정 유도
- **장점**: Supabase Auth 표준, 보안 최상 / **단점**: 유저 액션 필요 (단, **현재 베타 + 고객 0명** → 비용 거의 없음)

**Option B — Admin API로 임의 비밀번호 설정 + "비밀번호 만료됨" 플래그**
- 랜덤 비밀번호 생성 → `auth.admin.updateUserById`로 설정
- `profiles.must_reset_password = true` 플래그
- 로그인 시도 → 플래그 true면 로그인 차단 + "재설정" 화면

**Option C — 2중 인증 Proxy Function (가장 복잡)**
- 커스텀 `login-legacy` Function 유지 (PBKDF2 검증) → 성공 시 Supabase Admin API로 비밀번호 업데이트 + Supabase 세션 발급
- **장점**: 유저 무단절 / **단점**: 복잡도 폭발, 보안 감사 난이도 ↑

**결정**: 고객 0명 시점이므로 **Option A 채택**. 베타 신청자/테스트 계정 ≤ 20명.

### 3-3. 의사코드 예시

```js
// scripts/migrate-blobs-to-supabase.js
const { getStore } = require('@netlify/blobs');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function migrateUsers() {
  const store = getStore({ name: 'users', siteID: ..., token: ... });
  const { blobs } = await store.list({ prefix: 'user:' });
  let ok = 0, fail = 0;
  for (const b of blobs) {
    const raw = await store.get(b.key);
    const u = JSON.parse(raw);
    // 1. auth.users 생성 (비번 없음)
    const { data: authUser, error: e1 } = await sb.auth.admin.createUser({
      email: u.email, email_confirm: true,
      user_metadata: { name: u.name, store_name: u.storeName }
    });
    if (e1) { fail++; continue; }
    // 2. profiles insert
    const { error: e2 } = await sb.from('profiles').insert({
      id: authUser.user.id,
      email: u.email,
      name: u.name, store_name: u.storeName,
      phone: u.phone, birthdate: u.birthdate, gender: u.gender,
      instagram_handle: (u.instagram || '').replace('@','').toLowerCase() || null,
      store_desc: u.storeDesc, region: u.region,
      sido_code: u.sidoCode, sigungu_code: u.sigunguCode, store_sido: u.storeSido,
      biz_category: u.bizCategory, caption_tone: u.captionTone, tag_style: u.tagStyle,
      custom_captions: u.customCaptions || [],
      plan: u.plan, trial_start: u.trialStart, auto_renew: u.autoRenew,
      agree_marketing: u.agreeMarketing, agree_marketing_at: u.agreeMarketingAt,
      auto_story: u.autoStory, auto_festival: u.autoFestival,
      retention_unsubscribed: u.retentionUnsubscribed,
      created_at: u.createdAt
    });
    if (e2) { fail++; continue; }
    ok++;
  }
  console.log(`[users] ok=${ok} fail=${fail}`);
  // 검증: count 비교
  const { count } = await sb.from('profiles').select('*', { count: 'exact', head: true });
  console.log(`[verify] blobs=${blobs.length} db=${count}`);
}

// ... migrateReservations / migrateOrders / migrateTrends / migrateBeta / migrateTone / migrateImages(storage upload) ...
```

### 3-4. 이미지 마이그레이션

- `temp-images` Blobs의 이미지는 대부분 TTL 목적 → 마이그레이션 불필요 (현재 대기 중인 활성 예약의 이미지만 옮김)
- `last-post-images` Blobs → Supabase Storage `last-post-images` 버킷
- 스크립트: `store.get(key, { type: 'arrayBuffer' })` → `sb.storage.from('last-post-images').upload(newPath, buffer)`
- DB `reservations.image_keys` 컬럼을 새 경로로 업데이트

### 3-5. 원본 보존 / 롤백 전략

- Blobs 삭제 금지 (Phase 7까지)
- 스크립트 말미에 아카이브 메타 저장:
  ```
  Blobs 원본: {store: users, count: 17, archivedAt: 2026-04-22}
  Supabase 이전: {table: profiles, count: 17, verifiedAt: 2026-04-22}
  ```
- 문제 발생 시: 배포 rollback + 환경변수 `USE_SUPABASE=0` 플래그로 런타임 스위치

---

## Phase 4 — Functions 재작성

### 4-1. 공통 유틸

`netlify/functions/_lib/supabase.js` 신규 (Functions 번들에 포함)
```js
const { createClient } = require('@supabase/supabase-js');
function adminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}
function userClientFromToken(accessToken) {
  // JWT를 검증 및 auth.uid() 컨텍스트 확보
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: 'Bearer ' + accessToken } }
  });
  return c;
}
async function requireUser(event) {
  const auth = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (!auth) throw { status: 401, msg: '인증 필요' };
  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(auth);
  if (error || !data?.user) throw { status: 401, msg: '유효하지 않은 토큰' };
  return { user: data.user, accessToken: auth };
}
module.exports = { adminClient, userClientFromToken, requireUser };
```

### 4-2. 교체 우선순위 (위험 낮은 순 → 높은 순)

1. **트렌드 (get-trends, update-trends, scheduled-trends)** — 외부 영향 없음, 캐시 성격 (Day 1)
2. **베타 (beta-apply, beta-admin)** — 정원 20, 독립 도메인 (Day 1)
3. **이미지 Storage (serve-image, temp-images, last-post-images)** — 새 URL 스킴 검증 (Day 2)
4. **인증 (register, login, find-id, send-otp, verify-otp, reset-password)** — 핵심 (Day 3~5)
5. **프로필/설정 (update-profile, check-plan, disconnect-ig, unsubscribe-retention)** — 인증 후속 (Day 6)
6. **예약 (reserve, get-reservation, cancel-reservation, scheduler, save-reservation)** — 중요 (Day 7~8)
7. **캡션 (process-and-post-background, select-caption, select-and-post-background, regenerate-caption, edit-caption, save-caption, tone-feedback, get-caption-history)** — 매출 직결 (Day 9~10)
8. **결제 (payment-prepare, payment-confirm, cancel-subscription, check-expiry)** — 돈 (Day 11)
9. **IG 연동 (ig-oauth, save-ig-token, save-auto-reply, meta-webhook)** — OAuth flow 안정화 (Day 12)
10. **링크페이지, 최근게시, 기타 (get-link-page, update-link-page, last-post, relay-list, feedback, welcome-caption, count-post)** — 마무리 (Day 13)

### 4-3. Before/After 샘플 (3개)

#### (A) `login.js`

**Before**
```js
const raw = await store.get('user:' + email);           // Blobs PAT 경합
if (!verifyPassword(password, user.passwordHash)) ...   // PBKDF2
const token = crypto.randomBytes(32).toString('hex');
await store.set('token:' + token, JSON.stringify(...)); // 토큰 저장
```

**After**
```js
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data, error } = await sb.auth.signInWithPassword({ email, password });
if (error) return 401;
const { data: profile } = await sb.from('profiles').select('*').eq('id', data.user.id).single();
return { success: true, token: data.session.access_token, refreshToken: data.session.refresh_token, user: profile };
```

#### (B) `reserve.js` (토큰 검증 부분)

**Before**
```js
const userStore = getStore({ name:'users', siteID, token });
for (let i=0; i<5; i++) {
  try { tokenRaw = await userStore.get('token:' + bearerToken); } catch(e) { ... }
  if (tokenRaw) break;
  await sleep(retryDelays[i]);
}
if (!tokenRaw) return 401 or 503;
```

**After**
```js
const { user } = await requireUser(event);       // Supabase JWT 1회 검증
// 이후 DB 작업은 adminClient로 insert (RLS 우회 + 명시적 user_id)
const admin = adminClient();
const reserveKey = `reserve:${Date.now()}`;
await admin.from('reservations').insert({ reserve_key: reserveKey, user_id: user.id, ... });
```

#### (C) `serve-image.js`

**Before**
```js
// /ig-img/{b64}.jpg → serve-image → Blobs arrayBuffer → base64 body
```

**After**
```js
// Netlify redirect 제거, 이미지 URL을 Supabase Storage public URL로 직접 사용
// IG Graph API에는 storage.publicUrl 전달
// serve-image.js는 "last-post" 권한 체크만 남기고 Supabase signed URL을 302 redirect
const { data } = sb.storage.from('last-post-images').createSignedUrl(path, 3600);
return { statusCode: 302, headers: { Location: data.signedUrl } };
```

### 4-4. 배포 전략

- 함수 단위 배포 + 환경변수 기반 Feature flag (`USE_SUPABASE_AUTH=1`, `USE_SUPABASE_STORAGE=1`)
- 기존 Blobs 코드와 Supabase 코드가 한 함수 안에 공존 (Phase 4 완료까지) — if-flag로 분기
- Flag를 끄면 즉시 Blobs로 롤백 가능
- 순차 배포 규칙: 하나의 함수 배포 → 1~2시간 관찰(로그, 에러율) → 다음 함수

---

## Phase 5 — 프론트엔드 전환

### 5-1. `supabase-js` 로딩 방식 — 권장: **CDN**

**근거**
- 현 프로젝트는 Vanilla JS + React UMD 구조 (번들러 없음)
- npm 도입 = 빌드 파이프라인 도입 = 기존 배포 명령(`netlify deploy --dir .`) 전면 개편
- Supabase JS는 `<script type="module" src="https://esm.sh/@supabase/supabase-js@2"></script>` 형태로 사용 가능
- 캐시 + CDN으로 로딩 비용 ≤ 30KB gzipped

**CSP 업데이트 필요**
`netlify.toml` script-src에 `https://esm.sh` 추가, connect-src에 `https://*.supabase.co` 추가

### 5-2. 인증 호출 방식 — 권장: **기존 Netlify Functions 유지 + 내부만 Supabase**

**근거**
- `fetch('/api/login')` 25개 엔드포인트 + 수백 줄의 프론트 세션 코드가 이미 존재
- 프론트가 Supabase를 직접 호출하도록 바꾸면 → 모든 HTML에 퍼진 `fetch('/api/...')` + 토큰/에러/한글 메시지/부가 호출(알림톡, 이메일) 로직 재구현 필요
- **대신 디자인/UX는 100% 유지**, 서버에서 Supabase로 위임
- 예외: 비밀번호 재설정은 Supabase Auth의 `resetPasswordForEmail`로 단순화 가능 (OTP Blobs 의존 제거)

**구체 권고**
- `fetch('/api/register')` → 기존 유지. 서버가 Supabase `auth.admin.createUser` + `profiles.insert`
- `fetch('/api/login')` → 기존 유지. 서버가 `auth.signInWithPassword` 호출, **응답은 이전과 같은 `{token, user}` 포맷**으로 감싸서 반환 (호환 최우선)
- `localStorage.lumi_token` = Supabase access token (JWT) 으로 대체
- `localStorage.lumi_refresh_token` **신규** 키 추가 — 만료 시 재발급용
- 일정 기간 경과 후(Phase 6 검증 완료) — 선택적으로 프론트에서 `supabase-js`로 직접 세션 관리 + `onAuthStateChange` 전환 (Phase 5.5 or Phase 7)

### 5-3. 세션 저장 — 권장: **localStorage (기존 방식 유지)**

**근거**
- httpOnly 쿠키 도입 = 모든 Function 호출에 `credentials: 'include'` + CSRF 토큰 도입 + CORS preflight 재검토 필요
- 현재 JWT (Supabase access_token)는 1시간 수명 → 자동 갱신 로직 필요
- `lumi_token` + `lumi_refresh_token` 2개를 localStorage에 저장, 만료 시 `/api/refresh-token`(신규) 엔드포인트 호출
- 정식 출시 후 보안 강화 필요 시 httpOnly 쿠키로 별도 스프린트에서 마이그레이션 (본 계획 범위 밖)

### 5-4. 이미지 URL 갱신

- 기존: `<img src="/ig-img/{b64key}.jpg">` (Netlify rewrite → serve-image)
- 신규: `<img src="{supabase.storage.publicUrl}">`
- `netlify.toml`의 `/ig-img/*` 리다이렉트는 Phase 7까지 유지 (이전 캐시된 URL 대응) → Phase 7에서 삭제
- Instagram Graph API에 넘기는 이미지 URL도 Supabase public/signed URL로 전환

### 5-5. 수정 범위

| 파일 | 수정 필요 지점 | 작업 |
|---|---|---|
| `index.html` | 라인 4651(register), 4656-4657(token 저장), 4824(login), 4829-4830, 4907, 4929, 4956 (재설정) | 응답 스키마 유지, refresh token 추가 저장 |
| `settings.html` | 279, 307, 339, 370 (프로필/비번/IG연동) | 토큰 만료 시 refresh 호출 추가 |
| `subscribe.html` | 324, 391, 426 | 동일 |
| `ig-guide.html` | 284 | 동일 |
| `netlify.toml` | CSP + `/ig-img/*` 유지 | script-src, connect-src 추가 |
| (신규) `_lib/auth.js` 프론트 | - | 토큰 refresh 공용 함수 `authFetch(url, opts)` |

---

## Phase 6 — 테스트 & 배포

### 6-1. 크로스 체크 체크리스트

**핵심 플로우 (반드시 수동 확인)**
- [ ] 신규 가입 → 웰컴 메일 + 알림톡 → 로그인 유지
- [ ] 로그인 → 토큰 저장 → 대시보드 접근
- [ ] 로그아웃 → 토큰 제거 → 보호 페이지 재진입 시 차단
- [ ] 비밀번호 재설정 (OTP 또는 Supabase 매직링크)
- [ ] 예약 생성 (사진 업로드 → 캡션 생성 대기)
- [ ] 캡션 재생성 (월 3회 쿼터 감소)
- [ ] 캡션 선택 → 게시 → IG 피드 확인 + 스토리 확인
- [ ] 예약 취소 (미게시 상태에서)
- [ ] 말투 피드백 (좋아요/싫어요 → 다음 캡션에 반영)
- [ ] 결제 (PortOne 테스트 모드) → 플랜 변경 확인
- [ ] 구독 해지 → 다음 달 만료 플로우
- [ ] 베타 신청 (정원 안 / 정원 차면 대기)
- [ ] 베타 운영자 대시보드 (LUMI_SECRET)
- [ ] 링크 페이지 `/p/{instagram}` 공개 접근

**회귀 체크**
- [ ] 모바일/데스크톱 양쪽 레이아웃
- [ ] 다크모드/라이트모드 양쪽
- [ ] nav 버튼 (로그인/회원가입/로그아웃/대시보드) 노출·동작
- [ ] 기존 유저가 재로그인 후 기존 데이터 (예약, 캡션 이력, 말투, IG 연동) 그대로 보이는지

**성능/안정성**
- [ ] Supabase 동시성 테스트 (10명 동시 로그인)
- [ ] PAT rate limit 에러 0건 (Netlify 로그)
- [ ] Functions cold start < 2s
- [ ] 이미지 Storage 업로드 지연 측정

### 6-2. Blue-Green 배포 전략

**권장: Netlify Branch Deploy + 환경변수 Feature Flag**
- `main` 브랜치 = 프로덕션 (기존 Blobs)
- `supabase-migration` 브랜치 = 미리보기 URL + 별도 Supabase 프로젝트(dev)
- 각 함수마다 `USE_SUPABASE_{DOMAIN}=1` 플래그로 점진적 활성화
- DNS 스위치 불필요 (이미 같은 도메인에서 flag로 제어)

**단계**
1. `supabase-migration` 브랜치 생성 → 미리보기 URL에서 통합 테스트
2. Phase 3 데이터 마이그레이션 완료 (프로덕션 Blobs → 신규 Supabase)
3. 새벽 02:00 KST 유지보수 창 공지 (고객 0명이지만 베타 테스터 ≤ 20명 대상 알림톡)
4. `main` merge → 함수별 flag를 순차 ON (30분 간격, 에러 모니터링)
5. 72시간 관찰 → 이상 없으면 flag 제거 + Blobs 코드 경로 deprecated

### 6-3. 롤백 시나리오

**Level 1 — 특정 함수만 문제**
- 환경변수 `USE_SUPABASE_AUTH=0` 으로 즉시 OFF → Netlify functions redeploy (1분)

**Level 2 — 광범위 장애**
- Netlify Deploy history에서 이전 배포로 "Publish deploy" (클릭 한 번, ≤ 2분)
- Blobs 데이터는 Phase 7 전까지 유지되므로 데이터 유실 없음
- Supabase에 새로 쌓인 데이터(예약·캡션)는 회수 스크립트로 Blobs에 역이식 (주의: 2주 이내)

**Level 3 — 데이터 손상 의심**
- Supabase PITR(Point-In-Time Recovery, 유료 플랜) — Pro 이상
- 또는 마이그레이션 직후 snapshot으로 복원

---

## Phase 7 — 정리 & 회수

### 7-1. Blobs 아카이브 삭제 기준
- 전면 배포 후 **2주 무사고** (에러율 0.1% 미만, 사용자 신고 0건)
- 그 후 7일 관찰 → 이상 없으면 Blobs 스토어 삭제
- 단, `beta-applicants`는 독립성 있으므로 별도 확인 후 삭제

### 7-2. 환경변수 정리
- 삭제: `NETLIFY_SITE_ID`, `NETLIFY_TOKEN`
- 유지: `LUMI_SECRET`(내부 함수 간 호출 서명), PortOne/OpenAI/Solapi/Resend 키
- 신규: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

### 7-3. 코드 정리
- `@netlify/blobs` 의존성 제거 (`package.json`)
- 함수 내 if-flag 분기 제거 → Supabase 단일 경로
- `diag-blobs.js`, `migrate-user-index.js` 파일 삭제
- `/ig-img/*` redirect 삭제 (CDN TTL 경과 후)

### 7-4. 문서 업데이트
- `CLAUDE.md` — 기술 스택 섹션: "Netlify Blobs" → "Supabase Postgres + Storage + Auth"
- `.claude/rules/netlify-functions.md` — Blobs 규칙 전체 삭제, Supabase 규칙 섹션 신규
  ```
  # Supabase 작업 규칙
  - Service Role 키는 서버 Function에서만 사용, 프론트 번들 금지
  - RLS 정책 없는 테이블 생성 금지
  - 모든 Function에 requireUser() 공통 유틸 사용
  - DB 스키마 변경은 Supabase Migration 파일로 기록
  ```
- `AGENTS.md`, `netlify/functions/CLAUDE.md` 동기화
- `docs/` 하위에 `supabase-schema.md` (ERD + 최신 DDL) 추가

---

## 리스크 매트릭스

| # | 리스크 | 영향 | 발생 확률 | 완화책 |
|---|---|---|---|---|
| R1 | PBKDF2 → Supabase Auth 호환 불가 → 기존 유저 로그인 차단 | 중 | 높음 | Option A (비번 재설정 메일) + 베타 ≤ 20명이므로 수동 안내 병행 |
| R2 | Supabase 장애 시 전체 서비스 다운 (Blobs는 Netlify 인프라에 녹아있어 사실상 Netlify 장애와 연동됨) | 상 | 낮음 | Supabase Pro 플랜 SLA 확인, PITR 백업, Netlify Function 안에 retry + 503 응답 |
| R3 | JWT 만료 → 프론트에서 세션 끊김 | 중 | 중 | `authFetch` 공용 helper가 401 수신 시 refresh 자동 호출 |
| R4 | Storage public URL 예측 가능 → 타인 이미지 노출 | 상 | 낮음 | 경로에 랜덤 nonce + 파일명 UUID, 민감 이미지는 signed URL |
| R5 | IG Graph API가 Supabase Storage URL을 거부/느리게 다운로드 | 중 | 중 | public 버킷 + CDN cache 확보. 실패 시 기존 `/ig-img/*` 프록시 유지 가능 (레거시) |
| R6 | 마이그레이션 스크립트 오류로 일부 레코드 유실 | 상 | 중 | Phase 3 dry-run 모드 먼저, 카운트/샘플 diff 검증, Blobs 원본 유지 |
| R7 | RLS 정책 실수로 자기 데이터 못 보는 케이스 | 중 | 중 | anon 키로 직접 호출하는 프론트 경로 없도록 서버 경유 원칙 고수 (Phase 5.1) |
| R8 | Netlify Function bundling에서 supabase-js 번들 크기 증가 → cold start ↑ | 저 | 중 | `external_node_modules`에 추가 + esbuild tree-shake 확인 |
| R9 | 기존 자체 rate-limit(`rate-limit:{ip}`)를 DB로 옮기면 DB 경합 | 중 | 중 | rate-limits 테이블 간소화, 또는 Supabase Edge Function의 `@upstash/ratelimit` 고려 |
| R10 | CSP 설정 실수로 supabase-js 스크립트 로드 실패 | 중 | 낮음 | 미리보기 브랜치에서 CSP 검증 |
| R11 | 솔라피/Resend 외부 API 동기 호출이 Supabase 트랜잭션 안에 섞이면 지연 | 저 | 중 | 이메일/알림톡은 insert 이후에 별도 await — 현 코드 구조 유지 |
| R12 | 마이그레이션 중 새 예약 들어와서 Blobs와 Supabase 양쪽에 저장되는 split-brain | 상 | 중 | 유지보수 창 내 수행, 또는 예약 함수만 점검 모드로 503 반환 |

---

## 일정 요약 (14영업일 가이드)

| Day | 작업 | 산출물 |
|---|---|---|
| 1 | Supabase 프로젝트 생성, DDL 1차, 공통 유틸 `_lib/supabase.js` | 스키마, 테이블 전체 |
| 2 | Storage 버킷 + RLS 1차 + 트렌드 함수 이전 | `get-trends`, `update-trends`, `scheduled-trends` |
| 3 | 데이터 마이그레이션 스크립트(dry-run) + 베타 함수 이전 | migrate 스크립트 v1, `beta-apply`, `beta-admin` |
| 4 | 인증 함수 이전 (register, login) + 이메일 재설정 안내 템플릿 | 미리보기 URL에서 가입/로그인 통과 |
| 5 | 인증 함수 이전 (find-id, send-otp, verify-otp, reset-password) + 프론트 refresh token 로직 | `_lib/auth.js` 프론트 공용 fetch |
| 6 | 프로필/설정 함수 이전 + 기존 유저 데이터 마이그레이션(실전 실행) | 프로덕션 DB에 데이터 투입 (flag OFF 상태) |
| 7 | 예약 함수 이전 (reserve, get-reservation, cancel-reservation) | 예약 플로우 end-to-end |
| 8 | 스케줄러/배경 작업 이전 (scheduler, save-reservation) | cron 동작 확인 |
| 9 | 캡션 함수 이전 (process-and-post-background, select-caption, regenerate-caption) | IG 게시까지 통합 테스트 |
| 10 | 캡션 부가 (select-and-post-background, edit-caption, save-caption, tone-feedback, get-caption-history) | 말투 학습 반영 확인 |
| 11 | 결제 (payment-prepare, payment-confirm, cancel-subscription, check-expiry) + IG 이미지 Storage 전환 | PortOne 테스트 통과 |
| 12 | IG 연동 (ig-oauth, save-ig-token, meta-webhook, save-auto-reply) + 최근게시/링크페이지 | OAuth + 링크페이지 |
| 13 | 전체 통합 QA + 성능 테스트 + 롤백 리허설 | QA 체크리스트 전 항목 |
| 14 | 프로덕션 전환 (flag ON) + 72시간 모니터링 시작 | 배포 완료 |
| D+14 | Blobs 삭제 + 환경변수 정리 + 문서 업데이트 | 마이그레이션 종료 |

---

## 오픈 이슈 (사용자 확인 필요)

다음 항목은 계획 확정 전 대표님 판단 필요:

1. **비밀번호 재설정 정책** — 베타 유저 전원에게 "재설정 링크" 메일 발송해도 되나? (Option A 채택 시 필수)
2. **Supabase 플랜** — Free로 시작 vs Pro($25/mo, PITR 포함)? 본 계획은 **Free 충분**으로 가정 (DB 500MB + 1GB 스토리지)
3. **Region** — `ap-northeast-2`(서울) vs `ap-northeast-1`(도쿄)? 서울 권장, 단 Netlify 엣지와의 실지연 측정 권장
4. **JWT 세션 수명** — 기본 1시간 유지 vs 4시간으로 연장? (UX ↔ 보안 트레이드오프)
5. **`/ig-img/*` URL 유지 기간** — Instagram이 캐시한 URL이 얼마나 오래 살아있나? CDN TTL 확인 후 최소 30일 유지 권장
6. **데이터 삭제 타이밍** — 현 권고 "2주 무사고 + 7일 관찰" vs 더 보수적(1개월)?
7. **프론트 직접 호출 전환 여부** — Phase 5에서 Functions 유지 결정했으나, 정식 출시 후 `supabase-js` 직접 호출로 리팩터링할지 로드맵에 포함할지
8. **rate-limit 구현** — DB 테이블 vs Upstash Redis vs Supabase Edge `@upstash/ratelimit` 중 최종 선택

---

## 참고 출처

- Supabase SSR / 쿠키 기반 Auth 패턴 및 PKCE 기본값
  - <https://supabase.com/docs/guides/auth/server-side>
  - <https://supabase.com/docs/guides/auth/server-side/creating-a-client>
  - <https://supabase.com/docs/guides/auth/server-side/advanced-guide>
  - <https://supabase.com/docs/guides/auth/sessions/pkce-flow>
  - <https://www.npmjs.com/package/@supabase/ssr>
- Supabase Auth 마이그레이션 (Auth0/Firebase 사례 및 password hash 지원 범위)
  - <https://supabase.com/docs/guides/platform/migrating-to-supabase/auth0>
  - <https://supabase.com/docs/guides/platform/migrating-to-supabase/firebase-auth>
  - <https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects>
  - <https://supabase.com/docs/guides/auth/password-security>
