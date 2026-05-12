# 루미(lumi) 인수인계 문서

마지막 업데이트: 2026-05-12
기준 커밋: `main` 최신 (`bda0015`, PR #144 머지) — PR #69~#144 75건 반영

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

총 **86개 함수**. 디렉토리: `netlify/functions/`

### 인증 / 사용자
- `me.js` — 현재 사장님 정보 조회 (카카오 + Supabase JWT 둘 다)
- `signup-complete.js` — 가입 완료 (매장 정보 + 동의 시각 저장)
- `signup-skip-ig.js` — IG 연동 건너뛰기 → onboarded=true
- `update-profile.js` — 매장 정보 + 톤 지시 갱신
- `account-delete.js` / `account-restore.js` — 30일 grace 탈퇴
- `process-account-deletion-background.js` — 매일 03:00 KST grace 만료 처리

### 인스타 연동 / 댓글
- `ig-oauth.js` — Meta Login OAuth (instagram_* 스코프 사용, 핸들 토큰 Vault 암호화 저장). 연동 성공 직후 `ig-backfill-history-background` fire-and-forget 트리거.
- `disconnect-ig.js` — 연동 해제
- `comments.js` — 미디어 + 댓글 + 답글 한 번에 (필드 확장, Blobs 5분 캐시, `?refresh=1`)
- `reply-comment.js` — 사장님이 IG 댓글에 답글 작성 → Graph POST `/{commentId}/replies`. 성공 시 Blobs 캐시 무효화. (스코프: instagram_manage_comments)
- `ig-backfill-history-background.js` — IG 연동 직후 1회. `/{ig-user-id}/media` 페이지네이션(after 커서 max 10p)으로 평생 게시 이력을 `seller_post_history` 에 채움 (source='pre-lumi'). 베스트 시간 개인화의 즉시 효과 확보.

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
- `get-best-time.js` — **4-tier 가중 하이브리드** (PR #105~#110):
  · **Tier 2** (`follower_activity_snapshots`): 팔로워 활동 매트릭스, 평일 ≥15일·주말 ≥6일 누적 시 활성. 가장 정확.
  · **Tier 1** (가중치): `seller_post_history.reach`·`engagement` 가중. `rowScore = 0.7·log(1+reach) + 0.3·log(1+engagement)`. insights cron 채워진 row 가 충분할 때 자동 가중.
  · **Tier 3** (빈도): `seller_post_history` 단순 빈도. 평일 ≥5건·주말 ≥3건 (요일별 독립 충족).
  · **Tier 4** (시드): 업종 × 요일 매트릭스 fallback.
  · 응답에 `weekday[]`/`weekend[]` (개인화), `modes` ('personal'/'seed'), `progress` (have/need), `sources` (`tier1`/`tier2`/`tier3`/`tier4`), `tier2_progress` (snapshot_days/needed_days) 동봉.
  · Tier 1a (Meta 즉시 호출) 가드: Tier 2 양쪽 ready 면 스킵.

### 보조 데이터
- `get-weather.js` — `sellers.region` 의 시·도 → 17 광역시도 중심좌표 → Open-Meteo current API. WMO code 를 한국어 status+emoji+mood 로 변환. 캡션 생성·대시보드 카드 양쪽에서 호출. (API key 불필요)

### Cron / 정리
- `cleanup-stale-background.js` — 매시간 (pending 30분 / failed 7일 / posted 30일 storage 삭제)
- `cron-watchdog-background.js` — heartbeat stale 시 admin email 알림 (resend)
- `send-daily-schedule.js` / `send-notifications.js` — 매일 09:00 KST 알림톡
- `scheduled-post-insights-background.js` — 매일 03:30 KST. `seller_post_history` 의 `insights_fetched_at IS NULL` row (게시 후 1h~90d) 50건씩 `/{media-id}/insights?metric=reach,saved,total_interactions` 호출 → reach/saved/engagement 채움. 1회 시도 후 무조건 `fetched_at` 채워 영구 실패 무한 재시도 차단. (Tier 1 가중치 데이터 소스)
- `scheduled-followers-snapshot-background.js` — 매일 04:00 KST. `onboarded=true` 사장님 순회, Meta `online_followers` 7일치 row → KST 변환(UTC hour ≥15 면 다음 KST 일자로 분리) → `follower_activity_snapshots` upsert. (Tier 2 매트릭스 데이터 소스)

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
| `seller_post_history` | **IG 게시 이력 통합** — 가입 전 직접 게시(source='pre-lumi') + Lumi 게시(source='lumi'). PK(user_id, ig_media_id). 게시별 reach/saved/engagement/insights_fetched_at. 베스트 시간 Tier 1/3 데이터. |
| `follower_activity_snapshots` | **Meta `online_followers` 누적 매트릭스** — 일별 cron 으로 hour×day_of_week 채움. PK(user_id, snapshot_date, hour). 28일 분 누적되면 베스트 시간 Tier 2 활성. |

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

### ig_accounts 주요 컬럼 (최근 추가)

- `token_invalid_at` (timestamptz) — 실 API 호출에서 401/code 190 받은 시각 (PR #122). `token_expires_at`(예상 만료)와 별개. cron 들이 표시된 사장님은 자동 skip → Meta rate limit 보호. 재연동(`ig-oauth.js` 콜백)시 NULL 복구.
- `region` (text) — 매장 지역 "시·도 구·군" 문자열. signup step1 + settings 양쪽에서 입력. 날씨 카드/캡션의 지역 기반 추천 근거. (2026-05-11 마이그레이션 `20260511000001_add_sellers_region.sql` 로 복구 — sellers_drop_business_columns 때 함께 drop 됐었음)

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
- **댓글 운영 검증 (B 단계)** — A 단계(수동 답글) PR #78 머지 완료. 실제 사장님 IG 댓글로 답글 성공률·5분 캐시 신선도·`?refresh=1` 우회 정상 동작 관찰. 다음 단계는 AI 추천 답글(자동 초안) 가능성 검토.
- **베스트 시간 4-tier 운영 관찰** — PR #105~#110 으로 인프라/로직/UI 완료. 28일 누적 후 Tier 2 진입 사장님 비율, Tier 1 가중치 vs Tier 3 빈도 슬롯 차이, 사장님이 본인 슬롯대로 게시하는지 관찰 후 임계값 튜닝(현재 평일 ≥5·주말 ≥3 / 매트릭스 평일 ≥15·주말 ≥6).
- **캡션 Validator 관찰** — PR #71/#72 의 5축 채점(특히 `tone_match`) pass rate · 자동 재생성 빈도 로깅. 임계값(현재 tone_match≥4) 튜닝 데이터 확보.

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

## 14. 최근 큰 변경 (이 세션 — 2026-05-10/12)

### PR #136 ~ #144 — 진단 보고서 후속 정리 + 위생 (2026-05-12)

진단·코드 리뷰 보고서 권고 후속 처리. 사장님 임팩트 보다는 코드·인프라
견고화 + 정식 운영 가드 강화 위주.

#### 운영 가드
- **#137 IG 재연동 대시보드 카드** — me.js 응답에 igStatus = { connected, tokenInvalid } 노출. 대시보드 상단(날씨 카드 위)에 주황 pulse 카드. 클릭 시 /settings → ig-oauth 콜백이 플래그 NULL 복구. settings 카드(#128)와 동일 UX.
- **#138 trend_keywords.is_new 컬럼 drop** — 죽은 컬럼 정리 마무리. prod 적용 완료. 모든 row is_new=false 였어서 데이터 손실 X.

#### 트렌드 신뢰도 보강 (진단 보고서 권고 5/6/7 처리)
- **#139 DEFAULT_TRENDS 동적 fallback** — GPT 분류 실패 시 정적 키워드("말차라떼" 등 3년 묵음) 대신 직전 cron 결과 재사용. 새 헬퍼 loadFallbackTags(supa, scope, category) — trends.l30d-{scope}:{category} 의 keywords 우선, 비어있으면 DEFAULT_TRENDS 안전망.
- **#140 axis 분류 prompt 일반화** — cafe 중심 정의("menu: 먹는/마시는") 가 fashion/flower 키워드를 헷갈리게 → "주력 판매 제품" 등 업종 무관 의미. 다음 cron 부터 더 정확한 axis 분포.
- **#141 velocity_pct clamp 2000 → 300** — hair max 790% 같은 극단값이 사장님 체감 신뢰도 흔듦. prev<1.0 도 측정 불가(null) 로 — 분모 작아 비율 폭발 방지.

#### 위생
- **#142 deprecated cron 헤더** — scheduled-trends-background.js (v2 통합) 에 명시 → **#147 파일 자체 삭제**. netlify.toml 의 옛 redirect 주석도 정리. scheduled-ig-hashtag-background / scheduled-ig-token-refresh-background 는 in-code config.schedule 로 active 확인 (deprecated 아님).
- **#143 베스트 시간 임계값 상수 분리** — `_shared/best-time-constants.js` 단일 source of truth. THRESHOLDS/HISTORY_WINDOW_DAYS/HISTORY_LIMIT/ACTIVITY_WINDOW_DAYS/ACTIVITY_THRESHOLDS.
- **#144 KST 변환 헬퍼** — `_shared/kst-utils.js` (`utcToKstDate`/`kstDateString`/`kstHourDow`). 19곳 흩어진 `getTime() + 9*3600*1000` 의 통합 시작점. get-best-time.js 한 곳만 교체. 나머지(scheduled-followers-snapshot 등 18곳)는 점진 정리.

#### 데이터 축적 후 작업 (관찰만)
- **베스트 시간 `rowScore` 비율 (`0.7·log(reach) + 0.3·log(engagement)`) 튜닝** — 현재 추측치. 사장님 게시 100건+ 누적 후 데이터 분포 보고 비율 재산출. cron-health 의 trend-categories + seller_post_history 분포 모니터링.

#### 남은 위생 (작은 단위, 우선순위 낮음)
- 19곳 KST 변환 사이트 점진 교체
- DEFAULT_TRENDS 정적 8개 분기별 검토
- (완료 — PR #147 로 scheduled-trends-background.js 삭제 및 netlify.toml stale redirect 정리)

---

### PR #126 ~ #135 — 트렌드 응답 마무리 + IG 재연동 UX + 죽은 코드 정리 + cron 진단 (2026-05-12)

지난 묶음 의 라이브 검증에서 발견된 잔재 fix + 코드 리뷰·진단 보고서 후속 처리.

#### 트렌드 응답 잔재 fix (#126, #127)
- **extras self-dedupe** (#126) — 라이브 응답에서 fitness/cafe/pet 의 같은 키워드 중복 잔존 (예: 레그프레스루틴 2번). `mergeV2Fields` 의 extras 루프가 push 후 `existing.add(key)` 안 해서 `trend_keywords` 에 같은 keyword 가 다른 axis/sub_category 로 2 row 있으면 둘 다 푸시되던 버그. push 전 `existing.add(key)` 1줄 추가.
- **`trend_keywords` 매칭 cutoff 7일 → 30일** (#127) — beauty 응답 0개. base 6개 모두 weak 매칭 dedup 제외 + extras 의 real 3 row 가 2026-04-24 (19일 전) 으로 7일 cutoff 에서 빠짐. 30일로 확장 — weak 는 별도 제외하므로 옛 데이터 노이즈 신경 X.

#### IG 재연동 UX (#128)
- PR #122 의 백엔드 `token_invalid_at` 인프라를 UI 까지 연결.
- `comments.js`: Graph 호출 전 사전 차단 (rate limit 보호), `isTokenExpired()` 시 자동 set.
- `settings.html`: `.is-expired` 카드 (주황 #f5a623 테두리 + pulse 애니메이션 + reduced-motion 가드). 클릭 한 번에 ig-oauth 콜백이 플래그 NULL 복구.

#### NEW 라벨 / 신조어 로직 완전 제거 (#130, #131, #132)
- 사용자 정리: "신조어 라벨 불필요. 카테고리로 이미 분류되고 키워드 클릭 sheet 에서 GPT 가 직접 설명"
- **응답·UI 분기 제거** (#130) — `.kw-badge--new` CSS, 키워드 카드 렌더의 NEW 배지, `isNew` 정렬 우선 분기, `fetchGroupTrends` 머지 시 isNew 보강 모두 삭제. 정렬은 `weightedScore desc > sourceRank` 단순화.
- **cron 측 죽은 로직 정리** (#131) — `checkIsNew` / `classifyNewConfidence` 함수 + 호출 + row 매핑 제거. rows 의 `is_new: false` 고정. `raw_mentions.is_new_confidence` 매핑 제거. `get-trends.js` select 컬럼·매핑 정리.
- **stage 주석 정정** (#132) — "스코어링 + 신조어 감지" → "스코어링".

#### keyword-detail 정식 운영 가드 (#133)
- 사용자 원칙: "항상 정식 운영 단계로 작업". 익명 허용 + quota 미적용 이었던 keyword-detail 강화.
- Bearer 토큰 인증 → 외부 직접 호출 차단 (401).
- 캐시 hit 면 quota 차감 없이 즉시 반환 (글로벌 30일 캐시 그대로).
- cache miss 만 `checkAndIncrementQuota(user.id, 'gpt-4o-mini')` → 한도 초과 429. quota 체크 실패 시 fail-open.
- `trends.html` 호출에 `authHeaders` 추가, 429 응답 시 "오늘 설명 한도 다 썼어요" 안내.

#### cron 진단 + fix (#134, #135)
- 코드 리뷰·진단 보고서 #1 (community/longtail) 처리.
- **longtail 명확한 결함** (#134) — `totalUpdated:0` 영구 지속. `scheduled-trends-v2` 가 `sub_category: ''` (빈 문자열) 저장하는데 longtail 의 lookup 이 `.is('sub_category', null)` 만. 빈 문자열 매칭 X → 0건 처리. `.or('sub_category.is.null,sub_category.eq.')` 로 양쪽 모두 미분류 취급.
- **community 7/9 카테고리 0건** (#135) — cafe·hair·nail·flower·fashion·fitness·pet. 봇 차단 사이트의 `source_url` 을 GPT 가 못 가져오면 필수 필터에서 다 빠짐. prompt confidence 60→40 / excerpt 30자→20자 / source_url 선택적 + "반드시 3개 이상" 강조. validation 도 confidence 50→40 / source_url 필수 → excerpt 또는 community 중 하나만 있어도 채택. 다음 cron(매주 화요일 17:00 UTC) 부터 효과 검증.

#### 결과 — 라이브 응답 검증 (최종)
| 카테고리 | total | weak | dup | src≥2 |
|---|---|---|---|---|
| fitness | 8 | 0 | 0 | 8 |
| cafe | 10 | 0 | 0 | 10 |
| fashion | 5 | 0 | 0 | 5 |
| flower | 9 | 0 | 0 | 8 |
| food | 5 | 0 | 0 | 5 |
| beauty | 3 | 0 | 0 | 3 |
| nail | 11 | 0 | 0 | 11 |
| hair | 10 | 0 | 0 | 10 |
| pet | 7 | 0 | 0 | 7 |

전 카테고리 weak=0 / dup=0 / 정렬 OK.

---

### PR #111 ~ #124 — 베스트 시간 마무리 + 트렌드 신뢰도 + IG 토큰 무효 감지 (2026-05-12)

베스트 시간 시리즈 마무리, 사장님이 보는 트렌드 키워드 품질 일관성, IG 토큰 만료 자동 차단의 인프라.

#### 베스트 시간 후속 (#114)
- **진척 카드 2단계 표시** — 1단계 "내 게시물 도달 데이터" (평일 N/5·주말 N/3) + 2단계 "내 팔로워 활동 데이터" (평일 N/15일·주말 N/6일). 1단계 미완료면 2단계 `.is-locked` (opacity 0.55 + "1단계 후 활성"). 카피 분기: 둘 다 ready → 가장 정확 / 1단계만 → 중간 / 미달 → 시드. 대시보드·인사이트 양쪽 적용.

#### 사용자 보고 버그 (#112)
- **`fix(settings)` 새로고침 시 region "미설정" 초기화** — settings.html 의 me 응답 매핑에서 `seller.region` 키를 빠뜨려, 저장은 성공하지만 새로고침 시 미설정 표시. DB·me.js·update-profile.js 모두 정상 — 단순 클라이언트 변수 매핑 누락이 단일 원인.

#### 베스트 시간 재설계 (#113)
- **2-stage 단순화** — 사용자 지적 "내 게시 빈도(한가했던 시간) ≠ 추천 신호" 반영. Tier 3(빈도) 완전 제거.
- 데이터 부족 → 업종 시드 "사람들이 많이 볼 만한 시간대 평균". 누적 완료 → "내 팔로워가 내 게시물을 가장 많이 본 시간" (Tier 1 reach 가중) → 28일+팔로워 100+ 면 Tier 2(매트릭스) 자동 승급.
- `computePersonalizedSlots` 가 `reach` 채워진 row 만 카운트. 임계값 의미 재정의 — "본인 게시 N건" → "도달 데이터 채워진 게시물 N건". 응답 `weighted` 플래그 제거.

#### 트렌드 파이프라인 재편 (#115~#117)
- **펫 탭 숨김** (#115) — 트렌드 페이지에서만 (가입·캡션 등 전역은 그대로)
- **fitness 라벨 정정** (#116) — `'헬스·필라테스'` → `'운동·레저'`
- **대분류 5개 재편** (#117) — 네이버 쇼핑인사이트 분류 참고. 외식 / 미용 / 패션 / 운동·레저 / 라이프 (flower+pet). 소분류 칩 자체 제거 — 대분류 클릭 시 그룹 안 visible sub 들을 `Promise.allSettled` parallel fetch 후 키워드 머지(`isNew > velocityPct desc > sourceRank`). 슬롯 클릭 sheet 는 각 키워드의 `sourceSub` 보존해서 keyword-detail 호출.

#### 트렌드 신뢰도 일관 (#118~#121, #123)
- **`trend_keywords` 추가 키워드 응답 append** (#118) — `mergeV2Fields` 가 메타 보강만 하고 새 키워드는 추가 안 해서 fitness 응답이 3개 (실은 trend_keywords 에 34개). extras append 로 카테고리당 최대 30개로 확장.
- **weak signal_tier extras 제외** (#119) — trend_keywords 의 50%가 weak (cross_source_count≤1 추정). 추천 풀에서 제외.
- **`crossSourceCount` 신뢰도 배지** (#120) — `kw-badge--src` "N곳" (2 이상). 사장님이 키워드 근거 한눈에.
- **통합 정렬** (#121) — base + extras 를 `isNew > weightedScore desc > base.score` 통합. 정적 DEFAULT_TRENDS (옛 키워드) 가 자연 후순위로 밀림.
- **base 측 dedupe + weak 제외** (#123) — 라이브 응답에서 base 안 같은 키워드 중복(예: 레그프레스루틴 2번) 과 weak 시그널이 잔존하던 문제. base 도 dedupe Map + signalTier='weak' 제외로 응답 신뢰도 일관.

#### IG 토큰 무효 감지 (#122)
- **마이그레이션** — `ig_accounts.token_invalid_at` TIMESTAMPTZ 신설. `token_expires_at` (예상 만료) 와 별개 — 실 API 호출에서 401/code 190 받은 시각. prod 적용 완료.
- **3개 cron 의 자동 감지** — `scheduled-post-insights` / `scheduled-followers-snapshot` / `ig-backfill-history` 모두 사장님 순회 전 `token_invalid_at` 체크 (Meta rate limit 보호) + IgGraphError `code===190` 또는 `status===401` 시 자동 update.
- **재연동 시 복구** — `ig-oauth.js` 콜백의 ig_accounts upsert 에 `token_invalid_at: null` 명시.
- 후속: `me.js` 응답에 노출 + 대시보드 "IG 재연동 필요" 카드 (별도 PR).

#### 자잘한 마무리
- **comments 캐시 TTL 5분 → 2분** (#124) — 사장님이 IG 앱에서 직접 단/지운 댓글의 체감 신선도 ↑. `reply-comment.js` 의 즉시 무효화는 이미 동작.

---

### PR #105 ~ #110 — 베스트 시간 4-tier 가중 하이브리드 (2026-05-12)

기존엔 `bestTime` (시각 1개) 만 개인화되고, 사장님이 실제로 보는 `weekday[]`/`weekend[]` 슬롯 3개는 모든 tier 에서 시드 fallback. 즉 카페 사장님 두 명이면 누구나 동일한 평일 07:30/12:00/19:30. 이 시리즈가 그 흐름을 깨고 4-tier 가중 하이브리드로 재구축.

#### 인프라 (#105)
- **두 테이블 신설** — `seller_post_history` (가입 전 + Lumi 게시 통합, source='pre-lumi'/'lumi'), `follower_activity_snapshots` (Meta `online_followers` 누적). RLS service_role only, FK ON DELETE CASCADE.
- **신규 백필 함수 `ig-backfill-history-background.js`** — IG 연동 직후 fire-and-forget. `/{ig-user-id}/media?fields=id,timestamp,media_type` after 커서 페이지네이션 max 10p. ON CONFLICT DO NOTHING — 재호출 멱등, source='lumi' row 보존.
- `ig-oauth.js` 콜백 hook + `select-and-post-background.js` 가 게시 직후 `seller_post_history` upsert + media_type 보강.

#### 응답 (#106)
- `get-best-time.js` 재작성. seller_post_history 90일 SELECT → KST 변환 → 평일/주말 분리 30분 버킷 빈도 (06~23시 필터).
- 임계값: 평일 ≥5 / 주말 ≥3 (요일별 독립 충족, 부분 개인화 가능). 충족된 쪽은 본인 데이터 top3, 미달은 시드. 충족됐지만 3개 미만은 시드로 보충.
- 응답에 `modes` / `progress` / `thresholds` 추가. `source` 값 확장 (`personal-history`, `personal-history-partial` 등).

#### UI (#107)
- 대시보드 베스트 시간 위젯 + 인사이트 베스트 시간 탭 양쪽에 **모드 배지** (`📊 업종 평균` 회색 / `🎯 내 데이터` 핑크) + **진행 카드** (평일/주말 진척률 막대 + 카운트).
- `transition: width 600ms ease-toss` + `@media (prefers-reduced-motion: reduce)` 가드.
- 응답 호환 — `modes`/`progress` 없는 경우 배지·카드 hidden 유지.

#### Tier 1 (#108) — 게시 성과 가중치
- `scheduled-post-insights-background.js` — 매일 03:30 KST. `/{media-id}/insights?metric=reach,saved,total_interactions` 호출 후 `seller_post_history.reach`/`engagement` 채움. 1회 시도 후 무조건 `fetched_at` 채워 영구 실패 무한 재시도 차단.
- `get-best-time.js` 의 `rowScore()` — `0.7·log(1+reach) + 0.3·log(1+engagement)` 가중. insights 채워진 row 가 자연스럽게 더 무거운 가중치. 응답 `weighted: bool` + `source` 에 `-weighted` suffix.

#### Tier 2 (#109) — 팔로워 활동 매트릭스
- `scheduled-followers-snapshot-background.js` — 매일 04:00 KST. `onboarded=true` 사장님 순회, Meta `online_followers` 7일치 row 를 KST 변환(UTC hour ≥15 면 다음 KST 일자로 분리) 후 `follower_activity_snapshots` upsert.
- `get-best-time.js` 의 `computeActivitySlots()` — hour×요일 평균 follower_count. 임계값: 평일 distinct snapshot_date ≥15 / 주말 ≥6.
- Tier 2 ready 면 history 가중치(Tier 1) 보다 우선 — 팔로워 활동은 외부 도달 신호, 사후 결과보다 사전 신호가 더 일반적.
- 응답 `sources` (tier1/2/3/4) + `tier2_progress` (snapshot_days/needed_days) 신설. Tier 1a (Meta 즉시 호출) 가드 — Tier 2 양쪽 ready 면 스킵.

#### "왜 이 시간?" sheet (#110)
- 인사이트 베스트 시간 탭의 `time-card` 를 `<button>` 으로 변환. 클릭 시 slide-up sheet. esc·backdrop 닫기, focus 복원, reduced-motion 가드.
- tier 별 다른 카피:
  · tier2 — "내 팔로워가 가장 많이 접속해요"
  · tier1 — "이 시각에 올린 게시물이 실제로 더 잘 됐어요"
  · tier3 — "내가 평소 게시하던 시간"
  · tier4 — "업종 평균. 게시 N건 또는 팔로워 데이터 N일 누적 시 자동 전환"
- 진행 카드 hint 도 source 기반 분기 — tier 별 다음 단계 안내 명확화.

#### 마이그레이션
- `supabase/migrations/20260512000000_post_history_and_follower_snapshots.sql` — 두 테이블 + 인덱스 + RLS. **prod 적용 완료** (Supabase MCP `apply_migration`).

#### 데이터 흐름 요약
```
가입 전 IG 게시  ──┐
                    └─→ seller_post_history (백필/Lumi append)
Lumi 게시       ──┘                │
                                     ├─→ Tier 3 (빈도) — 즉시 활성 (3+건)
                                     └─→ Tier 1 (가중) — insights cron 채워지면

Meta online_followers ──→ follower_activity_snapshots (일별 cron)
                                     └─→ Tier 2 (매트릭스) — 28일 누적 시
```

---

### PR #69 ~ #104 묶음 (2026-05-11/12)

#### 🧠 캡션 프롬프트 v2 (#69~#72)
- **동일 사진 중복 게시 race 차단** (#69) — 즉시 모드의 직접 트리거와 1분 cron scheduler 가 같은 row 를 동시에 잡아 IG 에 N번 게시되던 race. `caption_status` 를 atomic CAS `'scheduled' → 'posting'` 로 전이. WHERE 절이 row lock 안에서 재검사돼 정확히 1개만 affected.
- **펫·일상 사진의 "매장 프레임" 강제 제거** (#70) — vision 이 비즈니스 무관 신호 줘도 업종 CTA·해시태그 박히던 버그. "사진 우선 원칙" 섹션 신설.
- **끝판왕 v2 — Vision JSON + business_relevance + Validator** (#71) — `analyzeImages` 가 자유 텍스트 → JSON Schema(gpt-4o) 출력. `business_relevance`/`scene_type`/`subjects`/`story_arc` 등 정형 신호를 캡션 단계가 읽고 매장 vs 일상 모드 자동 분기. 끝에 `validateCaption` (gpt-4o-mini + JSON) 5축 채점 + 실패 시 1회 재생성. 프롬프트 60% 컴팩트화. `regenerate-caption.js` 도 JSON 파싱.
- **사장님 톤을 mandatory 로 분리** (#72) — `buildToneContext` 가 `{ mandatory, context }` 로 분리. 사장님 자유 톤 원문은 프롬프트 최상단 "⚡ 사장님 톤 — 최우선" 섹션에 별도 배치. validator 에 `tone_match` (1~5) 추가, pass 조건에 `tone_match≥4` 포함.

#### 🕐 베스트 시간 강화 (#73~#76)
- **fitness 카테고리 매핑 버그** — `normalizeCategory` regex 가 fitness/크로스핏/crossfit 인식 못해 'other' 시드로 떨어짐. gym 으로 매핑 추가.
- **대시보드 오늘 슬롯 전체 표시** — 단일 bestTime → 평일/주말 자동 판단 후 3개 슬롯 렌더. 현재 시각 이후 가장 가까운 슬롯에 `is-now` 핑크 강조 + "다음 임박" 라벨.
- **다 지난 케이스 안내** — 오늘 베스트 시간 모두 지났을 때 "내일 같은 시간대 어떠세요" 류 카피.
- **인사이트 베스트 시간 탭도 동일 로직 적용** + 대시보드 섹션 헤더 노출.

#### 💬 댓글 Phase 2 후속 (#77~#81)
- **썸네일 + permalink** (#77) — 댓글 카드에 게시물 썸네일과 IG 원문 링크.
- **루미에서 답글 작성 (A 단계)** (#78) — 신규 `reply-comment.js` (Graph POST `/{commentId}/replies`). `_shared/ig-graph.js` 에 POST 지원 추가 (form-urlencoded body, access_token 은 query). `comments.html` 에 "↳ 답글 달기" 토글 + 낙관적 UI. 권한은 기존 OAuth 스코프(`instagram_manage_comments`) 그대로 — 재연동 불필요.
- **레이아웃 + 순서** (#79) — 캡션·댓글·답글 시각 순서 정리.
- **스토리에도 자동 업로드 토글** (#80) — `register-product` 에 토글 (피드 + 스토리 동시 발행).
- **캐시 우회 새로고침** (#81) — `?refresh=1` 쿼리로 5분 Blobs 캐시 우회. topbar 새로고침 버튼 + visibilitychange 자동 갱신(30초 임계). IG 에서 사장님이 삭제한 답글이 즉시 반영. (IG Graph API 자체는 게시물 삭제 미지원이라 사장님이 IG 앱에서 직접 삭제해야 함)

#### 📑 히스토리 ↔ 예약 탭 분리 (#82~#86)
- `/history` 상단에 "예약 목록 / 히스토리" 두 탭. `?tab=upcoming|past`. 디폴트는 "예약 목록".
- 대시보드 "다음 예약" 카드 → `/history?tab=upcoming` 로 직접 진입 (이전엔 빈 카드가 업로드로 가서 혼란).
- 예약 시간 검증 + 취소 낙관적 UI + 카피 일관성 + fetch 15초 timeout 보강.
- 하단 탭바 히스토리 → `/history?tab=past`.

#### 🗺 매장 지역 입력/편집 (#87~#91)
- **signup step1 에 지역 입력** (#87) — 시·도 + 구·군 cascading.
- **settings 에서 변경** (#88) — 모달로 cascading select. `update-profile.js`/`me.js` 에 region 추가.
- **버튼 잘림/wrap 레이아웃 fix** (#89, #90) — 인라인 편집 시 취소 버튼 우측 정렬.
- **DB region 컬럼 복구 마이그레이션** (#91) — prod 에는 Supabase MCP 로 즉시 적용. `20260511000001_add_sellers_region.sql` 은 다른 환경/향후 빌드 일관성.

#### ☔ 날씨 카드 (#94~#96)
- **신규 `get-weather.js`** — Open-Meteo current API. WMO code → 한국어 status+emoji+mood. region 미설정/실패 시 `noRegion`/`error`. API key 불필요.
- **register-product 에 날씨 토글** (#95) — 디폴트 ON. submit 시 `/api/get-weather` 호출 후 FormData 첨부. (캡션 프롬프트는 이미 weather 받으면 활용하도록 구현돼 있었으나 register-product 가 fetch 안 해서 항상 빈 객체였음.) `business_relevance=high/medium` 매장 콘텐츠만 자연 활용, low/none 은 백엔드에서 자동 스킵.
- **표시 정밀도** (#96) — "서울" → "서울 강서구".

#### 🪟 새로고침 스크롤 (#92, #93)
- 11개 페이지 head 에 inline 1줄. `navigation type === 'reload'` 면 scrollTo(0,0). `scrollRestoration='manual'` 강화. 뒤로가기·BFCache 는 기존 위치 유지.

#### 🧹 트렌드 라벨/카테고리 정리 (#103)
- '운동화/스니커즈' 시드를 fitness → fashion 으로 이동. GPT 분류 프롬프트에도 fashion 전용 규칙 + fitness 나쁜 예 명시.
- 대분류 라벨 '옷가게' → '패션' (id 는 `fashion` 유지).

#### ↩️ 활용 팁 미리보기 추가→revert (#99/#101/#102)
- top hot 키워드 활용 아이디어 첫 줄을 카드 아래 inline 미리보기 (#99). 카테고리 빠르게 전환 시 이전 응답이 새 카드 idx 0~1 에 inject 되던 race fix (#101). 사용자 판단으로 전체 revert (#102). 카드 클릭 시 sheet 로 활용 아이디어 보는 동작은 유지.

#### 🪙 자잘한 마무리
- 빈 상태 카피 개선 (#83, #98), 평가 버튼 micro-interaction (별도 — main 직접 push 분), 법적 정보 푸터 inline 일관 (#97), 지역 미설정 시 안내 강조 (#100), 푸터 대표 전화번호 추가 (#104).

---

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
- **"동일 사진이 IG 에 2~3개 게시됨"**: 즉시 모드의 직접 트리거 + 1분 cron scheduler 가 같은 row 를 동시에 잡던 race. PR #69 에서 `caption_status 'scheduled' → 'posting'` atomic CAS 로 차단. 새 게시 파이프라인 코드 작성 시 반드시 동일 패턴 유지.
- **"매장 정보 저장 시 'column does not exist'"**: `sellers_drop_business_columns` (2026-05-10) 가 `region` 컬럼까지 함께 drop. PR #88 머지 후 발견. PR #91 마이그레이션 `20260511000001_add_sellers_region.sql` 로 복구. 비슷한 drop 마이그레이션 작성 시 현재 사용 중인 컬럼인지 grep 으로 한 번 더 확인.
- **"펫·풍경 사진인데 캡션이 매장 톤 + 업종 해시태그 강제"**: vision 의 비즈니스 무관 신호를 캡션 단계가 못 읽던 버그(자유 텍스트 시절). PR #71 의 Vision JSON 출력 + `business_relevance` 분기로 해결. 프롬프트 수정 시 JSON 스키마/분기 룰 깨지지 않는지 확인.
- **"카테고리 빠르게 전환 시 다른 카테고리 활용 팁이 inject"** (PR #99 → #101 → #102 로 전체 revert): 늦게 도착한 prefetch 응답이 새 카테고리 카드에 inject 되던 race. 카테고리 전환형 prefetch 패턴 다시 도입 시 응답 도착 시점에 `currentCategory === renderCategory` 검증 필수.
- **"새로고침 했는데 화면 중간부터 시작"**: 브라우저 기본 `scrollRestoration='auto'`. PR #92/#93 에서 11개 페이지 head 에 reload 시 `scrollTo(0,0)` inline 스니펫 + `scrollRestoration='manual'` 추가. 새 페이지 만들 때 동일 스니펫 빠뜨리지 말 것.

---

질문 / 막히는 점은 이 문서 13번 명령어부터 살펴보고 → Supabase 로그 → Netlify Function 로그 순서로 디버깅. 막히면 lumi@lumi.it.kr.
