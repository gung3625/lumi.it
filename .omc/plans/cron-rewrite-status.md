# cron/form Functions Blobs → Supabase 재작성 완료 보고

## 수정 파일

### scheduled-trends.js
- 수정 전: 537줄
- 수정 후: 589줄 (Supabase upsert 로직 추가로 증가)
- 변경 내용:
  - `require('@netlify/blobs')` → `require('./_shared/supabase-admin')`
  - `saveScope()` 함수: `store.set()` → `supa.from('trends').upsert()`
  - 저장 키 포맷: `l30d-{scope}:{category}` 문자열을 `public.trends.category` 컬럼에 그대로 사용
  - `public.trends` 스키마: `category text primary key, keywords jsonb, collected_at timestamptz`
  - `keywords` 컬럼에 payload 전체 JSON 저장 (keywords 배열, updatedAt, source 포함)
  - rising 예측, all 집계, prev 백업 모두 동일 테이블 다른 category 키로 저장
  - Supabase 초기화 실패 시 500 반환 (명확한 에러 처리)
  - cron schedule `0 15 * * *` 유지 (`module.exports.config` 건드리지 않음)

### beta-apply.js
- 수정 전: 121줄
- 수정 후: 137줄
- 변경 내용:
  - `require('@netlify/blobs')` → `require('./_shared/supabase-admin')`
  - GET: `store.list()` → `supa.from('beta_applicants').select('*', { count: 'exact', head: true })`
  - POST 신청자 저장: `store.set()` → `supa.from('beta_applicants').insert()`
  - POST 대기명단 저장: `waitStore.set()` → `supa.from('beta_waitlist').insert()`
  - 스키마 컬럼 매핑: `store` → `store_name`, `type` → `store_type`, `utm` → jsonb
  - Solapi 알림톡/SMS 로직 100% 동일 유지
  - 개인정보 로그 없음: `[beta-apply] 신청 처리 완료` 만 출력

## API 응답 포맷 변경 없음 확인

| 엔드포인트 | 기존 | 변경 후 |
|---|---|---|
| GET | `{ count: N, max: 20 }` | 동일 |
| POST 성공 | `{ success: true, remaining: N }` | 동일 |
| POST 마감 | `{ error: '마감', waitlist: true }` | 동일 |
| POST 필수항목 누락 | `{ error: '필수 항목 누락' }` | 동일 |
| POST 에러 | `{ error: '처리 중 오류...' }` | 동일 |

## 스키마 매핑

- `public.trends`: category(PK) + keywords(jsonb) + collected_at
  - 키 포맷: `l30d-domestic:cafe`, `l30d-global:food`, `l30d-rising:beauty`, `trends:cafe` 등
- `public.beta_applicants`: id(uuid PK), name, store_name, store_type, phone, insta, referral, utm(jsonb), applied_at
- `public.beta_waitlist`: 동일 구조

## 구문 검증
- `node -c netlify/functions/scheduled-trends.js` → OK
- `node -c netlify/functions/beta-apply.js` → OK

## 발견된 이슈

1. **trend_cache 테이블 없음**: 태스크 지침에 `trend_cache` 언급이 있었으나 실제 스키마에는 해당 테이블이 없음. 스키마의 `public.trends`(category PK + keywords jsonb)를 사용하여 기존 Blobs 키 포맷(`l30d-{scope}:{category}`)을 category 컬럼 값으로 그대로 사용하는 방식으로 구현. 데이터 구조 변경 없음.
2. **rate_limits 미사용**: beta-apply.js 기존 코드에 rate limit 로직이 없었으므로 추가하지 않음 (scope 외 변경 금지 원칙).
