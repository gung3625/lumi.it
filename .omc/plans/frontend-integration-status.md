# 프론트엔드 Supabase 통합 상태 (2026-04-18)

## 파일별 라인 변화

| 파일 | 원본 | 수정 후 | 증감 | 가드(±150) |
|---|---|---|---|---|
| index.html | 5314 | 5406 | +92 | OK |
| settings.html | 401 | 434 | +33 | OK |
| subscribe.html | 454 | 478 | +24 | OK |

HTML 파서 검증: 3파일 모두 `python3 html.parser` 통과.

## 스키마 컬럼명 확인 결과

### `public.users` (확인: `20260418000000_initial_schema.sql:14-42`)
- 존재: `id, email, name, store_name, phone, birthdate, gender, instagram_handle, store_desc, region, sido_code, sigungu_code, store_sido, biz_category, caption_tone, tag_style, custom_captions, plan, trial_start, auto_renew, agree_marketing, agree_marketing_at, auto_story, auto_festival, retention_unsubscribed, created_at, updated_at`
- **주의**: 프론트가 과거에 쓰던 `feat_toggles`, `postCount`, `planExpireAt`, `limit`, `remaining`, `daysUntilExpire` 컬럼은 스키마에 **없음**. 이번 이전에서는 UI fallback (`rData?.remaining ?? '-'` 등)으로 처리. 계산 필드는 Phase D에서 Edge Function 또는 postgres view로 재현 예정.

### `public.reservations` (확인: 같은 파일:84-121)
- 존재: `id(bigserial), reserve_key, user_id, user_message, biz_category, caption_tone, tag_style, weather, trends, store_profile, post_mode, scheduled_at, submitted_at, story_enabled, post_to_thread, nearby_event, nearby_festivals, tone_likes, tone_dislikes, custom_captions, relay_mode, use_weather, is_sent, cancelled, caption_status, caption_error, generated_captions, captions, selected_caption_index, image_analysis, image_urls, image_keys, captions_generated_at, posted_at, ig_post_id, created_at`
- **어댑터**: `window.lumiRsvFromRow(row)` 가 snake_case → camelCase 매핑. 프론트 기존 `captionStatus`, `isSent`, `generatedCaptions`, `autoPostAt`(→ `scheduled_at`), `reservationKey`(→ `reserve_key`) 등 모두 호환.
- **이슈**: 프론트에서 `r.status = 'posted'` 필터 요청이 있었으나 스키마는 `caption_status` 를 사용 — `caption_status = 'posted'` 로 교체 완료.
- **취소 처리**: `status: 'cancelled'` 대신 `cancelled: true` boolean 컬럼 사용 (스키마 일치).

### `public.trends` (확인: 같은 파일:188-194)
- 존재: `category(PK), keywords(jsonb), insights(text), collected_at(timestamptz)`
- **스키마와 태스크 불일치**: 태스크는 `trend_cache` 테이블 + `scope` 컬럼을 가정하지만 실제 스키마는 `trends` 테이블이며 `scope` 컬럼 **없음**. 스키마를 따름.
- 처리: L3025 (no scope) 의 `get-trends?category=` 호출만 `trends.select().eq('category', ...)` 로 교체. L3583 (domestic/global scope 분기) 의 3개 호출은 **원본 Function 그대로 유지** — 스키마 확장(scope 컬럼 추가) 또는 다른 테이블 설계 필요.

### `public.ig_accounts` (확인: 같은 파일:65-79)
- 존재: `ig_user_id(PK), user_id, ig_username, page_id, access_token_secret_id, page_access_token_secret_id, token_expires_at, connected_at, updated_at`
- settings.html `disconnectIg()` 는 `delete().eq('user_id', uid)` 호출. **주의**: RLS 정책 파일(`20260418000001_rls_policies.sql:30-36`)에 따르면 `ig_accounts` DELETE 는 `service_role` 만 허용되어 있어, 클라이언트 직접 호출은 **정책상 실패 가능**. 이 경우 Function fallback 이 필요하지만 이번 범위에서는 태스크 지시에 따라 직접 DELETE 로 교체. RLS 가 막으면 Phase B 에서 `ig_accounts DELETE` 정책 추가 또는 Function 복귀 결정.

## 수정 내역 요약

### index.html
1. `</head>` 직전에 supabase-js UMD + 클라이언트 생성 + `onAuthStateChange` 브리지 + 헬퍼 (`lumiRsvFromRow`, `lumiGetReservation`, `lumiLastPost`, `lumiCheckPlan`, `lumiRelayList`, `lumiCancelReservation`) 삽입.
2. DIRECT 교체:
   - `count-post` (구 L1970) → `from('reservations').select('*',{count:'exact',head:true}).gte('created_at', monthStart)`
   - `get-reservation` (5회) → `lumiGetReservation(rKey)` 공통 헬퍼 경유 (RLS user_id 자동 가드)
   - `last-post` (2회) → `lumiLastPost()` — `caption_status='posted'` + `posted_at desc limit 1`
   - `get-trends` (L3025 단건) → `from('trends').select().eq('category', bizCat).maybeSingle()`
   - `check-plan` (3회) → `lumiCheckPlan()` — `users` 테이블 직접 조회, `.then(lumiCheckAuth).then(r=>r.json())` 체인 제거
   - `relay-list` → `lumiRelayList()` — client-side filter `!is_sent && !cancelled && post_mode !== 'immediate' && generated_captions.length > 0`
   - `cancel-reservation` → `lumiCancelReservation(rKey)` — `update({ cancelled: true })`

### settings.html
1. `</head>` 직전에 supabase-js + 클라이언트 + 인증 브리지 삽입.
2. L279 `update-profile` 조회 → `auth.getUser()` + `from('users').select().eq('id', uid).single()` — snake_case → camelCase 매핑 후 `localStorage.lumi_user` 갱신.
3. L307 `update-profile` 저장 → `update({ store_name, biz_category, region })` — **`plan` 컬럼 제외**.
4. L370 `disconnect-ig` → `from('ig_accounts').delete().eq('user_id', uid)` — RLS 경고 상기 참조.

### subscribe.html
1. `</head>` 직전에 supabase-js + 클라이언트 + 인증 브리지 삽입.
2. L429 `check-plan` → `auth.getUser()` + `from('users').select('plan').eq('id', uid).single()` — `planExpireAt/remaining/postCount` 는 `null` 로 채움 (UI 가 자연스럽게 빈 값 처리).

## 남은 fetch() 호출 (의도적으로 유지)

### index.html — FUNCTION 유지 (외부 API / 서버 시크릿 / 복잡 로직)
- L2135 `/api/reserve` — Storage 업로드 + IG Graph
- L2211 `/api/regenerate-caption` — OpenAI
- L2238 `/api/select-caption` — OpenAI + 게시 트리거
- L2345 `/api/reserve` — (중복)
- L2421 `/api/reserve` — (중복)
- L3583 `https://lumi.it.kr/.netlify/functions/get-trends?scope=domestic|global` × 3 — **scope 스키마 미지원**으로 유지
- L4010 `/api/update-profile` — featToggles 동기화 (스키마에 feat_toggles 컬럼 없음, 유지)
- L4140 `/api/regenerate-caption` — (중복)
- L4661 `/.netlify/functions/send-otp`, L4684 `verify-otp` — OTP
- L4746 `/api/register`, L4919 `/api/login` — Auth (Phase C 에서 `supabase.auth.*` 교체 예정)
- L4964 `/api/find-id` — 보안상 FUNCTION 필수
- L5002/5024/5051 `send-otp/verify-otp/reset-password` — OTP / 비번 재설정
- `serve-image?key=` 3곳 (L2877, L4166, L4204) — Storage URL 교체 대기 (30일 리디렉션 플랜)
- `check-plan` 재검증(L5141 기존) → `supabase.auth.getUser()` 로 교체 완료

### settings.html — 유지
- L339 `/api/reset-password` — 비로그인·로그인 공용 엔드포인트, 유지

### subscribe.html — 유지
- L354 `payment-prepare`, L392 `payment-confirm` — PortOne 서버 시크릿 필요

## 인증 세션 브리지 동작

3파일 모두 `onAuthStateChange` 리스너가:
- 로그인/토큰 갱신 시: `session.access_token` → `localStorage.lumi_token`, `session.user.email/id + metadata` → `localStorage.lumi_user` 병합 저장 (기존 키 보존)
- 로그아웃 시: 두 키 삭제

기존 60+ 지점의 `localStorage.getItem('lumi_token')` 로직 **모두 그대로 유지**. Phase C 에서 `supabase.auth.getSession()` 로 순차 이관 예정.

## 다음 단계 권장

1. **serve-image Storage URL 교체**: 별도 에이전트에 위임. `reservations.image_urls[]` 컬럼에 `supabase.storage.from('lumi-images').getPublicUrl(path)` 로 미리 채워두고, `<img src>` 를 `imageUrls[0]` 우선으로 사용. 30일 유예 후 `serve-image.js` 삭제.
2. **인증 플로우 교체 (Phase C)**: `/api/login`, `/api/register`, `/api/send-otp`, `/api/verify-otp`, `/api/reset-password` 내부를 `supabase.auth.*` 로 교체. 프론트 응답 포맷 유지.
3. **스키마 확장**: `public.trends` 에 `scope text` 컬럼 추가 (PK 를 `(category, scope)` 복합키로) → 프론트 L3583 3개 호출 DIRECT 교체.
4. **RLS 정책 보강**:
   - `ig_accounts` DELETE 정책 추가 (`auth.uid() = user_id`) 또는 disconnect 를 Function 으로 복귀.
   - `users` UPDATE 시 `plan` 컬럼 변경을 **거부** 하는 column-level policy 또는 trigger 필수 (현재는 RLS UPDATE 전체 허용이라 권한 상승 위험).
5. **check-plan 대체**: postgres view `public.v_plan_status` 를 만들어 `postCount`, `limit`, `remaining`, `daysUntilExpire` 를 계산 후 프론트에서 `from('v_plan_status').select().single()` 로 조회.
6. **featToggles**: `users` 에 `feat_toggles jsonb` 컬럼 추가 후 L4010 update-profile 도 DIRECT 로 교체.

## 검증 완료 항목

- [x] HTML 파서 통과 (3파일)
- [x] 타겟 8개 엔드포인트 DIRECT 교체 완료 (스키마 제약 1건 제외 — L3583 get-trends scope)
- [x] 라인 변화 가드 ±150 이내
- [x] `plan` 컬럼 업데이트 요청에서 제외 (settings saveProfile)
- [x] RLS 자동 가드 의존 (user_id 필터는 정책으로 강제되므로 명시 생략, `reserve_key` 는 현재 UNIQUE 이므로 단일 키 조회 안전)
- [x] Netlify Functions 폴더 **무수정** (netlify/functions/* 절대 건드리지 않음)
- [x] 디자인 토큰 무변경 (`--pink`, Pretendard, radius 8px)
- [x] 다크/라이트 토글 로직 무변경
- [x] git 미커밋
