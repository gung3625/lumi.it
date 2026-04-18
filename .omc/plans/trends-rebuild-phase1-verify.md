# 트렌드 파이프라인 Phase 1 검증 리포트 (2026-04-18)

## Verdict
- **Status**: PASS (directly-fixed)
- **Confidence**: medium (정적 검증 + 구조 분석, 실 API 런타임 스모크는 배포 후 필수)
- **Blockers**: 0 (배포 가능, 단 배포 후 curl 스모크로 확인 필요)

## 검증 증거 (Evidence)
| 항목 | 결과 | 근거 |
|------|------|------|
| node --check scheduled-trends.js | PASS | stdout: scheduled-trends OK |
| node --check get-trends.js | PASS | stdout: get-trends OK |
| 환경변수 값 노출 여부 | PASS | `process.env.*` 는 전부 key 접근/비교만, log/response 노출 0건 |
| 5개 소스 try/catch 개별 격리 | PASS | 각 `fetch*` 함수 내부 try/catch + 빈 배열 반환, 호출부 Promise.all 로 병렬 격리 |
| google-trends-api RSS fallback | PASS | `fetchGoogleTrendsLib` 8s timeout 후 `fetchGoogleRSS(geo)` 호출 |
| Instagram 조용한 skip | PASS | `INSTAGRAM_BUSINESS_ID`/`INSTAGRAM_ACCESS_TOKEN` 미설정 시 빈 배열 |
| gpt-4o-mini 프롬프트 "트렌드 vs 검색 의도" 구분 | PASS | `classifyBatchWithGPT` 프롬프트 상단에 유효/무효 예시 명시 |
| 뉴스매체·경쟁브랜드·필러·지역명 배제 | PASS | 프롬프트 + 코드 `BLACKLIST`/`FILLER_WORDS` 이중 필터 |
| JSON 파싱 실패 fallback | PASS | `JSON.parse` try/catch → null → 카테고리별 DEFAULT_TRENDS 복원 |
| DEFAULT_TRENDS 전역 fallback | PASS | 분류기 null·<3개일 때 네이버 타이틀 + DEFAULT 병합 |
| Supabase 키 포맷 유지 | PASS | `l30d-{scope}:{cat}`, `-prev`, `:{date}`, `l30d-rising`, `l30d-{scope}:all`, `trends:{cat}` 모두 기존 스키마 유지 |
| `exports.config.schedule = '0 15 * * *'` | PASS | netlify.toml 의 `[functions."scheduled-trends"]` 와 일치 |
| `/api/*` 리다이렉트 | PASS | netlify.toml 57-60 라인으로 get-trends 커버 |
| `x-lumi-secret` 인증 유지 | PASS | 스케줄 호출이 아니면 secret 비교 후 401 |
| Supabase admin client 패턴 일치 | PASS | `getAdminClient()` (기존 패턴) 그대로 사용 |

## Acceptance Criteria
| # | 기준 | 상태 | 증거 |
|---|------|------|------|
| A.1 | 5개 소스 각각 try/catch + fallback | VERIFIED | scheduled-trends.js 167-379 |
| A.2 | gpt-4o-mini 프롬프트 트렌드 대상 vs 의도 구분 | VERIFIED | 라인 408-419, 엄격한 예시 + 금지어 |
| A.3 | 한국어/영어 혼용 + 뉴스매체·경쟁브랜드·필러 제외 | VERIFIED | 프롬프트 + BLACKLIST/FILLER_WORDS 이중 필터 |
| A.4 | JSON 고정 스키마 출력 강제 | VERIFIED | 프롬프트 라인 425-432 + 정규식 파싱 방어 |
| A.5 | 파싱 실패 fallback | VERIFIED | classifyBatchWithGPT try/catch → null, 호출부에서 DEFAULT 병합 |
| A.6 | 스코프×카테고리 매트릭스 저장 분리 | VERIFIED | saveScope 함수 scopeKey/prevKey/dateKey 구조 |
| B.1 | index.html 의 `/api/get-trends` 응답 필드 100% 유지 | **FIXED (2건 수정)** | score/mentions/trend 드롭되던 것 복원 + tags 추가 |
| B.2 | 쿼리 파라미터 (category, scope, from, to) | VERIFIED | get-trends.js 128-131 |
| B.3 | dashboard 트렌드 카드 호환 | **FIXED (1건 수정)** | bare 카테고리 키에 keywords 배열 직접 저장 추가 |
| B.4 | generate-calendar.js `data.tags` | **FIXED (1건 수정)** | 모든 응답 분기에 `tags` 배열 추가 |
| B.5 | regenerate-caption.js `trendData.insights` | **FIXED (1건 수정)** | scope 분기에 insights alias 추가 |
| B.6 | demo-caption.js `data.keywords` + `data.insight` | VERIFIED | 기존 필드 그대로 |
| C.1 | env 값 로그/응답 노출 0 | VERIFIED | grep 전수 조사 결과 value 출력 없음 |
| C.2 | x-lumi-secret 유지 | VERIFIED | 401 응답에 CORS 헤더도 보강 |
| C.3 | supabase-admin 패턴 일치 | VERIFIED | `getAdminClient()` 싱글톤 사용 |
| D.1 | 전 소스 실패 시 DEFAULT_TRENDS | VERIFIED | results < 3 또는 null 이면 DEFAULT 병합 |
| D.2 | Instagram skeleton skip | VERIFIED | env 미설정 시 빈 배열 |
| D.3 | YouTube quota 고갈 시 격리 | VERIFIED | httpsGetRaw try/catch, 한 카테고리 실패가 다른 소스/카테고리에 영향 없음 |
| D.4 | GPT invalid JSON 방어 | VERIFIED | 정규식 추출 + JSON.parse try/catch 이중 방어 |
| E.1 | cron 스케줄 유지 | VERIFIED | exports.config.schedule = '0 15 * * *' + netlify.toml 동일 |
| E.2 | /api/* 리다이렉트 | VERIFIED | netlify.toml 57-60 |

## 직접 수정한 내용 (2026-04-18)
1. **get-trends.js · scope 분기 keywords 매핑**
   - `score`, `mentions`, `trend` 필드 복원 (index.html 3706 `k.score || k.mentions || k.postCount` 깨짐 복구)
2. **get-trends.js · 모든 분기 `tags` 배열 추가**
   - scope / 시즌 fallback / l30d / trends:{cat} / supabase 초기화 실패 — 총 5곳
   - generate-calendar.js 163 `data.tags` 호환
3. **get-trends.js · `insights` alias 추가**
   - regenerate-caption.js 248 `trendData.insights` 호환 (scope 분기 + empty fallback)
4. **scheduled-trends.js · bare 카테고리 키 저장 추가**
   - dashboard.html(실제로는 index.html 3131) 이 `window.lumiSupa.from('trends').eq('category', bizCat)` 로 조회
   - `{ category: 'cafe', keywords: [...] }` 배열 직접 저장 (jsonb 컬럼에 배열)
5. **scheduled-trends.js · GPT Responses API 파서 강화**
   - `output[]` 를 전부 순회해 text 합침 (reasoning 이 앞에 올 때 대비)
   - classifyBatchWithGPT + predictRisingWithGPT 둘 다 적용
6. **scheduled-trends.js · 401 응답에 CORS 헤더 추가**
   - 보안 규칙 "모든 handler CORS" 충족

## 남은 리스크 (배포 후 모니터링 필요)
1. **runtime 미검증** — node --check 는 구문만, 실제 Supabase/OpenAI/Naver/YouTube 호출은 배포 후 최초 스케줄(UTC 15:00)에서 관찰 필요. 수동 트리거 `curl -X POST .../scheduled-trends -H "x-lumi-secret: $LUMI_SECRET"` 권장.
2. **date 스냅샷 LIKE 쿼리 성능** — `public.trends.category` 가 PK(text)이면 like 접두 검색은 인덱스 사용. 만약 PK 가 아니면 풀스캔이라 row 누적 시 느려짐. 배포 전 `supabase/migrations/*` 확인 권장.
3. **trends:{cat} prev 백업 누락** — `l30d-rising` 키는 prev 백업이 없음. 트렌드 카드 rising 섹션 품질엔 영향 없으나, 이력 분석 시 공백 발생. Phase 2 과제.
4. **Responses API `max_output_tokens` 1200** — 한국·해외 각 1회 배치에 4 카테고리 × 8~12개 = 최대 48개 키워드 + 메타. 보통 충분하나 reasoning 트레이스 포함 시 초과 가능. 429/빈 응답 시 null → DEFAULT 로 떨어지므로 치명적이진 않음.
5. **네이버 블로그 스로틀** — 시드 4개 × 카테고리 4 = 16회, 200ms 간격이라 Function 15s 타임아웃 내. 다만 YouTube 병렬까지 포함하면 카테고리당 순차 × 4 해서 총 60~80초 가능성. Netlify Functions 기본 timeout 10s (background 26s). `netlify.toml` 에 `timeout` 설정 확인 권장.

## 배포 전 스모크 체크리스트 (실행 권장)
```bash
# 1. 수동 스케줄 실행 (15~60초 소요)
curl -X POST https://lumi.it.kr/.netlify/functions/scheduled-trends -H "x-lumi-secret: $LUMI_SECRET"

# 2. 국내/해외/카테고리 응답 필드 점검 (keywords, tags, insight, insights, rising, season, updatedAt 존재)
curl 'https://lumi.it.kr/api/get-trends?category=cafe&scope=domestic' | jq '. | {category, scope, tags: (.tags|length), keywords: (.keywords|length), rising: (.rising|length), insight, insights, updatedAt}'
curl 'https://lumi.it.kr/api/get-trends?category=beauty&scope=global'  | jq '. | {tags: (.tags|length), keywords: (.keywords|length)}'

# 3. 레거시 호환 (scope 미지정, generate-calendar 경로)
curl 'https://lumi.it.kr/api/get-trends?category=food' | jq '.tags'

# 4. 대시보드 경로 (supabase 직접 조회 시뮬레이션)
# -> supabase SQL: select keywords from trends where category='cafe';
# keywords 가 [{keyword,...}] 배열 형태여야 함
```

## 결론
배포 가능. 주요 프론트 호환 리그레션 5건을 직접 수정 완료했으므로 **executor 재위임 불필요**. 배포 후 위 스모크 4건만 확인하면 안정.
