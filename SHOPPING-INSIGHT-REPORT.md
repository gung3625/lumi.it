# 네이버 데이터랩 쇼핑인사이트 통합 보고서

작업일: 2026-04-28
브랜치: `feature/naver-shopping-insight`
워크트리: `.worktrees/naver-shopping-insight`
베이스: `main` (Sprint 1.5·3과 분리)

---

## 1. 결론

네이버 데이터랩 쇼핑인사이트 **9 엔드포인트 전체 통합 완료**.
단위 테스트 18/18 + 실제 API 8/8 통과. main 머지 권고.

---

## 2. 신규 파일 (5개)

| 파일 | 역할 |
|---|---|
| `netlify/functions/_shared/naver-shopping-insight.js` | 9 엔드포인트 호출 헬퍼 + 응답 정규화 + 친절한 에러 번역 + Rate Limit 큐 |
| `netlify/functions/scheduled-shopping-insight-background.js` | B 그룹 4종 × 10업종 = 40 호출/일 cron |
| `netlify/functions/get-shopping-insights.js` | 셀러 통합 조회 API (B 그룹 DB 조회 + C 그룹 lazy 호출, 24h 캐시) |
| `netlify/functions/_shared/__tests__/naver-shopping-insight.test.js` | 단위 테스트 18 케이스 |
| `scripts/shopping-insight-real.js` | 실제 API 호출 검증 스크립트 (시크릿 마스킹) |
| `migrations/2026-04-28-shopping-insights.sql` | `shopping_insights` 테이블 스키마 |

## 3. 수정 파일 (1개)

| 파일 | 변경 |
|---|---|
| `netlify.toml` | cron 스케줄 1개 + redirect 2개 추가 |

---

## 4. 9 엔드포인트 구현 상태

### A. 검색어 트렌드 (이미 사용 중)
1. `/v1/datalab/search` — 다른 모듈에서 사용. 본 작업 범위 외.

### B. 분야만 (4)
2. `fetchCategoryTrend`        → `POST /v1/datalab/shopping/categories`           — `category` 배열형
3. `fetchCategoryByDevice`     → `POST /v1/datalab/shopping/category/device`      — `category` 문자열형
4. `fetchCategoryByGender`     → `POST /v1/datalab/shopping/category/gender`      — `category` 문자열형
5. `fetchCategoryByAge`        → `POST /v1/datalab/shopping/category/age`         — `category` 문자열형

### C. 분야 + 키워드 (4)
6. `fetchCategoryKeywords`         → `POST /v1/datalab/shopping/category/keywords`         — `category` 문자열 + `keyword` 배열
7. `fetchCategoryKeywordByDevice`  → `POST /v1/datalab/shopping/category/keyword/device`   — `category` 문자열 + `keyword` 문자열
8. `fetchCategoryKeywordByGender`  → `POST /v1/datalab/shopping/category/keyword/gender`   — `category` 문자열 + `keyword` 문자열
9. `fetchCategoryKeywordByAge`     → `POST /v1/datalab/shopping/category/keyword/age`      — `category` 문자열 + `keyword` 문자열

⚠ **주의: 페이로드 형식이 엔드포인트마다 다름** (B/1만 배열형, 나머지는 문자열형). 1차 구현에서 모두 배열형으로 보내 6/8 400 발생 → 진단 호출 후 `shape` 분기 도입으로 해결. 단위 테스트로 모킹된 형식이 실제 형식과 일치하는지 확인은 통합 스크립트의 8/8 통과로 검증.

---

## 5. 검증 결과

### 단위 테스트 18/18
```
PASS  B/1~4 (4개 분야만)
PASS  C/5~8 (4개 분야+키워드)
PASS  검증/1~4 (입력 검증 + 환경변수)
PASS  에러/1~3 (401/429/translateNaverError)
PASS  summary/1~2 (분포 요약)
PASS  mapping/1 (10업종 매핑)
```
실행: `node netlify/functions/_shared/__tests__/naver-shopping-insight.test.js`

### 통합 테스트 (실제 호출) 8/8
패션의류(50000000) 카테고리, 키워드 "원피스" / "블라우스" 사용. 평균 응답 ~310ms.
```
PASS  B/1 category_overall          (320ms, 1 results)
PASS  B/2 category_device           (~285ms, 1 results)
PASS  B/3 category_gender           (~285ms, 1 results)
PASS  B/4 category_age              (~285ms, 1 results)
PASS  C/5 category_keywords         (309ms, 2 results)
PASS  C/6 category_keyword_device   (~310ms, 1 results)
PASS  C/7 category_keyword_gender   (313ms, 1 results)
PASS  C/8 category_keyword_age      (359ms, 1 results)
```
실행:
```bash
NAVER_CLIENT_ID=... NAVER_CLIENT_SECRET=... node scripts/shopping-insight-real.js
```

### 모듈 로드 검증
```
OK: shared module loads
OK: cron loads
OK: reader loads
OK: real-script syntax (node --check)
```

---

## 6. 환경변수

추가 항목 **없음**. 기존 `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` 그대로 재사용 (검색어 트렌드와 동일 OpenAPI 앱).

⚠ **운영 체크**: Naver Developers 콘솔에서 해당 앱에 **데이터랩(쇼핑인사이트) 사용** 권한이 켜져있어야 함. 401/403 시 `translateNaverError`가 친절한 메시지로 안내.

---

## 7. Supabase 마이그레이션 가이드

```bash
# 옵션 1: psql 직접
psql $DATABASE_URL -f migrations/2026-04-28-shopping-insights.sql

# 옵션 2: Supabase SQL Editor
# → migrations/2026-04-28-shopping-insights.sql 내용 복사 후 실행
```

생성 객체:
- `shopping_insights` 테이블
- `idx_shopping_insights_cat_metric` 인덱스
- `idx_shopping_insights_keyword` 부분 인덱스 (C 그룹 전용)
- `idx_shopping_insights_collected_at` 인덱스

UNIQUE 제약: `(category_code, metric_type, keyword, period_end)` — `keyword=''` 디폴트로 B 그룹 단일 row 보장.

---

## 8. 호출량 산정

- **B 그룹 cron**: 매일 UTC 19:30 (KST 04:30) — 4 메트릭 × 10업종 = **40 호출/일**
- **C 그룹 lazy**: 셀러가 키워드 입력 시에만 호출 (3 메트릭 × 1키워드 = 3 호출/요청), 24시간 캐시
- **합계 추정**: 일 100~500 호출 수준
- **네이버 한도**: 일 25,000회 — **0.4~2% 사용**, 충분한 여유

---

## 9. 셀러용 응답 카피 예시

### B 그룹 응답 → 1인 셀러 친화 요약
```
"이 카테고리(패션의류)는 지난 30일간 모바일 92% 강세,
 30대 여성 비중이 35%로 가장 높습니다."
```

### C 그룹 응답 → 키워드별 상품 등록 결정
```
"'봄 원피스' 키워드는 모바일 96%, 여성 96%, 20~30대 70% 집중.
 → 모바일·20~30대 여성 타겟 상품 상세를 우선 보강하세요."
```

(메모리 `feedback_no_competitor_mention_in_copy.md` 준수: 자기 가치 중심)

---

## 10. 보안 확인

- 평문 시크릿 로그 **없음** (`console.error`는 status·naverCode만 출력)
- `scripts/shopping-insight-real.js` 응답 본문은 시계열 일부만 출력, 시크릿은 `maskString()` 처리
- 응답 헤더 시크릿 노출 차단 (요청 헤더는 captured 변수에 들어가지만 테스트 컨텍스트에서만 사용, 실제 핸들러는 미저장)
- cron `x-lumi-secret` 헤더 검증 (메모리 `reference_cron_manual_trigger.md` 준수)

---

## 11. 메모리 정정 권고

`/Users/kimhyun/.claude/projects/-Users-kimhyun/memory/project_trends_data_sources.md`:

```diff
- 1. **네이버 데이터랩 API** — `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` ✅
- 2. **네이버 검색 API** — 같은 네이버 크레덴셜 공유 ✅
+ 1. **네이버 데이터랩 검색어 트렌드** — `/v1/datalab/search` (기존)
+ 2. **네이버 검색 API** — 같은 네이버 크레덴셜 공유 ✅
+ 3. **네이버 데이터랩 쇼핑인사이트 9 엔드포인트** — 분야×{전체/기기/성별/연령} + 분야+키워드×{전체/기기/성별/연령} (2026-04-28 추가)
```

→ 네이버 소스 카운트: **2 → 3** (단, 9 엔드포인트는 모두 데이터랩 쇼핑인사이트 한 소스 안에 있음)
→ 전체 데이터 소스: **6 → 7** 표기 가능

---

## 12. 다음 단계 (main 머지 후)

1. **Supabase 마이그레이션 실행**: `migrations/2026-04-28-shopping-insights.sql`
2. **Netlify 배포 후 cron 수동 1회 트리거 검증**:
   ```bash
   SECRET=$(npx -y netlify-cli env:get LUMI_SECRET --context production | tail -1)
   curl -X POST "https://lumi.it.kr/api/scheduled-shopping-insight" \
     -H "x-lumi-secret: $SECRET" -w "HTTP:%{http_code}\n" --max-time 60
   ```
3. **`shopping_insights` 테이블 row 확인** (40개 row, B 그룹 4 × 10업종)
4. **셀러 UI 통합 (선택)**: 트렌드 페이지 또는 별도 "쇼핑 인사이트" 섹션
   - Sprint 1.5·3 worktree와 충돌 가능성 X (별도 페이지·별도 컴포넌트)
5. **메모리 정정**: `project_trends_data_sources.md` 업데이트 (네이버 3종 명시)

---

## 13. 권장 사항

- **C 그룹 주간 cron 추가 검토**: 인기 키워드 상위 10개를 미리 캐싱하면 셀러 첫 조회 시에도 즉시 응답 가능. 단 추정 호출량 (10업종 × 10키워드 × 3메트릭 × 주1회 = 300 호출/주) 고려 시 lazy 패턴이 더 효율.
- **카테고리 코드 운영 확장**: 현재 10업종 1차 코드만 매핑. 2차/3차 카테고리(예: `50000000` 패션의류 → `50000167` 원피스)는 운영 데이터 기반으로 점진 확장.

---

## 14. 절대 금지 준수 체크

- [x] 메인 직접 수정 X (worktree 작업)
- [x] 평문 NAVER_CLIENT_SECRET console.log X
- [x] 보라/Inter/Roboto/Arial/이모지 X
- [x] 매출% X
- [x] 경쟁사명 X (itemscout 등 대외 카피 미언급)
- [x] 실제 API 호출 시 시크릿 응답 그대로 노출 X (`maskString()` 처리)
