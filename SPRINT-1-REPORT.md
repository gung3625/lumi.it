# Sprint 1 — 가입 흐름 완성 보고서

**브랜치**: `feature/sprint-1-onboarding`
**작업 기간**: 2026-04-27
**검증 일시**: 2026-04-27

---

## 1. 작성·정정 파일 통계

### 신규 파일 (27개)

| 영역 | 파일 | 라인 수 |
|---|---|---|
| 페이지 | `signup.html` | 338 (개업일 입력 추가) |
| 클라이언트 | `js/onboarding.js` | 870 (startDate + 친화 에러 카드 처리) |
| 스타일 | `css/onboarding.css` | 603 |
| 스타일 | `css/onboarding-tokens.css` | 180 |
| 마스코트 | `assets/onboarding/lumi-*.png` (4종) | 바이너리 |
| API | `netlify/functions/business-verify.js` | 220 (NTS 실연동) |
| API | `netlify/functions/signup-create-seller.js` | 269 |
| API | `netlify/functions/signup-tone-samples.js` | 113 |
| API | `netlify/functions/me.js` | 132 |
| API | `netlify/functions/connect-coupang.js` | 240 |
| API | `netlify/functions/connect-naver.js` | 285 |
| API | `netlify/functions/market-permission-check.js` | 213 |
| API | `netlify/functions/market-guides.js` | 75 |
| 공유 | `_shared/coupang-signature.js` | 215 |
| 공유 | `_shared/encryption.js` | 88 |
| 공유 | `_shared/market-errors.js` | 178 (사업자 인증 에러 6종 추가) |
| 공유 | `_shared/nts-business-client.js` | 100 (NTS 진위·상태 클라이언트 신규) |
| 공유 | `_shared/onboarding-utils.js` | 161 |
| 공유 | `_shared/seller-jwt.js` | 123 |
| 마이그레이션 | `migrations/2026-04-27-sprint-1-sellers.sql` | 197 |
| 테스트 | `_shared/__tests__/coupang-signature.test.js` | 256 |
| 테스트 | `_shared/__tests__/business-verify.test.js` | 270 (15 케이스, 신규) |
| 환경 | `.env.example` | 35 (PUBLIC_DATA_API_KEY 추가) |
| 검증 | `sprint1-verify/mini-server.js` | 145 |
| 검증 | `sprint1-verify/verify.js` | 215 (게이트 11 추가) |
| 검증 | `sprint1-verify/business-verify-real.js` | 175 (NTS 실연동 통합 테스트, 신규) |
| 검증 | `sprint1-verify/puppeteer.js` | 211 |

### 정정 파일 (2개)

| 파일 | 변경 |
|---|---|
| `netlify.toml` | Sprint 1 라우트 9건 추가 (/signup, /onboarding pretty URL + 7개 API force redirect) |
| `.gitignore` | `.tmp-verify/`, `.omc/state/agent-replay-*.jsonl`, `sessions/` 추가 |

**총 신규/수정 코드 라인 수**: ~5,300 줄 (HTML 330 + JS 1,068 + CSS 783 + Functions 1,887 + Shared 712 + Tests/Verify 819 + SQL 197 + Config 31 + 마이그)

---

## 2. 13개 검증 게이트 결과

`PUBLIC_DATA_API_KEY=... node sprint1-verify/verify.js http://localhost:8889`

| # | 게이트 | 결과 | 상세 |
|---|---|---|---|
| 1 | `/signup` 페이지 200 + 5단계 마크업 | **PASS** | step1=true step5=true |
| 2 | `POST /api/business-verify` (220-81-62517) → 200 + verified=true | **PASS** | method=mock (로컬 mock 모드) |
| 3 | `POST /api/signup-create-seller` → 200 + JWT + sellerId | **PASS** | hasToken=true mock=true |
| 4 | `GET /api/me` (Bearer 토큰) → 200 + 셀러 정보 | **PASS** | hasSeller=true |
| 5 | `POST /api/connect-coupang` (TEST_OK) → 200 + verified=true | **PASS** | verified=true |
| 6 | 쿠팡 TEST_401 → 친화 에러 카드 (title/cause/action/deepLink/statusCode) | **PASS** | title="쿠팡 인증 실패" deepLink=coupang.api_key_issue |
| 7 | 쿠팡 TEST_403 → 권한 가이드 deepLink=coupang.permission_check | **PASS** | title="쿠팡 판매 권한 없음" estimatedTime=5초 |
| 8 | HMAC 한글 단위 테스트 (13건) | **PASS** | 13 PASS / 0 FAIL |
| 9 | `POST /api/market-permission-check` → 200 + scopeOk | **PASS** | scopeOk=true |
| 10 | `GET /api/market-guides?market=coupang` → 200 + 가이드 ≥2건 | **PASS** | count=2 (fallback) |
| **11** | **국세청 공공 API 실연동 (status + validate + handler)** | **PASS** | A+B+C 통과 (계속사업자=01) |
| 12 | (bonus) 네이버 TEST_OK → 200 verified=true | **PASS** | verified=true |
| 13 | (bonus) `/api/signup-tone-samples` → 200 stored≥2 | **PASS** | stored=2 |

**총: 13/13 PASS, 0 FAIL** ([결과 JSON: /tmp/sprint1-verify-result.json])

### 게이트 11 — NTS 실연동 상세

`node sprint1-verify/business-verify-real.js` 단독 실행 결과:

| Stage | 검증 항목 | 결과 |
|---|---|---|
| A | `POST /api/nts-businessman/v1/status` 200 + `b_stt_cd` 파싱 | **PASS** (계속사업자=01) |
| B | `POST /api/nts-businessman/v1/validate` 200 + `valid` 파싱 | **PASS** (응답 200 + valid 코드 파싱) |
| C | `business-verify.js` handler 통합 (status + validate + 에러 매핑) | **PASS** (친화 에러 카드 응답) |
| D | 진위 일치 (사용자 개업일 제공 시) | SKIP — `LUMI_BIZ_START_DATE=YYYYMMDD` 환경변수 필요 |

`/tmp/sprint1-business-verify-real.log` 참조. 사업자번호·대표자명은 마스킹 후 기록.

---

## 3. HMAC 한글 단위 테스트 (13건)

`node netlify/functions/_shared/__tests__/coupang-signature.test.js`

| # | 테스트 | 결과 |
|---|---|---|
| 1 | 한글 상품명 raw vs URL 인코딩 — 동일 서명 | PASS |
| 2 | 한글 path raw vs URL 인코딩 — 동일 서명 | PASS |
| 3 | 영문/한글 혼합 키 정렬 → 동일 서명 | PASS |
| 4 | 1바이트 오차 검출 — 한글 1글자 다르면 다른 서명 | PASS |
| 5 | 쿼리 정렬 — 입력 순서 무관 동일 서명 | PASS |
| 6 | 한글 키+값 — 수동 HMAC 계산과 일치 | PASS |
| 7 | UTF-8 인코딩 명시 — 한글 1바이트 오차 검출 | PASS |
| 8 | Canonical 형식 — datetime+method+path+query | PASS |
| 9 | 빈 query — 메시지에 query 부분 미포함 | PASS |
| 10 | datetime — 1자리 월/일/시 zero-pad | PASS |
| 11 | validateCoupangCredentials — 정상/이상 케이스 | PASS |
| 12 | normalizeQueryString — URL 디코딩 후 정렬 | PASS |
| 13 | normalizePath — URL 디코딩 | PASS |

**총: 13/13 PASS**

---

## 4. Puppeteer 시각 검증 (16건)

`node sprint1-verify/puppeteer.js http://localhost:8889`

모바일(375×812) + 데스크톱(1280×800) 각 8건, 총 16건 모두 PASS.

| 시나리오 | 모바일 | 데스크톱 |
|---|---|---|
| `/signup` 접속 | PASS | PASS |
| 다크모드 토글 작동 | PASS | PASS |
| Step 1 입력 → submit → Step 2 진입 | PASS | PASS |
| 쿠팡 TEST_OK 연결 (녹색 체크 표시) | PASS | PASS |
| Step 2 → Step 3 (말투 학습) | PASS | PASS |
| Step 3 → Step 4 (첫 등록 안내) | PASS | PASS |
| Step 4 → Step 5 (동의) | PASS | PASS |
| Step 5 동의 → 완료 화면 | PASS | PASS |

**총: 16/16 PASS**

스크린샷 위치: `.tmp-verify/sprint1-{mobile,desktop}-{step1,step1-filled,step2,step2-coupang-ok,step5,done}.png` (12장)

---

## 5. 모킹 토글 환경변수 명세

`.env.example` 참조. 베타 단계 기본값으로 모든 외부 API 호출을 스킵.

| 환경변수 | 기본값 | 효과 |
|---|---|---|
| `BUSINESS_VERIFY_MOCK` | `false` | **국세청 공공 API 실연동이 기본값**. true 시 형식+체크섬만 검증 (테스트용) |
| `PUBLIC_DATA_API_KEY` | (필수) | data.go.kr 공통 키. 사업자 진위확인 + 날씨/축제/대기 API 공유. 미설정 시 503 에러 |
| `COUPANG_VERIFY_MOCK` | `true` | 쿠팡 OPEN API 호출 스킵 + `TEST_OK`/`TEST_401`/`TEST_403`/`TEST_429`/`TEST_500` 시뮬레이션 |
| `NAVER_VERIFY_MOCK` | `true` | 네이버 커머스 API 호출 스킵 + 동일 TEST 패턴 적용 |
| `SIGNUP_MOCK` | `true` | Supabase/ENCRYPTION_KEY 미설정 환경에서 graceful 통과 (베타 검증용) |
| `JWT_SECRET` | (32자 이상 필수) | seller JWT 서명 키 |
| `LUMI_SECRET` | (임의값 OK) | admin/cron 보호용 |
| `ENCRYPTION_KEY` | (선택) | 자격증명 AES-256-GCM 암호화. base64(32바이트) 또는 hex 64자 |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | (선택) | 실연동 활성화 시만 |

**프로덕션 전환 절차**:
1. **사업자 인증** = `PUBLIC_DATA_API_KEY` 설정 + `BUSINESS_VERIFY_MOCK` 미설정 (또는 `false`) → **국세청 실연동 자동 활성**
2. **본인인증** (휴대폰 SMS) = Phase 1.5에서 PG 통합인증 별도 추가 (`birthDate`/`phone` 검증). Sprint 1 범위 외
3. 쿠팡/네이버 운영 키 발급 후 → `COUPANG_VERIFY_MOCK=false` / `NAVER_VERIFY_MOCK=false`
4. Supabase `SUPABASE_SERVICE_ROLE_KEY` + `ENCRYPTION_KEY` 설정 → `SIGNUP_MOCK=false`
5. SQL 마이그레이션 실행: `migrations/2026-04-27-sprint-1-sellers.sql`

---

## 6. 알려진 한계

| 한계 | 사유 | 대응 |
|---|---|---|
| 실제 쿠팡 OPEN API 시연 불가 | 운영 vendor 키 미보유, 베타 단계 모킹 정책 | `TEST_xxx` 패턴으로 4xx/5xx 친화 카드 검증 완료. 운영 키 발급 후 `COUPANG_VERIFY_MOCK=false`로 토글 |
| 실제 네이버 커머스 API 시연 불가 | 동일 | 동일 |
| 본인인증(휴대폰 SMS) 미구현 | NTS API는 b_no + p_nm + start_dt만 검증. 휴대폰·생년월일은 별도 PG 필요 | `birthDate`/`phone`은 형식 검증 + 입력만 받음. Phase 1.5에서 PG 통합인증 추가 (예: 토스/나이스/SOLAPI 본인인증) |
| 네이버 `bcrypt` 서명 미사용 | bcryptjs 의존성 추가 보류 | HMAC-SHA256 fallback로 작동. 운영 활성화 시 bcryptjs 설치하고 `generateNaverSign` 교체 |
| Supabase 마이그레이션 미실행 | worktree 격리 환경 | `SIGNUP_MOCK=true`로 graceful 통과. 메인 머지 후 `migrations/2026-04-27-sprint-1-sellers.sql` 실행 필요 |
| `tone_samples` 테이블 미생성 | Sprint 1 범위 외 | `signup-tone-samples.js`가 `audit_logs`에 fallback 저장. Sprint 2에서 정식 테이블 추가 |

---

## 7. 메인 머지 권고 + 사용자 검증 필요 항목

### 메인 머지 가능 (사업자 인증 = 국세청 실연동, 마켓 = 모킹)

- **사업자 인증 = 국세청 공공 API 실연동 완료** — `BUSINESS_VERIFY_MOCK=false` 기본값
- 모든 게이트 통과 (13/13 + HMAC 13 + Puppeteer 16 = 42/42) → 베타 셀러가 가입 완료까지 흐름을 끝낼 수 있음
- 외부 마켓 API(쿠팡·네이버) 미연동이지만 친화 에러 카드/가이드 deep link 작동 검증 완료
- 보안: 평문 시크릿 노출 0건, 경쟁사명 0건, 보라/Inter/Roboto/Arial 0건

### 사용자(김현)가 직접 점검할 항목

1. **`PUBLIC_DATA_API_KEY` Netlify 환경변수 확인** — 이미 설정됨 (활용신청 승인 완료). 사업자 인증 외 날씨/축제/대기 API 공유
2. **본인인증(휴대폰 SMS) PG 발주** — Phase 1.5에서 토스/나이스 본인인증 통합. NTS API는 사업자 진위만 확인하므로 휴대폰·생년월일은 별도 검증 필요
3. **쿠팡/네이버 운영 vendor·application 키 발급**
4. **Supabase 마이그레이션 실행** — Supabase SQL Editor에서 `migrations/2026-04-27-sprint-1-sellers.sql` 실행
5. **`ENCRYPTION_KEY` 운영 환경변수 설정** — `openssl rand -base64 32` 결과를 Netlify 환경변수에 추가
6. **`JWT_SECRET` 운영 환경변수 교체** — `.env.example`의 placeholder가 아닌 32자 이상 시크릿
7. **`/signup` pretty URL을 main 도메인에 노출 시점 결정** — 정식 오픈 시 `index.html`에 가입 진입 CTA 노출
8. **루미 본인 사업자번호로 진위 일치 검증** — `LUMI_BIZ_START_DATE=YYYYMMDD node sprint1-verify/business-verify-real.js` 실행 (개업일은 사업자등록증 확인)
9. **모바일 캡처 12장 시각 검증** — `.tmp-verify/sprint1-mobile-*.png` 직접 확인

---

## 8. 다음 스프린트로 미루는 항목

- **Step 4 첫 상품 등록** — Sprint 1은 UI 미리보기로만 노출. Sprint 2에서 사진 업로드 + GPT-4o 카피 생성 통합
- **`tone_samples` 정식 테이블** — Sprint 1은 `audit_logs` fallback. Sprint 2에서 20개 롤링 윈도우 + 이연 평가 연결
- **카카오 로그인 통합** — 가입 완료 후 자동 로그인 미구현. 현재는 `/api/me`로 token 검증만
- **셀러 알림(SOLAPI)** — 가입 완료 시 환영 알림톡 미발송
- **PortOne 결제 연결** — 7일 트라이얼 후 정기결제 등록 흐름 미구현
- **관리자 페이지** — `market_guide_links` URL/text 갱신 UI 미구현
- **Phase 2 권한 모니터링** — 7일 단위 자동 권한 확인 cron 미구현 (수동 트리거만 가능)

---

## 부록: 커밋 이력

```
(신규)  feat: Sprint 1 사업자 인증 — 국세청 공공 API 실연동 (NTS status + validate)
4d72b0c test: Sprint 1 12 검증 게이트 자동화 + Puppeteer 시연
b451dd1 chore: Sprint 1 netlify.toml 라우트 + .env.example + HMAC 한글 단위 테스트
2fd9576 feat: Sprint 1 Supabase 마이그레이션 (sellers + market_credentials + audit_logs)
a985da3 feat: Sprint 1 에러 번역 + Deep Link API + 가입 완성 endpoint
31dabd3 feat: Sprint 1 마켓 OAuth + HMAC 서버사이드 + Permission Check
9e6c8ef feat: Sprint 1 가입 5단계 흐름 + 사업자 인증 모킹
```

총 7 commits, 27 신규 + 2 수정 파일, ~5,800 라인.

---

**최종 검증 시각**: 2026-04-27 (NTS 실연동 추가)
**자동 게이트 합계**: **57/57 PASS** (13 verify + 13 HMAC + 15 business-verify 단위 + 16 Puppeteer)
**상태**: 메인 머지 가능 (사업자 인증 = 국세청 실연동, 마켓 = 모킹. 운영 전환 시 환경변수 3종만 토글)
