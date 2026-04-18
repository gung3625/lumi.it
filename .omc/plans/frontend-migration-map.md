# 프론트엔드 → Supabase 호출 매핑 (2026-04-18)

프론트엔드 HTML 파일의 모든 `fetch()` 호출과 이미지 URL을 조사, Supabase 전환 방침 매핑.

## 요약 통계

| 항목 | 값 |
|---|---|
| 조사 파일 | `index.html`, `settings.html`, `subscribe.html`, `ig-guide.html` |
| 총 fetch 호출 지점 | 약 32개 (index 25 + settings 4 + subscribe 3 + ig-guide 0) |
| 고유 엔드포인트 | 24개 |
| DIRECT (즉시 supabase-js 대체) | 8개 |
| FUNCTION (Function 유지) | 15개 |
| DELETE (Storage URL로 교체 후 폐기) | 1개 (`serve-image`) |
| 이미지 URL 레거시 위치 | 3곳 |
| localStorage `lumi_token`/`lumi_user` 사용 | 60+ 지점 |

---

## 파일별 fetch 호출 매핑

### index.html (25개 호출 지점)

| 라인 | 엔드포인트 | 분류 | 대체 방법 |
|---|---|---|---|
| 1970 | `/.netlify/functions/count-post` | DIRECT | `supabase.from('reservations').select('*', { count: 'exact', head: true })` |
| 2022 | `/api/reserve` | FUNCTION | Storage 업로드 + IG Graph 검증 필요 → 유지 |
| 2049 | `/api/get-reservation?key=` | DIRECT | `supabase.from('reservations').select().eq('reserve_key', rKey).eq('user_id', auth.uid())` |
| 2100 | `/api/regenerate-caption` | FUNCTION | OpenAI 호출 → 유지 |
| 2127 | `/api/select-caption` | FUNCTION | OpenAI 호출 → 유지 |
| 2158 | `/api/get-reservation?key=` | DIRECT | (중복) `reservations` 폴링 |
| 2224 | `/api/get-best-time` | FUNCTION | 순수 계산 로직이지만 user 예약 전체 집계 필요 → DIRECT 가능, 다만 초기는 유지 권장 |
| 2236 | `/api/reserve` | FUNCTION | (중복) |
| 2257 | `/api/get-reservation?key=` | DIRECT | (중복) |
| 2314 | `/api/reserve` | FUNCTION | (중복) |
| 2335 | `/api/get-reservation?key=` | DIRECT | (중복) |
| 2796 | `/api/last-post` | DIRECT | `supabase.from('reservations').select().eq('status','posted').order('posted_at',{ascending:false}).limit(1)` |
| 2805 | `/api/last-post` | DIRECT | (중복) |
| 2832 | `/api/serve-image?key=...&t=token` | **DELETE** | Storage public URL `supabase.storage.from('lumi-images').getPublicUrl(path).data.publicUrl` |
| 2989 | `/.netlify/functions/get-weather-kma` | FUNCTION | 공공 API 프록시, CORS 검증 후 DIRECT 가능 (1순위 FUNCTION 유지) |
| 3013 | `/api/get-best-time` | FUNCTION | (중복) |
| 3025 | `/api/get-trends?category=` | DIRECT | `supabase.from('trend_cache').select().eq('category', cat)` |
| 3265 | `/.netlify/functions/ig-oauth?action=start` | FUNCTION | Meta OAuth 리다이렉트 → 유지 (window.location.href) |
| 3297 | `/.netlify/functions/get-weather-kma` | FUNCTION | (중복) |
| 3479-3495 | `/.netlify/functions/get-trends` (3개 호출) | DIRECT | `trend_cache` 조회로 통합 |
| 3747 | `/api/check-plan` | DIRECT | `supabase.from('profiles').select('plan').eq('id', auth.uid()).single()` |
| 3810 | `/api/check-plan` | DIRECT | (중복) |
| 3908 | `/api/update-profile` | DIRECT | `supabase.from('profiles').update({...}).eq('id', auth.uid())` — **단 `plan` 컬럼 제외 RLS 필수** |
| 3982 | `/api/relay-list` | DIRECT | `supabase.from('reservations').select().eq('user_id', auth.uid()).order('created_at',{ascending:false})` |
| 4002 | `/api/cancel-reservation` | DIRECT | `supabase.from('reservations').update({status:'cancelled'}).eq('reserve_key', rKey).eq('user_id', auth.uid())` |
| 4024 | `/api/get-reservation?key=` | DIRECT | (중복) |
| 4045 | `/api/regenerate-caption` | FUNCTION | (중복) |
| 4087 | `/.netlify/functions/serve-image?key=` | **DELETE** | Storage public URL |
| 4125 | `/.netlify/functions/serve-image?key=` | **DELETE** | Storage public URL |
| 4566 | `/.netlify/functions/send-otp` | FUNCTION | Resend 메일러 유지 → `supabase.auth.signInWithOtp`로 교체 검토 |
| 4589 | `/.netlify/functions/verify-otp` | FUNCTION | OTP 검증 → `supabase.auth.verifyOtp` 교체 검토 |
| 4651 | `/api/register` | FUNCTION | Auth 생성 + Resend 웰컴 + Solapi → 유지 (내부 Supabase) |
| 4824 | `/api/login` | FUNCTION → DIRECT | `supabase.auth.signInWithPassword({email, password})` |
| 4869 | `/api/find-id` | FUNCTION | 타 유저 이메일 열람 방지 → **DIRECT 절대 불가**, 유지 |
| 4907 | `/api/send-otp` (중복) | FUNCTION | (중복) |
| 4929 | `/api/verify-otp` (중복) | FUNCTION | (중복) |
| 4956 | `/api/reset-password` | FUNCTION | `supabase.auth.updateUser({password})` 교체 검토, 단 비로그인 재설정은 Function 유지 |
| 5060 | `/api/check-plan` | DIRECT | (중복) |

### settings.html (4개)

| 라인 | 엔드포인트 | 분류 | 대체 방법 |
|---|---|---|---|
| 279 | `/api/update-profile` (feature toggles) | DIRECT | `supabase.from('profiles').update(feat_toggles)` |
| 307 | `/api/update-profile` (store info) | DIRECT | `supabase.from('profiles').update(store_info)` |
| 339 | `/api/reset-password` (from settings, logged in) | DIRECT | `supabase.auth.updateUser({ password })` |
| 370 | `/api/disconnect-ig` | DIRECT | `supabase.from('ig_accounts').delete().eq('user_id', auth.uid())` |

### subscribe.html (3개)

| 라인 | 엔드포인트 | 분류 | 대체 방법 |
|---|---|---|---|
| 340 | `/.netlify/functions/payment-prepare` | FUNCTION | PortOne 사전 등록 → 유지 (서버 시크릿 필요) |
| 378 | `/.netlify/functions/payment-confirm` | FUNCTION | PortOne 확정 + Resend → 유지 |
| 429 | `/.netlify/functions/check-plan` | DIRECT | `profiles.plan` 조회 |

### ig-guide.html

fetch 호출 없음. OAuth는 `window.location.href='/.netlify/functions/ig-oauth?action=start&token=...'` 리다이렉트 (FUNCTION 유지).

---

## 분류 최종 목록

### DIRECT (8개 고유 엔드포인트 → 즉시 supabase-js)

1. `count-post` → `.select('*', { count: 'exact', head: true })`
2. `get-reservation` → `.select().eq('reserve_key', ..).eq('user_id', auth.uid())` (RLS 이중 가드)
3. `check-plan` → `.from('profiles').select('plan')`
4. `last-post` → `.from('reservations').select().eq('status','posted').limit(1)`
5. `relay-list` → `.from('reservations').select()` (user_id RLS 자동 가드)
6. `cancel-reservation` → `.update({ status: 'cancelled' })`
7. `get-trends` → `.from('trend_cache').select()`
8. `update-profile` / `disconnect-ig` → `.from('profiles').update()` / `.from('ig_accounts').delete()`

### FUNCTION 유지 (15개)

`reserve`, `regenerate-caption`, `select-caption`, `get-best-time`(1차 유지), `get-weather-kma`, `ig-oauth`, `register`, `login`(교체 가능하나 플로우 변경 감안해 Phase C), `find-id`, `send-otp`, `verify-otp`, `reset-password`(비로그인), `payment-prepare`, `payment-confirm`, `serve-image`(30일 레거시 리디렉션 유지 후 삭제).

### DELETE (1개)

- `serve-image` — Supabase Storage public URL로 교체 후 30일 유예 기간 동안 리디렉션만 수행, 이후 Function 삭제.

---

## 이미지 URL 레거시 위치 (3곳)

| 파일:라인 | 현재 코드 | 교체 방법 |
|---|---|---|
| `index.html:2832` | `'/api/serve-image?key=' + encodeURIComponent(firstImageKey) + '&t=' + encodeURIComponent(token)` | `supabase.storage.from('lumi-images').getPublicUrl(storagePath).data.publicUrl` — `storagePath`는 `image-url-mapping.json`에서 조회 또는 `reservations.image_urls[0]` 컬럼에 저장 |
| `index.html:4087` | `'/.netlify/functions/serve-image?key=' + encodeURIComponent(thumbKey)` | 동일, 예약 목록 썸네일 |
| `index.html:4125` | `detailData.imageKeys.map(k => '/.netlify/functions/serve-image?key='+encodeURIComponent(k))` | `detailData.imageUrls` 우선 사용 (새로 채워지는 `reservations.image_urls` 배열) |

**레거시 리디렉션 플랜**: 30일 동안 `/ig-img/*` 및 `/api/serve-image` 요청은 `serve-image.js` Function이 `image-url-mapping.json` 기반으로 Supabase Storage URL로 302 리디렉션 → 30일 경과 후 Function + 매핑 파일 삭제.

---

## RLS 주의점 (가장 중요)

### 1. `profiles.plan` 컬럼 — 권한 상승 공격 방지

```sql
-- ❌ 잘못된 정책: UPDATE all columns
CREATE POLICY profiles_update ON profiles FOR UPDATE USING (auth.uid() = id);

-- ✅ 올바른 정책: plan 컬럼은 service_role만 수정
CREATE POLICY profiles_update_user ON profiles FOR UPDATE 
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id AND plan = (SELECT plan FROM profiles WHERE id = auth.uid()));
```

**이유**: 클라이언트가 `.update({ plan: 'pro' })`로 무료→프로 자가 승급 가능. column-level 제한 또는 trigger로 plan 변경 차단 필수.

### 2. `reservations` 폴링 — `reserve_key` 추측 공격 방지

```sql
CREATE POLICY reservations_select ON reservations FOR SELECT
  USING (auth.uid() = user_id);
```

**반드시** `.eq('reserve_key', rKey).eq('user_id', auth.uid())` 이중 필터. 단일 `reserve_key`만 조건이면 타인 예약 조회 가능.

### 3. `find-id` — DIRECT 절대 불가

이름 + 전화번호 + 생년월일로 이메일 조회. DIRECT면 `profiles.email` 전체 SELECT 권한 필요 → 스크래핑 공격. **반드시 Function 유지 + rate-limit**.

### 4. `ig_accounts.access_token` — Vault로 암호화

`access_token`, `page_access_token` 컬럼은 pgsodium Vault로 암호화 (`access_token_secret_id` 참조). `ig_accounts_decrypted` 뷰는 service_role만 접근. 클라이언트는 토큰 노출 절대 금지.

### 5. `rate_limits`, `oauth_nonces` — anon INSERT 차단

Service role로만 INSERT/UPDATE. 클라이언트는 호출 금지.

---

## localStorage → supabase-js 세션 전환 (Phase A → C 2단계)

### Phase A (이번 이전, 최소 변경)

- Function이 기존 응답 포맷 유지: `{ success, token, user: {...} }`
- 프론트 `lumi_token`, `lumi_user` localStorage 로직 **그대로 유지**
- Function 내부만 Supabase Auth JWT로 교체 (Function이 supabase-js로 `signIn` 후 반환)
- 프론트 코드 변경 최소화 → 빠른 배포

### Phase C (추후, 완전 전환)

- `supabase.auth.signInWithPassword` 직접 호출 → localStorage 제거
- `supabase.auth.onAuthStateChange` 리스너로 세션 관리
- Function의 Authorization Bearer 검증 → `supabase.auth.getUser()` 교체
- 60+ localStorage 참조 전부 `supabase.auth.getSession()`로 이관

**현 이전에서는 Phase A로 충돌 최소화, Phase C는 안정화 후 정식 출시 전까지 점진 교체.**

---

## 전환 작업 순서 (Day-by-Day)

### Day 1 — 저위험 DIRECT 8개
- `count-post`, `check-plan`, `get-trends`, `last-post`, `relay-list`, `get-reservation`, `cancel-reservation`, `disconnect-ig`
- 프론트 교체만, Function은 30일 유예 후 삭제

### Day 2 — `update-profile` + `serve-image` 교체
- `profiles` RLS 엄격히 (plan 컬럼 차단)
- `serve-image` 요청을 Storage public URL 직접 참조로 전환
- `/ig-img/*` 리디렉션 30일 플랜 적용

### Day 3 — 인증 FUNCTION 내부 교체 (Phase A)
- `register`, `login`, `find-id`, `send-otp`, `verify-otp`, `reset-password` 내부를 Supabase Auth로 교체
- 응답 포맷 유지 → 프론트 영향 0

### Day 4 — 결제 + 예약 FUNCTION 내부 교체
- `reserve`, `payment-prepare`, `payment-confirm`, `check-expiry`, `cancel-subscription`

### Day 5 — 게시 파이프라인 + IG OAuth
- `ig-oauth`, `process-and-post-background`, `select-and-post-background`, `scheduler`, `meta-webhook`

---

## 참고 문서

- Functions triage: `.omc/plans/functions-triage.md`
- 결정사항: `.omc/plans/migration-decisions.md`
- 마이그레이션 스크립트: `scripts/migrate-blobs-to-supabase.js`
- 스키마: `supabase/migrations/*.sql`
