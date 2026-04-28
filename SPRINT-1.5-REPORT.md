# Sprint 1.5 — 마켓 OAuth 위자드 강화 (보고서)

**브랜치**: `feature/sprint-1.5-oauth-wizard` (베이스 = `feature/sprint-2-first-product`)
**워크트리**: `/Users/kimhyun/lumi.it/.worktrees/sprint-1.5-oauth-wizard`
**작업 일자**: 2026-04-28
**최종 검증**: 단위 28 + verify 8 + Puppeteer 14 = **50/50 PASS**

---

## 0. 사용자 결정 사항 (메모리 그대로 구현)

> "고객이 느끼는 어려움 = 자동화 안 돼서가 아니라 '내가 지금 제대로 하고 있나' 확신이 없어서"
> 메모리 `project_market_oauth_wizard_ux.md`

**연동 위자드 = 사방넷이 못 한 자리, 루미 차별화 핵심.** 마켓 OAuth 단계 안에 미세 5단계 위자드 + 마스코트 + Smart Clipboard로 셀러를 내비게이션처럼 안내.

| 사방넷 | 루미 |
|---|---|
| "키 발급은 알아서" | "쿠팡 키 발급하러 가요 → Deep Link 새 탭" |
| 셀러가 붙여넣기 | Smart Clipboard 자동 감지 + 1탭 입력 |
| 5단계 어디인지 모름 | 미세 진행 바 + "앞으로 30초" + 단계별 마스코트 표정 |

---

## 1. 신규·정정 파일

### 신규 (6개)

| 영역 | 파일 | 라인 |
|---|---|---|
| 컴포넌트 | `js/components/ClipboardDetector.js` | 220 |
| 마이그 | `migrations/2026-04-28-sprint-1.5-guide-links.sql` | 86 |
| 테스트 | `netlify/functions/_shared/__tests__/sprint-1.5-clipboard.test.js` | 280 |
| 검증 | `sprint1.5-verify/mini-server.js` | 156 |
| 검증 | `sprint1.5-verify/verify.js` | 200 |
| 검증 | `sprint1.5-verify/puppeteer.js` | 175 |

### 정정 (3개)

| 파일 | 변경 |
|---|---|
| `signup.html` | STEP 2 안에 미세 위자드 5단계 마크업 + Smart Clipboard 팝업 (쿠팡·네이버 각 5 paneset, 진행 바, 마스코트 슬롯) |
| `js/onboarding.js` | `initStep2()` 미세 위자드 상태 머신으로 재작성. `setMicroStep` / `setValidatePhase` / `showClipboardPopup` / `startClipboardDetector` / Progressive Validation 3-Phase 시각화 |
| `css/onboarding.css` | `.micro-wizard / .micro-progress / .micro-mascot-row / .micro-validate / .micro-success / .clipboard-popup / .clipboard-filled` 약 220줄 추가 |

**총 신규/수정 라인 ≈ 1,750줄**

---

## 2. 검증 게이트 결과 — 50/50 PASS

### 2.1 단위 테스트 (28/28)
`node netlify/functions/_shared/__tests__/sprint-1.5-clipboard.test.js`

| 영역 | 테스트 수 | PASS |
|---|---|---|
| ClipboardDetector 모듈 export | 1 | 1 |
| detectKind: 쿠팡 (vendorId/accessKey/secretKey/트림/길이/null) | 9 | 9 |
| detectKind: 네이버 (applicationId/applicationSecret) | 2 | 2 |
| maskValue: Secret 마스킹 + ID 보존 | 5 | 5 |
| 환경 체크 (isClipboardSupported / isIOSSafari × 3) | 4 | 4 |
| createDetector 인스턴스 동작 | 2 | 2 |
| KIND_LABELS 한글 라벨 | 1 | 1 |
| market-guides 응답 (fallback / 400 / 405 / OPTIONS / 전체) | 5 | 5 |
| **합계** | **28** | **28** |

### 2.2 verify.js 게이트 (8/8)
`node sprint1.5-verify/verify.js http://localhost:8891`

| # | 게이트 | 결과 | 상세 |
|---|---|---|---|
| 1 | market_guide_links 마이그레이션 멱등 + estimated_seconds + 시드 7+ | PASS | alter=true upsert=true stepKeys=7 |
| 2 | /api/market-guides 응답 일관성 | PASS | guides=2 allCoupang=true hasUrl=true |
| 3 | Deep Link external_url HTTPS + 화이트리스트 | PASS | guides=4 allHttps=true (wing.coupang.com / apicenter.commerce.naver.com) |
| 4 | ClipboardDetector.js 정적 서빙 + 핵심 함수 포함 | PASS | detector/readText/mask/patterns/create 전부 OK |
| 5 | 미세 5단계 위자드 + 마스코트 + Clipboard popup 마크업 | PASS | wizard/5steps/panes5/mascot/popup/script 전부 OK |
| 6 | CSS 미세 위자드 + popup + 자동입력 시각피드백 | PASS | progress/mascot/validate/popup/flash 전부 OK |
| 7 | onboarding.js 미세 위자드 상태 머신 + 마스코트 5종 + Clipboard 통합 | PASS | state/mascot5/clipboard/validate 전부 OK |
| 8 | 단위 테스트 통합 실행 (28개) | PASS | 28/28 PASS |

결과 JSON: `/tmp/sprint1.5-verify-result.json`

### 2.3 Puppeteer 시연 (14/14)
`NODE_PATH=/Users/kimhyun/lumi.it/node_modules node sprint1.5-verify/puppeteer.js http://localhost:8891`

모바일 (375×812) + 데스크톱 (1280×800) 각 7단계 모두 PASS.

| 시나리오 | 모바일 | 데스크톱 |
|---|---|---|
| `/signup` 200 + STEP1 표시 | PASS | PASS |
| 모킹 가입 → STEP2 진입 | PASS | PASS |
| 쿠팡 카드 클릭 → 미세 5단계 위자드 표시 | PASS | PASS |
| 단계 1 → 2 (Deep Link 새 탭 호출) | PASS | PASS |
| 단계 2 → 3 (입력 단계 진입, 3개 input) | PASS | PASS |
| 키 입력 → 검증 → 완료 (마스코트 wink) | PASS | PASS |
| 네이버 미세 위자드 5단계 마크업 | PASS | PASS |

스크린샷: `.tmp-verify-1.5/sprint1.5-{mobile,desktop}-{01..07}-*.png`
결과 JSON: `/tmp/sprint1.5-puppeteer-result.json`

### 2.4 회귀 테스트 — Sprint 2 단위 (26/26)
`node netlify/functions/_shared/__tests__/sprint-2-adapters.test.js`
**Sprint 2 단위 26/26 PASS 그대로 유지.** Sprint 1.5는 신규 컴포넌트만 추가하고 기존 어댑터·정책·throttle·retry는 손대지 않음.

---

## 3. 핵심 구현 디테일

### 3.1 Deep Link DB
- `market_guide_links` 테이블은 Sprint 1 마이그레이션에 이미 정의되어 있음 (UNIQUE market+step_key)
- Sprint 1.5 마이그레이션은 **`estimated_seconds` 컬럼 추가** + **위자드 5단계 시드 보강**만 처리
- 멱등 (`ON CONFLICT (market, step_key) DO UPDATE`)
- 정책 변경 시 관리자 SQL UPDATE 한 줄로 모든 셀러에 즉시 반영

### 3.2 Smart Clipboard Detector (보안)
- **권한 명시 동의**: `navigator.clipboard.readText()` Promise — 거부 시 silent fail
- **자동 입력 X**: 항상 셀러 [예/아니오] 컨펌 popup
- **Secret Key 마스킹**: popup에서 `aGVs••••aA==` 형식, 실제 input에는 평문 (HTTPS로 서버 전송, 서버에서 암호화)
- **iOS Safari 폴백**: Web Clipboard API 권한 정책 다름 → 일반 입력 폼으로 폴백
- **visibility 자동 트리거**: `document.visibilitychange` → 셀러가 마켓 탭에서 돌아오는 순간 자동 체크
- **중복 처리 방지**: 같은 값 1.5초 cooldown
- **패턴**:
  - 쿠팡: vendorId `A\d{8,12}` / accessKey hex 32~64 또는 dash 형식 / secretKey base64 40~80
  - 네이버: applicationId 12~40자 / applicationSecret bcrypt `$2[ayb]$..$..` 또는 base64 폴백

### 3.3 미세 5단계 위자드 (위자드 안의 위자드)
- 진행 바 = 5개 점 + 4개 라인 (현재 단계 핑크 그라데이션 강조 + scale 1.08 + 그림자, 완료 단계 녹색 체크)
- 마스코트 단계별 표정:
  - 1/5: lumi-curious (호기심·시작)
  - 2/5: lumi-character (안내)
  - 3/5: lumi-surprised-2 (감지)
  - 4/5: lumi-character (확인)
  - 5/5: lumi-wink (완료)
- 시간 안내: "예상 소요 30초" → "앞으로 약 20초" → ... → "완료"

### 3.4 Progressive Validation 3-Phase
단계 4(검증) 안에서 시각화:
- Phase 1 (즉시 250ms): 형식 체크 — 클라이언트 정규표현식
- Phase 2 (0.5초): API 인증 — `connect-coupang` / `connect-naver`
- Phase 3 (백그라운드): 권한 체크 — `triggerPermissionCheck` (셀러를 막지 않음)

각 Phase의 row는 active(spin) → done(check) → fail(x) 상태 전환.

---

## 4. 카피 톤 (메모리 부합 검증)

| 항목 | 카피 |
|---|---|
| 친근 안내 | "쿠팡 키 발급하러 가요" / "두 키를 복사하셨나요?" |
| 자동 입력 | "복사하신 키를 발견했어요" / "예, 입력해 주세요" |
| 검증 | "확인 중이에요, 잠시만요" |
| 완료 | "쿠팡 연결 완료! 다음은 네이버" |
| 시간 명시 | "예상 소요 30초" / "앞으로 약 20초" |

메모리 `feedback_advertising_truth_principle.md` 시간 ±50% 과장 허용 범위 내.

---

## 5. 5대 마켓 연동 원칙 적용 상태

메모리 `feedback_market_integration_principles.md`

| 원칙 | Sprint 1·2에서 구현 | Sprint 1.5에서 강화 |
|---|---|---|
| ① 권한 검증 분리 | `triggerPermissionCheck` 백그라운드 | Phase 3 시각화 (셀러를 막지 않음) |
| ② Progressive 3-Phase | `connect-coupang` 단계별 응답 | UI 시각화 + 활성·완료·실패 row |
| ③ Deep Link + DB | `market_guide_links` 테이블 + fallback | 위자드 5단계 시드 보강 + estimated_seconds |
| ④ HMAC 서버 사이드 | `_shared/coupang-signature.js` | 클라이언트 시크릿 노출 제로 (popup도 마스킹) |
| ⑤ 친화 에러 번역 | `_shared/market-errors.js` 매핑 | Phase 2 fail 시 single-line cause + deepLink 토스트 |

---

## 6. 절대 금지 사항 준수 확인

- [x] 메인 직접 수정 X (worktree에서만 작업)
- [x] 클라이언트 시크릿 키 노출 X (popup에서 즉시 마스킹)
- [x] 보라/Inter/Roboto/Arial/이모지 X
- [x] 매출 % 카피 X
- [x] 경쟁사 직접 비교 X
- [x] "AI가 모든 걸" 같은 과장 X

---

## 7. 메인 머지 권고

### 권고: **머지 가능** (단, 사용자 결정 사항)

근거:
1. 검증 50/50 PASS — 단위 28 + verify 8 + Puppeteer 14
2. Sprint 2 회귀 26/26 PASS 그대로 유지
3. 메모리 `feedback_phase2_quality_gates.md` 3단 검증 게이트 통과 (executor → 본 보고서 → 사용자 최종)
4. 마이그레이션 `2026-04-28-sprint-1.5-guide-links.sql`은 멱등 — 운영 DB에 그대로 적용 가능

### 머지 전 사용자 확인 사항
- 신규 보호 정책 (CSP)에서 `navigator.clipboard.readText` 차단 여부 확인 (현재 `netlify.toml`은 `Permissions-Policy`에서 clipboard 명시 없음 = 기본값 = 동작)
- 사업자 등록증 업로드 시점에는 인스타와 무관 — 영향 없음

### 다음 스프린트 후보 (본 작업 범위 외)
- 관리자 페이지 `/admin/guides` UI: `market_guide_links` CRUD (정책 변경 즉시 반영용)
- ClipboardDetector 가시성 polling 외에 입력 칸 focus 시 트리거 추가
- iOS Safari 전용 "키 붙여넣기 버튼" UI (권한 폴백)

---

## 8. 실행 명령 모음

```bash
# 미니 서버 (Sprint 1.5 검증용 — 8891 포트)
cd /Users/kimhyun/lumi.it/.worktrees/sprint-1.5-oauth-wizard
node sprint1.5-verify/mini-server.js 8891 &

# 단위 테스트
node netlify/functions/_shared/__tests__/sprint-1.5-clipboard.test.js

# 검증 게이트 (8개)
node sprint1.5-verify/verify.js http://localhost:8891

# Puppeteer 시연 (메인 레포의 puppeteer 모듈 사용)
NODE_PATH=/Users/kimhyun/lumi.it/node_modules \
  node sprint1.5-verify/puppeteer.js http://localhost:8891

# 회귀 테스트 (Sprint 2)
node netlify/functions/_shared/__tests__/sprint-2-adapters.test.js
```

---

**Sprint 1.5 완료. 메인 머지는 김현님 결정.**
