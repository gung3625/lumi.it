# 인수인계 — Lumi 프로젝트

다음 세션이 이 파일 읽고 이어가면 됩니다.

작성: 2026-05-07 18:30 KST
브랜치: `main`
마지막 commit: `9814a4e`

---

## 이번 세션 push 한 commit (시간순)

| commit | 내용 |
|---|---|
| `b836e83` | SSR 헤더/푸터 인라인 + xlsx 의존성 제거 (9/16 페이지) |
| `d3999f5` | dashboard·register-product·mobile-preview mock 제거 + demo-caption 임시 wire |
| `0b7cbc0` | orphan JS 7개 삭제 (sprint3-5 멀티마켓 잔재, -3511줄) |
| `09df2db` | settings 끊어진 API 호출 3건 placeholder 처리 |
| `b0e7777` | index hero 5단계 인터랙티브 튜토리얼 (SVG 사진·typewriter·재생성·게시) |
| `f2cacb5` | demo-caption 폐기 → `/api/reserve` 진짜 reservation 흐름 wire (multi-photo + polling + 3회 재생성) |
| `9814a4e` | trends·reservations·dashboard stat·index hero chip 실데이터 wire |

---

## 현재 상태

### ✅ 작동 (push 완료)
- 회원가입 (카카오·구글 OAuth)
- Reservation 흐름 코드 (e2e 미테스트)
- 트렌드·예약 실데이터 fetch
- Hero 인터랙티브 튜토리얼
- 모든 페이지 200 OK

### ❌ 미완성

#### A. 30일 유예 회원 탈퇴 — 다음 세션 즉시 진행 (브리프 완성됨, 구현 0건)

**흐름**: 탈퇴 클릭 → `deletion_requested_at = now`, `deletion_scheduled_at = now + 30일` → 이메일 + 자동 logout → 30일 동안 다시 로그인 가능 + 배너로 복구 가능 → 7일·1일 전 reminder → 만료 시 cron이 실 삭제

**파일 (총 10+)**:

신규 SQL: `supabase/migrations/20260507000003_account_deletion_grace.sql`
```sql
ALTER TABLE public.sellers
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_reminder_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sellers_deletion_pending
  ON public.sellers(deletion_scheduled_at)
  WHERE deletion_requested_at IS NOT NULL AND deletion_cancelled_at IS NULL;
```

신규 함수 4개 (`netlify/functions/`):
1. **`account-delete.js`** (POST) — JWT 검증 + sellers UPDATE: deletion_requested_at = now, deletion_scheduled_at = now + 30 days. 이메일 발송 (Resend, RESEND_API_KEY).
2. **`account-restore.js`** (POST) — JWT 검증 + UPDATE deletion_cancelled_at = now. 복구 알림 이메일.
3. **`process-account-deletion-background.js`** (cron `0 18 * * *`, KST 03:00) — 만료 row select → 이메일 → cascade delete (sellers + ig_accounts + tiktok_accounts + reservations + auth.users via admin.auth.admin.deleteUser).
4. **`send-deletion-reminders-background.js`** (cron `0 0 * * *`, KST 09:00) — 7일 전·1일 전 reminder + deletion_reminder_sent_at 갱신.

`netlify.toml` 추가:
```toml
[functions."process-account-deletion-background"]
  schedule = "0 18 * * *"
[functions."send-deletion-reminders-background"]
  schedule = "0 0 * * *"
[[redirects]]
  from = "/api/account-delete"
  to = "/.netlify/functions/account-delete"
  status = 200
  force = true
[[redirects]]
  from = "/api/account-restore"
  to = "/.netlify/functions/account-restore"
  status = 200
  force = true
```

`netlify/functions/me.js` 보강:
- sellers select에 `deletion_requested_at, deletion_scheduled_at, deletion_cancelled_at` 추가
- 응답에 `deletionRequestedAt`, `deletionScheduledAt`, `deletionCancelledAt`, `deletionPending: Boolean(deletion_requested_at && !deletion_cancelled_at)` 추가

`js/_shared/auth-guard.js` 보강:
- /me 응답 `deletionPending: true`면 페이지 진입은 허용 + 상단에 배너 자동 삽입
- 배너: "회원 탈퇴 진행 중 — N일 후 자동 삭제됩니다. [복구하기]"
- 복구 클릭 → POST `/api/account-restore` → 새로고침
- 디자인: 핑크 #C8507A 배경, 흰 글자, sticky top

`settings.html`:
- 현재 `confirmDeleteAccount` 함수가 placeholder 안내만 — 진짜 fetch로 교체
- 모달 본문에 "30일 유예기간" 안내 추가
- delete-confirm-btn `disabled` 풀기

`privacy.html`:
- #data-deletion 섹션 + §07 정보주체 권리에 30일 유예 명시: "회원 탈퇴 요청 시 30일 유예기간을 둡니다. 30일 내 다시 로그인하면 탈퇴 취소 가능. 30일 만료 시 자동으로 모든 데이터 영구 삭제."

`terms.html`:
- §14 회원 탈퇴 조항 추가 (없으면 신규): 위와 동일 30일 유예 내용

`support.html`:
- FAQ "회원 탈퇴 절차" 항목 추가/보강

#### B. 백엔드 신규 함수 8개 (audit BLOCKER 잔여)
1. `/api/insight-monthly`, `/api/insight-weekly`, `/api/insight-on-demand` — IG Graph API insights wrapper (dashboard 좋아요·도달·팔로워 stat용)
2. `/api/update-profile` — sellers UPDATE (settings 매장 정보 저장 — 현재 localStorage 임시 저장만)
3. `/api/export-my-data` — PIPA §35 자기정보이동권
4. `/api/brand-stats`, `/api/brand-retrain`, `/api/brand-settings` — brand-admin placeholder 채우기

→ A 마치고 B 진행 권장.

#### C. 5개 앱 페이지 정적 header/footer 마이그레이션 (선택)
- settings, trends, brand-admin, mobile-preview, reservations
- 의도적 동적 유지 vs FOUC 방지 결정 필요. 필수 아님.

---

## 사용자 직접 액션 (외부)

### 즉시
- **좀비 Claude Code 창 닫기** — conversation `12c748fc-52dc-48f0-8172-18519e31afaf`가 자동 재시작 루프. UI X 버튼.

### 가까운 시일
- **Supabase migration 7개 실행** (Studio SQL editor 또는 `supabase db push`):
  - `20260501000007_tiktok_accounts.sql`
  - `20260501000008_brand_library_tables.sql`
  - `20260501000009_reservations_brand_auto_columns.sql`
  - `20260501000010_users_is_admin_column.sql`
  - `20260506000001_tiktok_accounts_updated_at.sql`
  - `20260506000002_sellers_signup_columns.sql`
  - `20260507000003_account_deletion_grace.sql` ← A 작업 후 추가됨
- **Reservation 흐름 e2e 테스트** — 카카오 로그인 → 사진 1~10장 → 캡션 생성·재생성 → 게시 검증

### 외부 콘솔
- **TikTok 앱 폼** (developers.tiktok.com): Webhook 제거, redirect URI `https://lumi.it.kr/api/auth/tiktok/login/callback` 등록, Save → 심사 영상 후 제출
- **Meta App Review** (`META_APP_REVIEW.md` 가이드)
- **Google OAuth Supabase Dashboard**: Provider Google enable + Cloud OAuth client_id/secret 입력
- **앱 아이콘 PNG** (1024×1024, 512, 192) + **사업자등록증·통신판매업 신고증 사진** (Meta Business Verification)

### 보류 결정
- 가격 정책 확정 → pricing.html + 결제 시스템 재도입 시점
- 베타 페이지 신규 작성 시점
- TikTok 심사 통과 후 settings.html `connectTiktok()` 옵션 A 활성화 (3줄 변경)

---

## Netlify Env (이미 등록 — 검증됨)

✓ `KAKAO_CLIENT_ID` (`161f7b8767d792c3fabde651653ac6b3`), `KAKAO_CLIENT_SECRET`, `JWT_SECRET`
✓ `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`
✓ `GOOGLE_CLIENT_ID`
✓ `RESEND_API_KEY`, `SOLAPI_API_KEY`, `SOLAPI_API_SECRET`, `SOLAPI_CHANNEL_ID`
✓ `TIKTOK_LOGIN_CLIENT_KEY`, `TIKTOK_LOGIN_CLIENT_SECRET`, `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`
✓ `LUMI_SECRET`, `META_APP_ID`, `META_APP_SECRET`, `OPENAI_API_KEY`

❌ `GOOGLE_CLIENT_SECRET` 미등록 (Supabase OAuth provider 활성화 시 필요 — Google Cloud Console에서 가져와 추가)

---

## 추측·미검증 (정직 표시)

다음 항목은 **agent 보고 기반이거나 코드 작성만 하고 실 e2e 검증은 안 함**:

- `f2cacb5` reservation 흐름: 코드만 작성, 실 사용자가 사진 올려본 적 X
- `get-reservation` API 응답 schema가 reservation row 그대로인지 미검증
- `9814a4e` dashboard wire에서 list-reservations 응답 caption_status 필드가 실제 채워지는지 미검증
- Netlify 빌드 success만 보고 200 OK 확인 — 페이지 안 모든 기능 작동까진 미검증

다음 세션이 e2e 테스트로 검증해야 함.

---

## 다음 세션 시작 명령

```bash
git pull origin main
git log --oneline -10  # 7개 commit 보여야 함 (b836e83 ~ 9814a4e)
cat HANDOFF.md         # 이 파일
```

그 다음 위 **A. 30일 유예 회원 탈퇴** 진행. 다음 세션이 위 brief 그대로 agent에 위임하거나 직접 구현 가능.

작업 순서 권장: A (탈퇴 시스템) → B (백엔드 8개 함수) → C (5개 앱 페이지 header/footer, 선택).

---

## 알려진 이슈

### 이전 conversation 좀비
- conversation `12c748fc` 가 자동 재시작 루프 (UI에서 7개 sub-agent "실행 중" 표시)
- 실제 sub-agent jsonl은 14:31에 freeze. work 안 함.
- 사용자가 그 Claude Code 창 직접 닫아야 정리됨.

### 이번 세션 30일 유예 작업 미완성
- agent `a569becf422a88e98` (account-deletion-grace) 시작 후 stop. commit 0건.
- 다음 세션이 위 A brief 그대로 진행하면 됨.

---

## CI/CD

Netlify 통합 배포 파이프라인. main 브랜치 push 시 Netlify가 GitHub 연동을 통해 자동으로 빌드·배포하며, 빌드 step에서 Supabase 마이그까지 함께 적용한다. 별도 GitHub Actions 워크플로우 없음.

### 동작 방식

- Netlify가 이미 GitHub 레포의 `main` 브랜치에 자동 배포로 연결됨 (사이트 ID `28d60e0e-6aa4-4b45-b117-0bcc3c4268fc`)
- main 브랜치 push → Netlify build 시작 → `netlify.toml` 의 `[build].command` 실행:
  ```
  npx -y supabase@1.215.0 db push --db-url "$SUPABASE_DB_URL" --include-all && npm install
  ```
- 마이그 적용 성공 시 `npm install` 후 publish (`.` 디렉토리) → 라이브 반영
- 마이그 실패 시 빌드 자체가 fail → Netlify가 새 deploy를 publish 하지 않음 → race 없음

### 필수 Netlify Env (등록 완료)

- **`SUPABASE_DB_URL`** — Session Pooler URL (`postgresql://...pooler.supabase.com:5432/postgres`). **이미 등록·검증 완료.**
  - 발급 경로: Supabase Studio → Project Settings → Database → Connection string → **Session pooler** 탭
  - direct URL이 아닌 **Session Pooler URL** 사용 (Netlify 빌더 IPv4 환경 호환)

이 외 사용자가 추가로 해야 할 액션 없음. GitHub Secrets 등록·관리 불필요.

### 수동 트리거

Netlify Dashboard → Deploys 탭 → **Trigger deploy → Deploy site** (또는 캐시 클리어 후 deploy).

### 주의사항

- `--include-all`은 schema_migrations에 등록되지 않은 마이그까지 시도하므로, 수동 SQL로 이미 적용된 마이그가 있으면 첫 자동 배포에서 **충돌 가능**. 첫 머지 전에 로컬에서 한 번 `supabase db push --db-url "$SUPABASE_DB_URL" --include-all` 직접 실행 → 충돌 row 정리(중복 object skip 또는 schema_migrations에 수동 insert) 권장
- 마이그 변경이 없는 push는 supabase CLI가 `schema_migrations` 비교 후 no-op (idempotent)
- 기존 `[functions]`, `[[headers]]`, `[[redirects]]`, cron schedule 설정 모두 유지됨 — `[build]` 섹션의 `command`만 변경
