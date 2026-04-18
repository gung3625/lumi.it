# 트렌드 파이프라인 Phase 1 재구축 — 작업 로그

## 목표
- `scheduled-trends.js` 를 5개 외부 소스(네이버 데이터랩, 네이버 검색, 구글 트렌드, YouTube, Instagram) + gpt-4o-mini 분류기로 재작성
- Supabase `public.trends` 저장 포맷·`get-trends.js` 응답 호환 유지
- Instagram 소스는 심사 미완 구간 스켈레톤만 (실패 시 skip)

## 데이터 소스 5종
1. 네이버 데이터랩 — 기존 로직 유지 (업종별 키워드 그룹 추이)
2. 네이버 검색 API (블로그) — `/v1/search/blog.json` 시드 키워드 기반 제목·요약 수집
3. 구글 트렌드 — `google-trends-api` npm (RSS fallback 유지)
4. YouTube Data API v3 — `search.list`(카테고리 시드) + `videos.list` 인기 영상 제목
5. Instagram Graph API — 스켈레톤만 + `META_APP_ID/SECRET` 존재 시 토큰 요청 시도, 실패 시 skip

## 분류·정제
- **gpt-4o-mini** (기존 `gpt-5.4` 대체) — 비용↓ + 단순 분류 적합
- Responses API 통일 유지
- 프롬프트: "트렌드 자체 vs 검색 의도" 엄격 구분, JSON 스키마 고정 `{cafe, food, beauty, other}`
- temperature 0.2, 카테고리당 8~12개, 한국어/영어 동시 수용 (도메스틱/글로벌 분리 유지)
- 기존 rising 예측(gpt-5.4)은 유지 또는 gpt-4o-mini 로 변경

## 저장 스키마
- `public.trends.category` 컬럼에 기존 키 포맷 유지:
  - `l30d-domestic:{cat}` / `l30d-global:{cat}`
  - `l30d-domestic-prev:{cat}` / `l30d-global-prev:{cat}`
  - `l30d-rising:{cat}` (domestic 만)
  - `l30d-domestic:all` / `l30d-global:all`
  - `trends:{cat}` (레거시 호환)
  - `l30d-{scope}:{cat}:{YYYY-MM-DD}` (날짜 스냅샷)
- 추가 필드 없음 (기존 jsonb payload 형태 유지)

## get-trends.js 대응
- 현재 Netlify Blobs 읽기 → Supabase `public.trends.category` 조회로 전환
- 기존 응답 JSON 필드 그대로 유지 (category, categoryLabel, scope, keywords, rising, insight, season, updatedAt, source)
- 날짜 범위 조회(`from`/`to`)는 `like` 또는 range 쿼리로 이전

## 변경 예정 파일
- `netlify/functions/scheduled-trends.js` (전면 재작성)
- `netlify/functions/get-trends.js` (Supabase 리더로 최소 변경)
- `package.json` (신규 의존성 없음 — `google-trends-api` 이미 존재, `node-fetch` 사용 가능)

## 제약·경고
- **환경변수 값 노출 금지** — 커밋/로그/주석에 절대 출력 안 함
- **Instagram 공개 해시태그 조회는 Business 계정 + 심사 필수** — 1차에서는 skeleton + graceful skip
- fallback (`DEFAULT_TRENDS`) 모든 단계에서 유지
- Pinterest 제외
- 커밋·배포 금지 (사용자 검토)

## 완료 체크
- [x] scheduled-trends.js 재작성 (5소스 + gpt-4o-mini 배치 분류)
- [x] get-trends.js Supabase 리더 전환 (Blobs 제거)
- [x] node -c 구문 검증 (둘 다 OK)
- [x] 응답 포맷 호환성 확인 (필드 추가·제거 없음)

## 배포 후 테스트
```bash
# 1. 수동 트리거 (스케줄 실행)
curl -X POST https://lumi.it.kr/.netlify/functions/scheduled-trends \
  -H "x-lumi-secret: $LUMI_SECRET"

# 2. 국내 카페 트렌드
curl 'https://lumi.it.kr/api/get-trends?category=cafe&scope=domestic'

# 3. 해외 뷰티 트렌드
curl 'https://lumi.it.kr/api/get-trends?category=beauty&scope=global'

# 4. 날짜 범위 히스토리
curl 'https://lumi.it.kr/api/get-trends?category=cafe&scope=domestic&from=2026-04-15&to=2026-04-18'

# 5. 레거시 호환 (scope 미지정)
curl 'https://lumi.it.kr/api/get-trends?category=food'
```

## 의존성
- 추가된 npm 패키지 없음 (`google-trends-api`, `@supabase/supabase-js` 이미 존재)
- 필요 환경변수 (전부 Netlify에 이미 존재):
  - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  - OPENAI_API_KEY
  - NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
  - YOUTUBE_API_KEY
  - (선택) INSTAGRAM_BUSINESS_ID, INSTAGRAM_ACCESS_TOKEN — 심사 통과 후에만
  - LUMI_SECRET

## Supabase 마이그레이션
- 신규 마이그레이션 불필요 — `public.trends` 기존 스키마(category PK + keywords jsonb) 그대로 사용
- 기존 Blobs → Supabase 포팅 상태에서 저장 키 포맷 그대로 유지

## 알려진 제약·경고
1. **Instagram Graph API**: 공개 해시태그 조회(`ig_hashtag_search` + `top_media`)는 Business 계정 + 심사 필요. 현재는 `INSTAGRAM_BUSINESS_ID`/`INSTAGRAM_ACCESS_TOKEN` 환경변수 미설정 시 skeleton 함수가 빈 배열 반환하며 조용히 skip.
2. **YouTube quota**: `search.list` 는 호출당 100 units 소모. 업종 4개 × 시드 2개 × 지역 2개 = 16회 = 1,600 units/일. 무료 quota(10,000/일) 내.
3. **네이버 검색 API**: 일 25,000건 한도 충분.
4. **구글 트렌드**: 비공식 라이브러리 — 차단 시 RSS fallback 자동 전환.
5. **Pinterest**: 제외.
6. **rising 예측**: domestic 한정 (기존 동작 유지).
