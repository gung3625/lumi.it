# AI 정보고시 자동 생성 — 설계 계획

> 작성일: 2026-04-29 | 상태: 설계 완료 — executor 위임 대기

---

## 1. 데이터셋 결정

**출처**: 공정위 고시 원문 (법제처 law.go.kr) — "전자상거래등에서의 상품등의 정보제공에 관한 고시" 별표.

**Phase A 대상 카테고리 (6종)**:
| # | 카테고리 | 필수 항목 수 (약) | 비고 |
|---|---------|-----------------|------|
| 1 | 의류 | 9 | 소재, 세탁방법, 제조국 등 |
| 2 | 식품 (농수축산물) | 11 | 원산지, 유통기한, 영양성분 등 |
| 3 | 화장품 | 10 | 전성분, 용량, 사용기한 등 |
| 4 | 전자제품/생활가전 | 10 | KC 인증번호, 정격전압 등 |
| 5 | 생활용품 | 8 | 품명, 재질, 제조국 등 |
| 6 | 잡화/가방/신발 | 8 | 소재, 제조국 등 |

**저장 방식**: `netlify/functions/_shared/info-disclosure-schema.js` — JS 객체로 hardcode.
- 이유: 공정위 고시 = 법정 정적 데이터, 변경 주기 연 1회 미만. DB 관리 오버헤드 불필요.
- 구조: `{ categoryKey: { label, items: [{ key, label, required, hint, extractable }] } }`
- `extractable: true` = AI가 사진/텍스트에서 추출 시도하는 항목
- `extractable: false` = 사장님 수동 입력 필수 (KC번호, 인증서 등)

**마켓 매핑**: `fromAiResponse()` 에서 이미 `category_suggestions.{coupang,naver,toss}.tree` 생성 중. 이 tree의 대분류를 정보고시 categoryKey로 매핑하는 룩업 테이블 추가 (`MARKET_CATEGORY_TO_DISCLOSURE_MAP`).

---

## 2. LLM 흐름 + 비용 추정

**파이프라인** (기존 `analyze-product-image.js` 확장):

```
사진 1~N장 + 상품명 + 상세설명
       ↓
[Tier 0] 카테고리 분류 (이미 구현 — ai_confidence 포함)
       ↓
[Tier 1] 정보고시 항목 추출 (신규)
  - 입력: 사진 + 상세설명 + 해당 카테고리의 필수 항목 목록
  - 모델: gpt-4o-mini (1차) → confidence < 0.6 시 gpt-4o (2차) — 기존 패턴 재사용
  - 출력: { items: { [key]: { value, confidence, source } } }
  - source: 'image' | 'text' | 'inferred' | 'missing'
       ↓
[Tier 2] 누락 항목 질문 생성 (신규)
  - source='missing' + required=true 항목 → 사장님께 입력 요청 메시지 생성
  - LLM 불필요 — 템플릿 기반 로직
```

**비용 추정**:
- gpt-4o-mini vision: ~$0.001/이미지 (기존 analyze와 동일 호출에 병합 가능)
- 정보고시 추출 프롬프트 추가 토큰: ~500 output tokens → ~$0.0003 추가
- **합산: 건당 ₩2~10 (기존 분석 비용에 +30% 수준)**
- gpt-4o 폴백 시: 건당 ₩15~25

**핵심 설계**: `analyze-product-image.js`의 SYSTEM_PROMPT에 정보고시 추출 지시를 **병합** (별도 API 호출 X). AI 응답 JSON에 `info_disclosure` 필드 추가. 비용 증가 최소화.

---

## 3. UI/UX 흐름

기존 검수 카드 6장 (`cardOrder: ['category','title','detail','price','options','policy']`) 뒤에 **정보고시 카드 1장 추가**:

```
cardOrder: ['category','title','detail','price','options','policy','info_disclosure']
```

**정보고시 카드 상세**:
1. **상단 disclaimer** (항상 노출): "AI가 채운 초안입니다. 사장님이 검수하신 후 발행하면 사장님 책임이에요."
2. **항목 목록**: 각 항목 = 라벨 + AI 채운 값 (편집 가능 input) + confidence 표시
   - confidence >= 0.8 → 초록 체크
   - 0.5~0.8 → 노랑 경고 "확인해 주세요"
   - missing/required → 빨간 강조 "법적 의무 항목 — 직접 입력해 주세요"
3. **누락 필수 항목 카운트**: 상단에 "필수 N개 미입력" 뱃지
4. **다음 버튼**: 누락 필수 항목 있으면 "N개 항목을 채워야 등록할 수 있어요" 경고 (진행은 허용 — 마켓이 리젝할 수 있다는 안내와 함께)

**마켓 등록 직전 confirm** (distribute 화면):
- 기존 마켓 토글 아래에 체크박스 추가: "정보고시를 검수했어요. 발행 후 책임은 저에게 있어요."
- 체크 안 하면 등록 버튼 비활성

---

## 4. 책임 경계 적용 위치

| 위치 | 적용 내용 |
|------|----------|
| **UI — 정보고시 카드 상단** | "AI 생성 초안 — 사장님 검수 후 발행 시 사장님 책임" 문구 상시 노출 |
| **UI — distribute 화면** | 체크박스 "정보고시 검수 완료. 발행 후 책임은 저에게 있어요." 명시 동의 |
| **약관 — terms.html** | 신규 조항: "AI 산출물(정보고시 초안 포함)의 정확성 최종 확인 책임은 이용자에게 있습니다" |
| **audit_logs 테이블** | 기존 `audit-log.js` 활용. action: `info_disclosure.confirm` — 사장님이 검수 완료 체크한 시점 기록 |
| **products 테이블** | `info_disclosure` JSONB 컬럼 추가 — AI 초안 + 사장님 수정 최종값 보존 |
| **register-product.js (backend)** | 등록 시 `info_disclosure_confirmed: true` 필드 필수 검증 |

---

## 5. Phase A vs Phase B 범위

### Phase A (베타 — 즉시 구현 가능)
- 카테고리 6종 정보고시 스키마 hardcode
- analyze-product-image 프롬프트 확장 (정보고시 추출 병합)
- 검수 카드 1장 추가 (편집 가능 + confidence 표시)
- confirm 체크박스 + audit_log 기록
- terms.html AI 면책 조항 추가
- products 테이블 `info_disclosure` JSONB 컬럼

### Phase B (정식 출시 후)
- 카테고리 30+ 확장
- 외부 DB 연동: 식약처 영양성분 API, KC 인증번호 조회
- 마켓별 정보고시 필드 미세 차이 매핑 (쿠팡 vs 네이버 vs 토스)
- 정보고시 템플릿 저장/재사용 (같은 카테고리 상품 반복 등록 시)
- 가이드 영상/도움말 팝업

---

## 6. 코드 작업 분해

### Task 1: 데이터셋 + 스키마 (신규 파일 1개 + 기존 수정 1개)
- **신규**: `netlify/functions/_shared/info-disclosure-schema.js` — 6종 카테고리별 항목 정의 + 매핑 함수
- **수정**: `lumi-product-schema.js` — LumiProduct typedef에 `info_disclosure` 필드 추가, `fromAiResponse()`에서 파싱
- **AC**: `require()` 가능 + 6종 카테고리 각각 항목 배열 반환 + extractable 플래그 포함

### Task 2: LLM 프롬프트 확장 (기존 파일 1개 수정)
- **수정**: `analyze-product-image.js` — SYSTEM_PROMPT에 정보고시 추출 지시 병합, 응답 JSON에 `info_disclosure` 객체 추가
- **AC**: mock 모드에서 info_disclosure 포함 응답 반환 + 실제 호출 시 6종 카테고리 항목 추출

### Task 3: DB 스키마 (Supabase 마이그레이션)
- `products` 테이블에 `info_disclosure JSONB DEFAULT NULL` 컬럼 추가
- `info_disclosure_confirmed BOOLEAN DEFAULT FALSE` 컬럼 추가
- **AC**: 기존 row에 영향 없음 (nullable) + 신규 등록 시 저장 확인

### Task 4: Backend 연계 (기존 파일 1개 수정)
- **수정**: `register-product.js` — insert payload에 `info_disclosure` + `info_disclosure_confirmed` 포함, confirmed=false 시 경고 로그
- **수정**: `register-product.js` — audit.log 호출에 `info_disclosure.confirm` 액션 추가
- **AC**: 등록 API 호출 시 info_disclosure 저장 + audit_log 기록

### Task 5: UI — 정보고시 검수 카드 (기존 파일 2개 수정)
- **수정**: `js/register-product.js` — cardOrder에 'info_disclosure' 추가, 카드 렌더링 로직, confirm 체크박스
- **수정**: `register-product.html` — 정보고시 카드 마크업 + disclaimer 문구
- **수정**: `css/register-product.css` — 정보고시 카드 스타일 (confidence 색상 등)
- **AC**: 카드 스와이프로 정보고시 항목 편집 가능 + 누락 필수 항목 빨간 강조 + confirm 체크 안 하면 등록 불가

### Task 6: 약관 갱신 (기존 파일 1개 수정)
- **수정**: `terms.html` — AI 산출물 면책 조항 추가
- **AC**: "AI 산출물 책임은 이용자" 문구 포함

---

## 7. 위험 + 완화책

| 위험 | 영향 | 완화 |
|------|------|------|
| LLM 환각 (항목값 오류) | 법적 과태료 가능 | disclaimer + 사장님 검수 + confirm 체크 + audit_log. **AI 도구일 뿐, 책임은 셀러** |
| 마켓별 정보고시 필드 차이 | 등록 리젝 가능 | Phase A에선 공정위 고시 기준 통합. Phase B에서 마켓별 분기 |
| 카테고리 오분류 → 엉뚱한 항목 | UX 혼란 | 카테고리 카드에서 사장님 수정 가능 (기존) → 정보고시 카드 항목 자동 갱신 |
| 사진만으론 추출 불가 항목 多 | 빈 칸 多 → UX 부담 | extractable 플래그로 "AI가 못 채우는 건 원래 직접 입력" 안내 |
| 프롬프트 길이 증가 → 비용 | +30% 수준 | gpt-4o-mini 기본 + 기존 분석과 1회 호출 병합 |

---

## 8. 다음 액션 (executor 위임 순서)

1. **Task 1** (데이터셋 + 스키마) — 의존성 없음, 단독 실행 가능
2. **Task 2** (프롬프트 확장) — Task 1 완료 후
3. **Task 3** (DB 마이그레이션) — Task 1과 병렬 가능
4. **Task 4** (Backend) — Task 1,2,3 완료 후
5. **Task 5** (UI) — Task 1,4 완료 후
6. **Task 6** (약관) — 독립, 언제든 가능

**첫 executor 위임 단위**: Task 1 + Task 3 병렬 시작.
