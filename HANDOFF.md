# 루미(lumi) 인수인계 문서

마지막 업데이트: 2026-05-11
기준 커밋: `main` 브랜치 최신 + 베타 보강 묶음 PR #68 진행

---

## 1. 프로젝트 개요

**루미(lumi)** — 한국 소상공인 사장님을 위한 인스타그램 자동 게시·캡션 생성 서비스.

- 도메인: lumi.it.kr
- 호스팅: Netlify (정적 + Functions + Edge Functions)
- DB·Storage·인증: Supabase
- 회사: 루미 / 대표 김현 / 사업자등록번호 404-09-66416 / 통신판매업 제2024-서울용산-1166호
- 주소: 서울특별시 용산구 회나무로 32-7 (이태원동) 04345
- 문의: lumi@lumi.it.kr · 010-6424-6284

**현재 단계**: 베타 (유료 결제 미도입 · 정식 사장님 0명)

---

## 2. 핵심 흐름

```
사장님 카카오 로그인 (Edge Function: auth-kakao-*)
   ↓
가입 마법사 (signup.html: step1 매장정보+동의 → step2 폰(스킵 가능) → step3 IG 연동)
   ↓
홈 대시보드 (dashboard.html) — 통계·트렌드·다음 예약·베스트 시간·새 댓글
   ↓ (사진 올리기)
register-product.html
   - 4:5 cover crop + JPEG 0.92 압축 (클라이언트)
   - multipart POST /api/reserve
   - 폴링으로 진행 단계 표시 (사진 업로드 → 분석 → 캡션 → 게시)
   ↓
reserve.js (Storage 병렬 업로드 + reservations row insert)
   ↓ trigger
process-and-post-background.js
   - GPT-4o vision 으로 이미지 분석 (사진에 매장명/핸들 보이면 마스킹)
   - GPT-5.4 로 캡션 생성 (사장님 톤 지시 + 평가 데이터 + 매장명/핸들 차단)
   - 즉시(immediate) 모드면 select-and-post-background 직접 트리거
   - 예약(scheduled) 모드면 caption_status='scheduled' 로 대기
   ↓ scheduler (1분 cron)
select-and-post-background.js (Meta Graph API IG 게시)
   ↓
history.html — 사장님 평가 👍/👎 + 코멘트 → tone_feedback 누적 학습
```

---

## 3. 주요 페이지 (정적 HTML)

| 라우트 | 파일 | 역할 |
|---|---|---|
| `/` | index.html | 랜딩 (마케팅·가입 유입) |
| `/signup` | signup.html | 가입 마법사 4-step |
| `/dashboard` | dashboard.html | 홈 — 통계/트렌드/예약/댓글 |
| `/trends` | trends.html | 업종별 트렌드 키워드 |
| `/register-product` | register-product.html | 사진 올리기 (메인 액션) |
| `/history` | history.html | 게시·예약 통합 timeline + 평가 |
| `/insights` | insights.html | 주간/월간/베스트 시간 |
| `/insights/best-time` | insights.html | 베스트 시간 탭 자동 활성 |
| `/comments` | comments.html | 댓글 모음 (Phase 2 — IG fetch 미구현) |
| `/settings` | settings.html | 매장 정보 / IG 연동 / 톤 설정 / 법적 정보 / 탈퇴 |
| `/terms` | terms.html | 이용약관 |
| `/privacy` | privacy.html | 개인정보처리방침 |
| `/support` | support.html | 고객 지원 (있음) |

---

## 4. CSS 구조

- `/css/tokens.css` — 디자인 토큰 (color, spacing, typography, motion)
- `/css/base.css` — reset + 기본 타이포 + a11y + `[hidden]` !important 가드
- `/css/motion.css` — 글로벌 부드러움 레이어 (transition · view-transition · sticky-hover 가드)
- `/css/tabbar.css` — 하단 탭바 (홈·트렌드·올리기·히스토리·설정 5개)
- `/css/legal.css` — 약관·개인정보처리방침 페이지 + 앱 푸터
- `/assets/categories.js` — 4 대분류 ↔ 9 세부 카테고리 매핑

---

## 5. 백엔드 — Netlify Functions

총 **81개 함수**. 디렉토리: `netlify/functions/`

### 인증 / 사용자
- `me.js` — 현재 사장님 정보 조회 (카카오 + Supabase JWT 둘 다)
- `signup-complete.js` — 가입 완료 (매장 정보 + 동의 시각 저장)
- `signup-skip-ig.js` — IG 연동 건너뛰기 → onboarded=true
- `update-profile.js` — 매장 정보 + 톤 지시 갱신
- `account-delete.js` / `account-restore.js` — 30일 grace 탈퇴
- `process-account-deletion-background.js` — 매일 03:00 KST grace 만료 처리

### 인스타 연동
- `ig-oauth.js` — Meta Login OAuth (instagram_* 스코프 사용, 핸들 토큰 Vault 암호화 저장)
- `disconnect-ig.js` — 연동 해제

### 게시 파이프라인 (핵심)
- `reserve.js` — 사진 업로드 + reservations insert + process-and-post 트리거
- `process-and-post-background.js` — GPT-4o 분석 + GPT-5.4 캡션 + 자동 게시 트리거
- `select-and-post-background.js` — IG Graph API 실제 게시
- `scheduler.js` — 1분 cron, scheduled_at 도달한 예약 트리거
- `cancel-reservation.js` — 취소/삭제 (미게시면 row+storage 모두 삭제)
- `reservation-status.js` — 폴링용 단건 상태 조회
- `list-reservations.js` — 본인 예약 목록
- `process-video-background.js` — 릴스 자막 burn-in (ffmpeg)

### 캡션 학습
- `rate-caption.js` — 사장님 평가 (like/dislike + comment) 저장
- `regenerate-caption.js` — 캡션 재생성

### 트렌드
- `get-trends.js` — 업종별 트렌드 키워드 (l30d / season fallback)
- `keyword-detail.js` — 키워드 GPT 즉석 해석 (30일 캐시)
- `scheduled-trends-v2-background.js` — 매일 00:00 KST 트렌드 수집
- `scheduled-community-trends-background.js` — 주 1회 커뮤니티 트렌드

### 인사이트
- `insight-weekly.js` / `insight-monthly.js` — IG Graph API 통계
- `get-best-time.js` — 3-tier (Meta online_followers → 본인 이력 → 업종 시드)

### Cron / 정리
- `cleanup-stale-background.js` — 매시간 (pending 30분 / failed 7일 / posted 30일 storage 삭제)
- `cron-watchdog-background.js` — heartbeat stale 시 admin email 알림 (resend)
- `send-daily-schedule.js` / `send-notifications.js` — 매일 09:00 KST 알림톡

### 관리자
- `admin-*` — sellers.is_admin = true 사장님 전용
- `_shared/admin-guard.js` — admin 게이트

### Edge Functions (Netlify Edge)
- `auth-kakao-start.js` / `auth-kakao-callback.js` — 카카오 OAuth (한국 PoP, cold start ~0)

---

## 6. 데이터베이스 (Supabase Postgres)

프로젝트 ref: `cldsozdocxpvkbuxwqep`

### 핵심 테이블

| 테이블 | 역할 |
|---|---|
| `sellers` | 사장님 계정 (id = 모든 user_id 의 source of truth) |
| `reservations` | 게시 예약/완료 이력 (영구 보존, storage 만 30일 후 삭제) |
| `ig_accounts` | IG 연동 정보 (토큰은 Vault) |
| `ig_accounts_decrypted` | Vault 복호화 view |
| `tone_feedback` | 사장님 평가 (like/dislike + comment, 회원당 각 20개 롤링) |
| `oauth_nonces` | Kakao/IG OAuth 일회용 nonce |
| `trends` | 업종별 트렌드 키워드 (cron 누적) |
| `caption_history` | 캡션 생성 이력 |
| `link_pages` | 링크인바이오 |
| `account_deletion_requests` | 30일 grace 탈퇴 큐 |

### 중요 invariant

```
sellers.id = reservations.user_id = ig_accounts.user_id = tone_feedback.user_id
```

옛 `public.users` 테이블은 멀티마켓 SaaS 시절 잔재로 2026-05-10 완전 제거됨. 모든 FK 는 `sellers` 로 재지정.

### sellers 주요 컬럼 (최근 추가)

- `is_admin` (bool) — 관리자 권한
- `feat_toggles` (jsonb) — feature flag
- `tone_request` (text) — 사장님이 자유 텍스트로 적은 캡션 톤
- `tone_sample_1/2/3` (text) — 사장님 캡션 샘플
- `tone_profile` (jsonb) — brand-retrain 결과
- `terms_consent_at` / `privacy_consent_at` (timestamptz) — 동의 시각
- `marketing_consent` (bool) — 마케팅 수신 동의

---

## 7. 환경변수 (Netlify Site Settings)

| 변수 | 용도 |
|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` | DB 액세스 |
| `OPENAI_API_KEY` | GPT-4o (분석) + GPT-5.4 (캡션) |
| `META_APP_ID` / `META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN` | IG Graph API |
| `KAKAO_CLIENT_ID` (또는 `KAKAO_REST_API_KEY`) | 카카오 OAuth |
| `JWT_SECRET` | seller-jwt HS256 서명 |
| `ENCRYPTION_KEY` | (Vault 외 추가 암호화 자리) |
| `RESEND_API_KEY` | 이메일 발송 |
| `SOLAPI_API_KEY` / `SOLAPI_API_SECRET` / `SOLAPI_SENDER` | 알림톡 발송 |
| `LUMI_SECRET` | 함수 간 내부 호출 인증 (process-and-post 등) |
| `LUMI_ADMIN_EMAILS` / `LUMI_ADMIN_USER_IDS` | 관리자 이메일 / id |
| `LUMI_BRAND_USER_ID` | brand-auto 게시용 가짜 사장님 id |
| `LUMI_DAILY_OPENAI_BUDGET` | 1일 OpenAI 비용 한도 |
| `NAVER_CLIENT_ID/SECRET` | 검색 API |
| `NAVER_AD_API_KEY/SECRET/CUSTOMER_ID` | 네이버 검색광고 (트렌드 키워드 보강) |
| `TIKTOK_APP_ID/SECRET` / `TIKTOK_LOGIN_CLIENT_KEY/SECRET` | TikTok 게시 (심사용) |
| `THREADS_ACCESS_TOKEN` / `THREADS_USER_ID` | Threads 게시 (실험) |
| `YOUTUBE_API_KEY` / `PUBLIC_DATA_API_KEY` | 트렌드/축제 보강 |
| `RECAPTCHA_SECRET_KEY` | 봇 차단 (사용 시) |
| `GITHUB_REPO` / `GITHUB_BRANCH` / `GITHUB_TOKEN` | admin-generate-demo-images 가 GitHub Contents API 로 commit |
| `OWNER_EMAIL` / `ADMIN_EMAIL` | 운영 이메일 |
| `URL` / `DEPLOY_URL` / `DEPLOY_PRIME_URL` | Netlify 자동 주입 |
| `NETLIFY_SITE_ID` / `NETLIFY_TOKEN` | (관리자 도구용) |
| `MODAL_BURN_SUBTITLES_URL` | 외부 영상 자막 burn-in 서비스 |
| `TEST_ACCESS_TOKEN` / `TEST_IG_USER_ID` | 개발 테스트용 |

---

## 8. 배포

- `main` 브랜치에 push → Netlify 자동 빌드 → 라이브 반영
- DB 마이그레이션은 Supabase MCP (`apply_migration`) 또는 Supabase Dashboard 수동 실행
- 옛 GitHub Actions migration 자동화는 비활성 (필요시 재활성)

### 로컬 개발 환경
- 별도 dev 명령 없음 — 정적 HTML 이라 Netlify Dev 또는 단순 정적 서버로 미리보기
- Functions 로컬 실행은 `netlify dev` (Netlify CLI 필요)

---

## 9. AI 모델 사용

| 호출 | 모델 | 위치 |
|---|---|---|
| 이미지 분석 (사진/릴스 키프레임) | GPT-4o vision | process-and-post-background.js / demo-caption.js |
| 캡션 생성 | GPT-5.4 | process-and-post-background.js / regenerate-caption.js / welcome-caption.js |
| 트렌드 정리 | GPT-4o + GPT-5.x | scheduled-trends-v2-background |
| 키워드 즉석 해석 | GPT-4o | keyword-detail (30일 캐시) |

**비용 관리**: `_shared/openai-quota.js` 가 `LUMI_DAILY_OPENAI_BUDGET` 한도로 사장님별 호출 차단.

**프롬프트는 process-and-post-background.js 의 `analyzeImages` / `generateCaptions` 함수에 인라인.** 매장명·IG 핸들 마스킹, AI 클리셰 차단, 톤 자유 텍스트 우선 적용 로직 모두 그 안에 있음.

---

## 10. 외부 서비스 콘솔

| 서비스 | 링크 | 용도 |
|---|---|---|
| Supabase | https://supabase.com/dashboard/project/cldsozdocxpvkbuxwqep | DB / Storage / Vault / Logs |
| Netlify | https://app.netlify.com | 사이트 / 함수 / 환경변수 / 도메인 |
| OpenAI | https://platform.openai.com | API 키 / 사용량 |
| Meta for Developers | https://developers.facebook.com | IG App / Webhook |
| Kakao Developers | https://developers.kakao.com | OAuth App |
| Resend | https://resend.com | 이메일 발송 |
| Solapi | https://console.solapi.com | 알림톡 |
| GitHub | https://github.com/gung3625/lumi.it | 소스 |

---

## 11. 작업 컨벤션

### 커밋
- 한국어 메시지. 첫 줄 50자 안쪽. 본문 이유·맥락 위주.
- Co-Authored-By 필요 시 추가.
- main 직접 push (PR 안 만듦, 베타 단계).

### UI
- **마이크로 인터랙션 필수** — 모든 버튼/카드에 hover/active/transition + reduced-motion 가드.
- **모바일 우선** — 모든 input font-size ≥ 16px (iOS 자동 줌 방지).
- **AI 같은 카피 금지** — "정성스럽게", "프리미엄", "DM 부탁드립니다" 등 클리셰 차단.
- **하드코딩 가짜 데이터 금지** — empty state는 친절한 안내로.
- **로고**: `/assets/logo-wordmark.png` (44px footer, 50px topbar).

### 코드
- 한국어 주석 OK. 핵심 로직은 *왜* 인지 한 줄 적기.
- 외부 API 호출은 `AbortController` 타임아웃 필수.
- DB 변경은 항상 마이그레이션 파일로.
- legacy `public.users` 참조 새로 만들지 말 것 — 전부 `sellers` 기반.

---

## 12. 알려진 미완료 / 다음 단계

### 🔴 우선
1. **결제 시스템** — 토스페이먼츠/포트원 연동 + 자동결제 동의 흐름 + 환불 처리 + 구독 약관 분책

### 🟡 보강
- **카카오 동의 화면 UI** — 사장님이 처음 가입할 때 카카오 측 동의 화면이 익숙하지 않을 수 있음. 가이드 보강.
- **댓글 Phase 2 운영 검증** — 실제 사장님 IG 댓글로 필드 확장 응답 형식, 사장님 본인 답글 매칭, 5분 캐시 신선도 확인 (`getIgTokenForSeller`+Graph 호출 경로 통합 후 첫 실 운영).
- **베스트 시간 요일별 개인화** — 현재 Tier 1/2 도 요일별 리스트는 업종 시드 fallback. Meta `online_followers_by_day` 또는 본인 이력 요일 분포 분석으로 분리 가능.

### 🟢 점진
- **DB 메타 archive** — 1,000명 도달 시 image_analysis 6개월 후 비우기
- **AI 모델 업그레이드** — GPT-5.5 도입 검토 (현재 5.4 → 5.5 시 비용 2배, 한국어 품질 차이 미미)

---

## 13. 자주 쓰는 작업

### 사장님 데이터 리셋 (테스트용)
```sql
DELETE FROM sellers WHERE email = '${test_email}';
-- CASCADE 로 reservations, ig_accounts, tone_feedback 자동 정리
```

### Storage orphan 임시 점검
```sql
SELECT COUNT(*) FROM storage.objects
WHERE bucket_id='lumi-images' AND name NOT LIKE 'brand-library/%';
```

### 특정 cron 수동 트리거
- `/api/scheduled-trends` — 트렌드 파이프라인
- `/api/scheduled-promo-publisher` — 예약 promo 게시
- `/api/process-video` — 영상 후처리

### 마이그레이션 적용
Supabase MCP 의 `apply_migration` 또는 Supabase Dashboard SQL editor 에서 직접.

---

## 14. 최근 큰 변경 (이 세션 — 2026-05-10/11)

### PR #68 — 베타 보강 묶음 (2026-05-11)
- **사진 압축 quality 동적 fallback** — 9~10장 캐러셀이 Netlify 6MB body 한도 초과 시 0.92 → 0.85 → 0.78 단계적 재압축. `register-product.html`.
- **Storage orphan 정리 cron** — 새 `cleanup-orphan-storage-background.js` (daily 04:00 KST). 기존 cleanup-stale 이 못 잡는 row 없는 storage 파일 제거. brand-library/ 보호 + reserve_key 24h 미만 보호.
- **댓글 Phase 2 (IG fetch 활성화)** — `comments.js` 단일 Graph 호출 + 필드 확장 (`comments.limit(20){replies.limit(5){...}}`) 으로 미디어 15개 댓글·답글 한 번에. 사장님 본인 답글은 `reply_text` 로 머지. Netlify Blobs 캐시 5분. `comments.html` XSS escape 추가.
- **베스트 시간 응답 매핑 수정** — `insights.html` 베스트 시간 탭이 늘 "데이터가 부족해요" 표시되던 버그. `get-best-time.js` 응답에 `weekday`/`weekend` 배열 추가.

### 그 이전 (2026-05-10)
- 옛 `public.users` 테이블 완전 정리 (FK 5개 sellers 로 재지정 + 코드 21개 파일 정리 + 6개 함수 삭제 + 테이블 drop)
- 가입 흐름: 카카오에서 폰 받았으면 step 2 스킵 / IG 연동 단계 이탈 시 다음 로그인 시 step 3 자동 점프
- 캡션 모델: GPT-4o → GPT-5.4 (max_completion_tokens 파라미터 사용)
- 프롬프트 전면 강화 (매장명·핸들 마스킹 / AI 클리셰 차단 / 첫 125자 가이드 / 트렌드 vs 해시태그 충돌 제거)
- 예약 탭 → 히스토리 탭 통합 (게시됨 + 실패 + 예약 모두 timeline)
- 캡션 평가 시스템: 👍/👎 + 코멘트 → tone_feedback 누적 → 다음 프롬프트 주입
- 설정에 자유 텍스트 톤 입력 (sellers.tone_request)
- 이용약관 / 개인정보처리방침 작성 (실제 사업자 정보 반영)
- 가입 시 동의 체크박스 (필수 2 + 선택 1)
- 모든 페이지 푸터 통일 (로고 + 사업자 정보)
- 마이크로 인터랙션 보강 (촌스러운 회전 → 부드러운 호흡 + ripple)
- 4:5 cover crop 로 IG 비율 자동 정규화 (1440×1800, JPEG 0.92)

---

## 15. 트러블슈팅 메모

- **"평가 저장 실패"**: rate-caption SELECT 가 schema 에 없는 `caption` 컬럼 명시한 게 원인. `captions` (jsonb) 만 사용하도록 수정됨.
- **"인스타 연동 안 됨" → Meta '...something went wrong'**: scope 이름 mismatch. `instagram_*` 옛 스코프 사용 중 (FB Login + Pages 흐름). `instagram_business_*` 는 instagram.com OAuth 전용.
- **"카드 핑크 테두리가 stick 됨" (모바일)**: `:hover` 가 sticky. `@media (hover: hover)` 로 데스크톱 한정 처리.
- **"새로고침하면 화면이 확대됨" (iOS Safari)**: input font-size < 16px 이면 자동 줌. 모든 input 16px 하한 강제.
- **"동시에 게시 2건 생성"**: iOS 더블탭. submit 핸들러에 `isSubmitting` 락 추가.
- **"홈에 가짜 예약 카드"**: hidden 속성이 `display: flex` 에 덮임. base.css 에 `[hidden] { display: none !important }` 글로벌 가드.
- **"베스트 시간 탭 데이터가 부족해요만 표시"**: `insights.html` 가 `btCache[currentDay]` (=`['weekday']`/`['weekend']`) 를 읽지만 응답 필드는 `bestTime`/`allSlots` 만 있었음. `get-best-time.js` 에 `weekday`/`weekend` 배열 동봉으로 해결 (Tier 1/2 도 시드 fallback).
- **"`/comments` 페이지 XSS 위험"**: comments.html 가 IG 댓글 텍스트를 `innerHTML` 에 escape 없이 꽂음. Phase 1 빈 배열일 때만 안전했고 Phase 2 활성화 직전에 escape 헬퍼 추가.
- **"업로드 9~10장 시 통째 실패 (413)"**: Netlify 함수 body 한도 6MB. 압축 quality 0.92 고정이라 사진 평균 500KB × 10 ≈ 5MB 부근, 사진에 따라 초과. quality 단계 fallback (0.85→0.78) 추가.

---

질문 / 막히는 점은 이 문서 13번 명령어부터 살펴보고 → Supabase 로그 → Netlify Function 로그 순서로 디버깅. 막히면 lumi@lumi.it.kr.
