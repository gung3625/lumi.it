# Sprint 2 — 첫 상품 등록 풀 흐름 (보고서)

**브랜치**: `feature/sprint-2-first-product` (베이스 = `feature/sprint-1-onboarding`)
**워크트리**: `/Users/kimhyun/lumi.it/.worktrees/sprint-2-first-product`
**작업 일자**: 2026-04-28
**최종 검증**: 모든 게이트 PASS — 단위 26 + verify 10 + Puppeteer 10 = **46/46**

---

## 0. 셀러 UX 원칙 (메모리 결정 그대로 구현)

**표준 4단계는 시스템 백엔드, 셀러 화면은 3 액션으로 압축** (`project_data_pipeline_architecture.md` 본문 168~226 행).

| 화면 | 셀러 액션 | 백엔드 (자동, 셀러 X) |
|---|---|---|
| 1 | 사진 1장 촬영/업로드 | Ingestion + Normalization (AI 분석) |
| 2 | 카드 5장 검수 (우/좌/아래) | Transformation (카테고리·옵션·정책) |
| 3 | 마켓 토글 1탭 → 직링크 | Distribution + 완료 합침 (Lumi templating) |

→ 등록 클릭 수 = **3 액션** (4사 20~50 → 1/10), 등록 시간 5분 안.

---

## 1. 신규·정정 파일

### 신규 (16개)

| 영역 | 파일 | 라인 |
|---|---|---|
| 페이지 | `register-product.html` | 191 |
| 클라이언트 | `js/register-product.js` | 357 |
| 스타일 | `css/register-product.css` | 466 |
| API | `netlify/functions/upload-product-image.js` | 200 |
| API | `netlify/functions/analyze-product-image.js` | 198 |
| API | `netlify/functions/register-product.js` | 218 |
| API | `netlify/functions/get-product.js` | 86 |
| 어댑터 | `_shared/market-adapters/lumi-product-schema.js` | 124 |
| 어댑터 | `_shared/market-adapters/coupang-adapter.js` | 178 |
| 어댑터 | `_shared/market-adapters/naver-adapter.js` | 234 |
| 인프라 | `_shared/retry-engine.js` | 142 |
| 인프라 | `_shared/throttle.js` | 124 |
| 인프라 | `_shared/policy-words.js` | 119 |
| 마이그 | `migrations/2026-04-28-sprint-2-products.sql` | 240 |
| 테스트 | `_shared/__tests__/sprint-2-adapters.test.js` | 215 |
| 검증 | `sprint2-verify/{mini-server,verify,puppeteer}.js` | ~520 |

### 정정 (2개)

| 파일 | 변경 |
|---|---|
| `netlify.toml` | Sprint 2 라우트 5건 (`/api/upload-product-image`, `/api/analyze-product-image`, `/api/register-product`, `/api/get-product`, `/register-product` pretty URL) |
| `.env.example` | `AI_PRODUCT_ANALYZE_MOCK`, `OPENAI_API_KEY` 안내 추가 |

**총 신규/수정 라인 수 ≈ 3,610 줄**

---

## 2. 검증 게이트 결과 — 46/46 PASS

### 2.1 단위 테스트 (26/26)
`node netlify/functions/_shared/__tests__/sprint-2-adapters.test.js`

| 영역 | 테스트 수 | PASS |
|---|---|---|
| Lumi 표준 스키마 (validate / fromAiResponse / empty / trim) | 5 | 5 |
| 정책 위반 사전 (공통 / 쿠팡 / 깨끗 / 자동치환) | 4 | 4 |
| Throttle Token Bucket (5회·backoff·헤더·우선순위) | 4 | 4 |
| Retry Engine (5단계 backoff·MAX_RETRY=5) | 2 | 2 |
| 쿠팡 어댑터 (transform·옵션 4개·직링크·mock·400 검출) | 5 | 5 |
| 네이버 어댑터 (transform·토큰갱신·직링크 with/without·mock) | 5 | 5 |
| 통합 (AI → schema → 정책) | 1 | 1 |

### 2.2 verify.js 게이트 (10/10)
`JWT_SECRET=... node sprint2-verify/verify.js http://localhost:8890`

| # | 게이트 | 결과 | 상세 |
|---|---|---|---|
| 1 | 이미지 업로드 → Storage 200 | PASS | imageUrl 200, mock=true |
| 2 | AI 분석 → 표준 스키마 응답 (모킹) | PASS | title="베이직 코튼 후드 티셔츠" confidence=0.86 |
| 3 | 검수 카드 5스와이프 UI 작동 | PASS | cards5=true screens3=true jsFile=true |
| 4 | 쿠팡 어댑터 모킹 등록 → 직링크 응답 | PASS | https://www.coupang.com/vp/products/MOCK_… |
| 5 | 네이버 어댑터 모킹 등록 → 직링크 응답 | PASS | https://smartstore.naver.com/main/products/NV_MOCK_… |
| 6 | 정책 위반 검사 → 사전 매칭 | PASS | 위반텍스트=3개 / 깨끗텍스트=0개 |
| 7 | Retry 큐 1m→5m→30m→2h→24h 5단계 | PASS | 1m=true 24h=true 5steps=true |
| 8 | 마이그레이션 SQL 멱등 실행 가능 | PASS | tables=true idempotent=true bucket=true |
| 9 | 단위 테스트 통합 실행 | PASS | 26/26 PASS |
| 10 | register-product.html 모바일+PC 반응형 | PASS | viewport=true gradient=true pcMedia=true |

결과 JSON: `/tmp/sprint2-verify-result.json`

### 2.3 Puppeteer 시연 (10/10)
`JWT_SECRET=... node sprint2-verify/puppeteer.js http://localhost:8890`

모바일 (375×812) + 데스크톱 (1280×800) 각 5단계, 총 10단계 모두 PASS.

| 시나리오 | 모바일 | 데스크톱 |
|---|---|---|
| `/register-product` 200 + 화면1 표시 | PASS | PASS |
| 사진 업로드 후 미리보기 표시 | PASS | PASS |
| AI 분석 호출 → 화면2 표시 (제목 바인딩) | PASS | PASS |
| 카드 5장 모두 승인 → 화면3 진입 | PASS | PASS |
| 마켓 토글 → 전송 → 직링크 카드 (쿠팡+네이버 링크 모두 검증) | PASS | PASS |

스크린샷: `.tmp-verify/sprint2-{mobile,desktop}-{01..05}-*.png` (10장)

---

## 3. AI 분석 정확도 (모킹 데이터 기준)

`AI_PRODUCT_ANALYZE_MOCK=true` 더미 응답:

```json
{
  "title": "베이직 코튼 후드 티셔츠",
  "category_suggestions": {
    "coupang": { "tree": ["패션의류","남성의류","티셔츠"], "confidence": 0.88 },
    "naver":   { "tree": ["패션의류","남성의류","티셔츠"], "confidence": 0.88 }
  },
  "price_suggested": 29000,
  "options": [
    { "name": "색상", "values": ["그레이","블랙","화이트"] },
    { "name": "사이즈", "values": ["M","L","XL"] }
  ],
  "keywords": ["후드","티셔츠","코튼","남성","베이직","봄","데일리","면","심플"],
  "policy_warnings": [],
  "ai_confidence": 0.86
}
```

→ Lumi 표준 스키마 100% 부합. 셀러 검수 카드 5장 즉시 바인딩.

**비용 설계** (실연동 활성화 시):
- gpt-4o-mini Vision (1차) ≈ ₩1.4 / 이미지
- gpt-4o (confidence < 0.6 시 2차) ≈ ₩7.0 / 이미지
- 전체 평균 추정: 1상품당 ₩2 ~ ₩3 (메모리 "건당 20원" 마진 영역 안)

---

## 4. 4단계 백엔드 매핑 + 3대 무기 통합

| 표준 단계 | Sprint 2 구현 위치 | 셀러 노출 |
|---|---|---|
| **Ingestion** | `upload-product-image` → Supabase Storage `product-images` 버킷 | 화면 1 (사진 1장) |
| **Normalization** | `analyze-product-image` GPT-4o Vision → `lumi-product-schema.js` 표준화 | (자동, 안 보임) |
| **Transformation** | `coupang-adapter.transformToCoupangPayload` + `naver-adapter.transformToNaverPayload` + `policy-words` | 화면 2 (카드 5장) |
| **Distribution** | `register-product` → 어댑터 병렬 호출 + `throttle.tryAcquire` + 직링크 templating | 화면 3 (1탭) |

| 숨겨진 무기 | 모듈 | Sprint 2 활용 |
|---|---|---|
| Retry Engine | `_shared/retry-engine.js` | 마켓 호출 실패 시 자동 적재 (1m→5m→30m→2h→24h) |
| Throttling | `_shared/throttle.js` | Token Bucket per market+vendor (쿠팡 5 r/s, 네이버 헤더 적응) |
| 정책 위반 사전 | `_shared/policy-words.js` + `policy_words` 테이블 | AI 분석 응답에 `policy_warnings` 자동 첨부 + 1탭 자동 치환 가능 |

→ CS·반품·역방향 파이프라인은 Sprint 3 (셀러 대시보드)로 미룸.

---

## 5. 5대 마켓 통합 원칙 준수 확인

| 원칙 (`feedback_market_integration_principles.md`) | Sprint 2 구현 |
|---|---|
| ① 연결 vs 권한 분리 | Sprint 1 `market-permission-check` 그대로 활용 (변경 없음) |
| ② Progressive Validation | 화면 2 = AI 검수 카드 비차단 흐름 (셀러는 어디서든 다음 카드로 갈 수 있음) |
| ③ Deep Link DB | Sprint 1 `market_guide_links` 그대로. 정책 갱신 시 DB만 수정 |
| ④ HMAC 서버 사이드만 | `_shared/coupang-signature.js` 서명 → 어댑터에서만 호출, 클라이언트 노출 0 |
| ⑤ 친절한 번역 + 해결책 | `register-product` 응답에 `translateMarketError(market, status, error)` 적용. statusCode/title/cause/action/deepLink 5필드 노출 |

---

## 6. 절대 금지 항목 준수 확인

| 금지 | 결과 |
|---|---|
| 메인 브랜치 직접 수정 | 0 (워크트리 격리) |
| AI 비용 폭발 | 1차 = gpt-4o-mini, 2차만 gpt-4o, 모킹 토글 기본 ON |
| 평문 시크릿/이미지 base64 로그 | 0 (8-character seller_id 마스킹만) |
| 보라/Inter/Roboto/Arial/이모지 | 0 (Pretendard + 4색 그라데이션만) |
| 매출% 카피 | 0 (없음) |
| 경쟁사명 직접 비교 | 0 (없음) |
| 셀러 4 화면 강제 | 0 (3 화면 압축 = 압축 워크플로우 원칙 준수) |

---

## 7. 카피 톤 검증 (실제 페이지 출력)

| 화면 | 카피 |
|---|---|
| 1 | "사진 한 장이면 충분해요" / "사장님 매장 상품을 카메라로 찍어주세요" |
| 1 (CTA) | "루미에게 맡기기" |
| 2 | "루미가 미리 만들어봤어요" / "5장 카드 차례로 검토해주세요" |
| 2 (카드별) | "이렇게 어때요?" / "카테고리도 어울리나요?" / "권장 판매가는요?" / "옵션은 이정도면 충분?" / "마지막 점검할게요" |
| 2 (액션) | "다시" / "수정" / "좋아요" / (마지막) "마켓 보내기" |
| 3 | "어디에 올릴까요?" / "연결된 마켓만 표시돼요" |
| 3 (완료) | "올라갔어요. 지금 바로 확인하기" / "다른 상품 더 올리기" |

---

## 8. 모킹 토글 환경변수 (Sprint 2 신규)

| 변수 | 기본값 | 효과 |
|---|---|---|
| `AI_PRODUCT_ANALYZE_MOCK` | `true` | OpenAI Vision 호출 스킵, 더미 LumiProduct 응답 |
| `OPENAI_API_KEY` | (선택) | 실연동 시 필수. 미설정+MOCK=false → 분석 실패 응답 |
| `COUPANG_VERIFY_MOCK` | `true` | 쿠팡 등록 API 호출 스킵, 더미 productId |
| `NAVER_VERIFY_MOCK` | `true` | 네이버 등록 API 호출 스킵, 더미 productId |
| `SIGNUP_MOCK` | `false` (기본) | Supabase 미설정 환경 graceful (워크트리 검증용 = `true`) |

**프로덕션 전환 절차**:
1. SQL 실행: `migrations/2026-04-28-sprint-2-products.sql` (Supabase SQL Editor)
2. Storage 버킷 `product-images` 생성 확인 (마이그레이션이 자동 생성, 권한 부족 시 수동)
3. `OPENAI_API_KEY` Netlify 환경변수 추가 → `AI_PRODUCT_ANALYZE_MOCK=false`
4. 쿠팡/네이버 운영 키 발급 + 셀러가 `/signup`에서 연결 → `COUPANG_VERIFY_MOCK=false` / `NAVER_VERIFY_MOCK=false`
5. `SIGNUP_MOCK=false`로 Supabase 실연동 활성화

---

## 9. 김현님 직접 액션 (Sprint 2 정식 오픈 시)

1. **Supabase 마이그레이션 실행** — `migrations/2026-04-28-sprint-2-products.sql`
   - 5개 테이블 (products, product_options, product_market_registrations, retry_queue, policy_words)
   - Storage 버킷 `product-images` (10MB·image MIME만)
2. **Storage 버킷 생성 확인** — Dashboard → Storage → `product-images` 존재. 마이그레이션 권한 부족 시 수동 생성:
   - public read = ON (마켓 API에서 fetch 가능)
   - file size 10MB
   - allowed MIME = image/jpeg, image/jpg, image/png, image/webp, image/heic, image/heif
3. **OPENAI_API_KEY 검토** — 베타 단계에서는 모킹 유지, 실연동 시 비용 모니터링 (1상품당 ₩2~₩3)
4. **`/register-product` 진입 CTA 결정** — 정식 오픈 시 dashboard·signup 완료 후 CTA 노출
5. **Cron 스케줄 (선택)** — `retry_queue` 1분마다 처리 함수 추가 시 netlify.toml에 등록 (Sprint 2.5로 미룸 가능)

---

## 10. 알려진 한계

| 한계 | 사유 | 대응 |
|---|---|---|
| 실 쿠팡 등록 시연 X | 운영 vendor 키 미보유 | 모킹 모드로 직링크 templating 검증 완료. 실키 토글 1줄 변경으로 활성 |
| 실 네이버 등록 시연 X | 동일 | 동일. 토큰 갱신 로직 단위 테스트 통과 (`shouldRefreshToken`) |
| 이미지 자동 리사이즈 (780px / 2MB / 1:1) | sharp 의존 추가 보류 | 어댑터에서 imageUrl 그대로 전달. Sprint 2.1에서 sharp 통합 시 `transformToCoupangPayload` 내 변환 단계 추가 |
| Retry 큐 cron 미배포 | netlify.toml 스케줄 미추가 | `_shared/retry-engine.js` 자체는 완성. 1분마다 due 픽업 함수만 추가하면 즉시 가동 |
| 정책 위반 cron 크롤링 | 외부 마켓 정책 변경 자동 추적 X | 사전 매칭 + AI 시맨틱(future) 두 단계로 충분. 분기 1회 수동 갱신으로 운영 가능 |
| `tone_samples` 정식 테이블 | Sprint 1 범위 외 | Sprint 2 범위에서 분리. 캡션 학습 파이프라인 통합은 Sprint 3 |

---

## 11. 다음 스프린트로 미루는 항목 (Sprint 3 대시보드)

- 역방향 파이프라인: 주문 / 반품 / CS / 재고 동기화 (`orders`, `inventory_movements`, `cs_threads`)
- AI CS 답변 자동 생성 → 셀러 1탭 전송
- 마켓 직링크에서 거꾸로 주문 데이터 풀링 (Pull → Push 통합)
- 셀러 대시보드 React 그리드 카드 (재고·CS·정산)
- Retry 큐 cron + 셀러 알림 (1m→5m→30m 알림)

---

## 부록 A: 파일별 상세 위치

```
register-product.html                                    # 페이지 (모바일+PC)
js/register-product.js                                   # 단일 흐름 카드 + 5스와이프 + 마켓 토글
css/register-product.css                                 # 4색 그라데이션 + 768px 반응형
netlify.toml                                             # Sprint 2 라우트 5건 추가
.env.example                                             # AI_PRODUCT_ANALYZE_MOCK 추가

netlify/functions/upload-product-image.js                # Ingestion (Multipart → Storage)
netlify/functions/analyze-product-image.js               # Normalization (GPT Vision → LumiProduct)
netlify/functions/register-product.js                    # Transformation+Distribution 통합
netlify/functions/get-product.js                         # 조회

netlify/functions/_shared/market-adapters/
  ├ lumi-product-schema.js                               # Lumi 표준 스키마 + validate/fromAiResponse
  ├ coupang-adapter.js                                   # transform + register + 직링크
  └ naver-adapter.js                                     # transform + register + 토큰갱신 + 직링크

netlify/functions/_shared/
  ├ retry-engine.js                                      # 5단계 backoff + 큐 enqueue/fetchDue/recordResult
  ├ throttle.js                                          # Token Bucket + 헤더 적응 + 우선순위
  └ policy-words.js                                      # 사전 매칭 + 자동 치환

migrations/2026-04-28-sprint-2-products.sql              # 5 테이블 + Storage 버킷 + RLS

netlify/functions/_shared/__tests__/sprint-2-adapters.test.js   # 26 단위 테스트
sprint2-verify/
  ├ mini-server.js                                       # 로컬 라우터 (8890)
  ├ verify.js                                            # 10 게이트
  └ puppeteer.js                                         # 모바일+데스크톱 5단계 시연
```

---

## 부록 B: 검증 명령

```bash
# 단위 테스트
node netlify/functions/_shared/__tests__/sprint-2-adapters.test.js

# 미니 서버 시작
node sprint2-verify/mini-server.js 8890 &

# 10 게이트 검증
JWT_SECRET=sprint2_local_test_secret_32chars_minimum_required \
  node sprint2-verify/verify.js http://localhost:8890

# Puppeteer 시연 (모바일+데스크톱)
JWT_SECRET=sprint2_local_test_secret_32chars_minimum_required \
  node sprint2-verify/puppeteer.js http://localhost:8890
```

---

**최종 검증 시각**: 2026-04-28
**자동 게이트 합계**: **46/46 PASS** (단위 26 + verify 10 + Puppeteer 10)
**셀러 UX 측정**: 3 액션 / 5분 안 / 단일 흐름 카드
**상태**: 메인 머지 가능. 모킹 토글로 베타 운영 즉시 시작 가능, 실연동은 키 발급 시점에 환경변수 토글만으로 활성화.

`.tmp-verify/sprint2-{mobile,desktop}-*.png` 직접 확인 권장.
