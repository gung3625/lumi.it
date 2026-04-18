# IG 파이프라인 Supabase 재작성 현황 (2026-04-18)

## 범위

5개 Function을 Blobs → Supabase 로 일괄 재작성 (split-brain 방지 목적으로 동시 작업):

- `netlify/functions/ig-oauth.js`
- `netlify/functions/process-and-post-background.js`
- `netlify/functions/select-and-post-background.js`
- `netlify/functions/meta-webhook.js`
- `netlify/functions/scheduler.js`

다른 파일은 터치하지 않음 (`reserve.js`, `save-ig-token.js`, `regenerate-caption.js`, `select-caption.js`, 프론트엔드 등 미변경 — 이후 별도 작업으로 마이그레이션 예정).

---

## 파일별 변경 요약

### 1. `ig-oauth.js`
- `@netlify/blobs` import 제거 → `_shared/supabase-admin` 의 `getAdminClient()` 사용.
- CSRF nonce: 기존 `oauth-nonce` Blobs 스토어 → `public.oauth_nonces` 테이블.
  - key prefix `ig:<nonce>` 로 저장해 OTP(`otp:*`)·인증(`otp-verified:*`) 네임스페이스와 충돌 방지.
  - 생성 시 `user_id`, `lumi_token` 둘 다 저장 가능. 콜백 진입부 쿼리스트링 `user_id` 사용 권장.
  - 10분 TTL 은 `created_at` 비교로 검증, 일회성 사용 후 DELETE.
- 장기 토큰 `longTokenData.expires_in` → `token_expires_at` 로 환산 저장.
- Facebook Pages 탐색 시 `instagram_business_account{id,username}` 로 한 번에 username 확보 → `ig_accounts.ig_username` 기록.
- 저장 흐름:
  1. `ig_accounts` 기본 row upsert (user_id, ig_user_id, ig_username, page_id, token_expires_at, connected_at, updated_at).
  2. 기존 row 의 `access_token_secret_id`/`page_access_token_secret_id` 조회 (재연동 시 동일 Vault 레코드 덮어쓰기).
  3. `supabase.rpc('set_ig_access_token', ...)` 호출 → secret_id 반환.
  4. page_access_token 이 있으면 `supabase.rpc('set_ig_page_access_token', ...)`.
  5. 반환된 secret_id 를 `ig_accounts` 에 update.
- 최종 리다이렉트: 요구사항대로 `Location: /?ig=connected` (기존 `/?oauth_success=1` 변경).
- 실패 코드: 기존 1/2/3/99 외에 4(nonce 만료), 5(ig_accounts upsert), 6(access RPC), 7(secret_id 저장) 추가.
- 로그: **ig_user_id 외 토큰/secret_id/개인정보 일체 로그 금지**.

### 2. `process-and-post-background.js`
- `@netlify/blobs`, `getStore` 전부 제거. `getAdminClient()` 로 단일 관문.
- 인증(LUMI_SECRET) / CORS / try-catch 유지.
- 예약 조회: `reservations.select('*').eq('reserve_key', reservationKey).maybeSingle()`.
- 이미지: `reservation.image_urls[]` 를 원격 fetch → base64 변환 후 GPT-4o 에 전달.
  (Supabase Storage public URL 이므로 CDN 경유, 기존 `ig-img/` 레거시 경로는 사용하지 않음.)
- 말투 학습: `tone_feedback` 테이블에서 `user_id`, `kind`(like/dislike) 기준 최근 20개 → `|||` 조인. (기존 Blobs `tone-like:`, `tone-dislike:` 대체.)
- 커스텀 캡션: `users.custom_captions[]` 사용.
- 트렌드: `trends.select('keywords, insights').eq('category', bizCat)`. keywords 는 text 또는 object 배열 모두 허용.
- 캡션뱅크: `caption_bank.select('caption').eq('category', bizCat).order('rank').limit(3)`.
- 캡션 생성 후 `reservations.update({ generated_captions, captions, image_analysis, captions_generated_at, caption_status: 'ready' })`.
- 사용자 이미 `scheduled`/`posting`/`posted` 상태면 스킵 — 기존 동작 보존.
- 에러 시 `caption_status='failed'`, `caption_error`, `generated_captions=[]`, `captions_generated_at` 업데이트.
- OpenAI Responses API (gpt-5.4) / Moderation API / GPT-4o 호출 로직 전면 보존.
- 알림톡 로직 주석 유지 (기존 솔라피 템플릿 미승인 상태 그대로).
- IG 게시 로직은 이 파일에서 수행하지 않음 — 사용자 캡션 선택 후 `select-and-post-background` 가 전담 (기존 릴레이 폐지 플로우 준수).

### 3. `select-and-post-background.js`
- Blobs 완전 제거, `getAdminClient()` 사용.
- 예약/캡션/이미지 전부 Supabase 에서 조회.
- IG 토큰: `ig_accounts_decrypted.select('ig_user_id, access_token, page_access_token').eq('user_id', reservation.user_id).maybeSingle()`.
  - `page_access_token`(피드/캐러셀용) + `access_token`(스토리용) 명확히 분리.
- 중복 호출 방지: `caption_status='posting'` 선 마킹.
- 캐러셀/단일 이미지 브랜치 유지 (Promise.all 로 container 병렬 생성).
- 스토리 게시: 유저 토큰(`access_token`) 명시적으로 사용.
- Threads 게시 로직 유지. 단 reservations 스키마에 `threads_*` 컬럼이 없으므로 DB 반영은 보류 (로그·알림톡만).
- 완료 시 `reservations.update({ is_sent:true, caption_status:'posted', selected_caption_index, ig_post_id, posted_at })`.
- 캡션 히스토리: `caption_history.insert({ user_id, caption, caption_type:'posted' })`.
- 실패 시 `caption_status='failed'`, `caption_error` 저장. `postCount` 관련 로직은 Blobs 전용 → 제거 (users 테이블에 대응 컬럼 없음. 추후 집계 뷰/함수로 재도입 예정).
- 알림톡: `reservation.store_profile.phone|ownerPhone` 로 발송 (기존 경로 유지).
- 이전 게시물 이미지 롤링(last-post-images)·temp-images cleanup 은 **Storage 로 이전 완료되면 reserve.js 단계에서 처리** — 이 Function 범위 밖이라 제거.

### 4. `meta-webhook.js`
- `@netlify/blobs` 제거. `getAdminClient()` 사용.
- 서명 검증(`x-hub-signature-256`) 유지.
- 토큰 + user_id 동시 조회: `ig_accounts_decrypted` 뷰 단건 조회 → 기존 `ig:<id>`, `email-ig:<email>` 2회 호출 대체.
- 자동응답 설정(`auto_replies`) 테이블은 현재 스키마에 부재 → `getAutoReplySettings` 는 null 반환하도록 안전 스텁. 추후 테이블 추가 시 이 함수만 확장.
- 테스트용 `TEST_IG_USER_ID` / `TEST_IG_ACCESS_TOKEN` 우회 유지.
- Graph API 호출 로그에서 응답 본문(토큰·개인정보 포함 가능) 제거 — ok/error 플래그만 기록.

### 5. `scheduler.js`
- Blobs `reservations` 전체 list → `public.reservations` 조회로 교체.
- 필터: `is_sent=false`, `cancelled=false`, `scheduled_at <= now()`. 최대 50건 / `scheduled_at ASC`.
- 분기 로직 기존 유지:
  - `post_mode='immediate'` → 스킵 (즉시 모드는 select-caption 플로우가 담당).
  - `caption_status='scheduled'` + `selected_caption_index` 있음 → `select-and-post-background` 호출.
  - `caption_status in ('ready','posting','failed')` → 스킵.
  - 그 외(pending 등) → `process-and-post-background` 호출.
- Netlify cron `module.exports.config = { schedule: '* * * * *' }` 유지.
- 트리거 시 `Authorization: Bearer ${LUMI_SECRET}` 헤더 유지.

---

## Vault RPC 사용 정확한 형태

```js
// 기존 secret_id 조회 (재연동 시 동일 Vault 레코드에 update_secret)
const { data: existingRow } = await supabase
  .from('ig_accounts')
  .select('access_token_secret_id, page_access_token_secret_id')
  .eq('ig_user_id', igUserId)
  .maybeSingle();

// access token (필수)
const { data: accessSecretId, error: accessErr } = await supabase.rpc('set_ig_access_token', {
  p_ig_user_id: igUserId,
  p_existing_secret: existingRow?.access_token_secret_id ?? null,
  p_access_token: longToken,
});

// page access token (옵션)
const { data: pageSecretId, error: pageErr } = await supabase.rpc('set_ig_page_access_token', {
  p_ig_user_id: igUserId,
  p_existing_secret: existingRow?.page_access_token_secret_id ?? null,
  p_page_token: pageAccessToken,
});
```

- 시그니처 (migration 파일 기준): `set_ig_access_token(text, uuid, text) returns uuid`, `set_ig_page_access_token(text, uuid, text) returns uuid`.
- `security definer` 함수 → 호출 주체는 반드시 service_role(`SUPABASE_SERVICE_ROLE_KEY`). `getAdminClient()` 가 이 키를 사용.
- 반환된 uuid 를 그대로 `ig_accounts.access_token_secret_id` / `page_access_token_secret_id` 에 저장.
- 토큰 평문은 **어느 테이블에도 저장되지 않음** — `ig_accounts_decrypted` 뷰로만 접근.

---

## 스키마 컬럼명 매핑 테이블

### ig_accounts (Blobs `users` 스토어의 `ig:{igUserId}` 대체)

| Blobs (기존) | Supabase 컬럼 | 비고 |
|---|---|---|
| `igUserId` | `ig_user_id` (PK) | text |
| `accessToken` | `access_token_secret_id` (uuid → Vault) | 평문 컬럼 없음 |
| `pageAccessToken` | `page_access_token_secret_id` (uuid → Vault) | |
| `email`/Blobs `email-ig:` | `user_id` (auth.users FK) | email 이 아닌 auth uid 기준 |
| `connectedAt` | `connected_at` | timestamptz |
| (신규) | `ig_username` | IG Graph 에서 함께 조회 |
| (신규) | `page_id` | Facebook Page id |
| (신규) | `token_expires_at` | 장기 토큰 만료 |

### reservations (Blobs `reservations` 스토어 대체)

| Blobs (기존) | Supabase 컬럼 | 비고 |
|---|---|---|
| blob key `reserve:{ts}` | `reserve_key` (unique) | 기존 포맷 그대로 |
| `storeProfile.ownerEmail` | `user_id` (auth uid) | email→uid 해석 reserve.js 단계에서 수행 |
| `photos[]` (base64) | — | Storage 업로드로 대체, DB 에는 URL만 |
| `imageUrls[]` | `image_urls text[]` | Storage public URL |
| `tempKeys`/`imageKeys` | `image_keys text[]` | Storage 객체 경로 |
| `userMessage` | `user_message` | |
| `bizCategory` | `biz_category` | |
| `captionTone` | `caption_tone` | |
| `tagStyle` | `tag_style` | |
| `weather` | `weather` (jsonb) | |
| `trends` | `trends` (jsonb) | |
| `storeProfile` | `store_profile` (jsonb) | 기존 객체 형태 유지 |
| `postMode` | `post_mode` | 'immediate' \| 'scheduled' |
| `scheduledAt` | `scheduled_at` | timestamptz |
| `submittedAt` | `submitted_at` | |
| `storyEnabled` | `story_enabled` | |
| `postToThread` | `post_to_thread` | |
| `nearbyEvent` | `nearby_event` | |
| `nearbyFestivals` | `nearby_festivals` | text |
| `toneLikes` | (별도 테이블 `tone_feedback`, kind='like') | |
| `toneDislikes` | (별도 테이블 `tone_feedback`, kind='dislike') | |
| `customCaptions` | (users.custom_captions[]) | |
| `relayMode` | `relay_mode` | 레거시 호환 (항상 true) |
| `useWeather` | `use_weather` | |
| `isSent` | `is_sent` | |
| `cancelled` | `cancelled` | |
| `captionStatus` | `caption_status` | CHECK (pending/ready/scheduled/posting/posted/failed) |
| `captionError` | `caption_error` | |
| `generatedCaptions` | `generated_captions` (jsonb) | |
| `captions` | `captions` (jsonb) | |
| `selectedCaptionIndex` | `selected_caption_index` | int |
| `imageAnalysis` | `image_analysis` | text |
| `captionsGeneratedAt` | `captions_generated_at` | |
| `sentAt` | `posted_at` | 컬럼명 변경 |
| `instagramPostId` | `ig_post_id` | 컬럼명 변경 |

### oauth_nonces (Blobs `oauth-nonce` 스토어 대체)

| Blobs (기존) | Supabase 컬럼 |
|---|---|
| blob key `nonce:{rand}` | `nonce` (PK). 사용처별 prefix: `ig:*` (IG OAuth), `otp:*`/`otp-verified:*` (auth Stack) |
| `{ token, createdAt }` JSON | `user_id` (uuid), `lumi_token` (text), `created_at` (timestamptz 자동) |

### trends / caption_bank

| Blobs (기존) | Supabase |
|---|---|
| `trends` Blobs `caption-bank:{bizCat}` | `caption_bank` 테이블 (category, caption, rank) |
| `/api/get-trends?category=` 프록시 | `trends` 테이블 (`keywords jsonb`, `insights text`) 직접 조회 |

---

## Split-brain 방지 검증 (저장 ↔ 조회 경로 일치)

| 경로 | ig-oauth.js (저장) | 하위 3개 Function (조회) |
|---|---|---|
| IG 계정 키 | `ig_accounts.ig_user_id` 로 upsert | 동일 PK 조회 |
| 사용자 연결 | `ig_accounts.user_id` = Supabase auth uid | `reservations.user_id` 와 동일 uid 사용 → `ig_accounts_decrypted.eq('user_id', reservation.user_id)` |
| access token | `set_ig_access_token()` → Vault 저장, secret_id 반환 | `ig_accounts_decrypted.access_token` (service_role 전용 뷰) |
| page access token | `set_ig_page_access_token()` → Vault 저장 | `ig_accounts_decrypted.page_access_token` |
| 토큰 만료 | `token_expires_at` 기록 | (현재 조회 로직 없음 — 향후 재연동 알림 로직에서 사용 예정) |
| nonce | `oauth_nonces.insert({ nonce:'ig:...', user_id, lumi_token })` | 동일 키로 조회/DELETE 일회용 |

**검증 포인트:**
- `ig-oauth` 가 기록한 `ig_accounts.user_id` ↔ `reservations.user_id` 모두 Supabase auth uid (uuid). 동일 기준이므로 split-brain 없음.
- `meta-webhook` 은 Graph API 가 전달하는 `entry.id`(= Instagram User ID) 를 `ig_accounts_decrypted.eq('ig_user_id', igUserId)` 로 조회 → `ig-oauth` 저장 키와 일치.
- `process-and-post-background` 와 `select-and-post-background` 는 공통적으로 `reservation.user_id` 로 `ig_accounts_decrypted` 단건 조회 → 토큰 경로 단일화.
- `scheduler` 는 토큰을 직접 만지지 않고 트리거만 수행 → split-brain 없음.

---

## 구문 검증 결과

```
$ node -c netlify/functions/ig-oauth.js                      → OK
$ node -c netlify/functions/process-and-post-background.js   → OK
$ node -c netlify/functions/select-and-post-background.js    → OK
$ node -c netlify/functions/meta-webhook.js                  → OK
$ node -c netlify/functions/scheduler.js                     → OK
```

### Blobs/토큰 환경변수 잔존 확인
```
$ grep -E "@netlify/blobs|getStore|NETLIFY_TOKEN|NETLIFY_SITE_ID" <5 files>
→ No matches found  (5개 파일 모두)
```

---

## 발견된 이슈 / 다음 단계

### 즉시 대응 필요 (이 작업 범위 밖)
1. **`reserve.js` 가 아직 Blobs 를 사용** — `reservations` 테이블에 예약을 insert 하지 않으면 이 작업의 5개 Function 이 호출되어도 Supabase 조회에서 "not found" 로 종료됨. **다음 작업으로 `reserve.js` 를 Supabase + Storage 업로드 방식으로 재작성 필수**.
2. **`save-ig-token.js`** 도 동일 Blobs 경로 사용. 내부에서 Vault RPC 로 치환해야 ig-oauth 와 split-brain 방지 유지.
3. **`select-caption.js` / `regenerate-caption.js` / `welcome-caption.js` / `demo-caption.js`** 도 같은 Blobs 파이프라인 참조 가능성 있음. 순차 REWRITE 필요.
4. **`last-post.js` / `serve-image.js`** 가 여전히 Blobs `last-post-images`, `temp-images` 참조. Storage 이행 완료 시 삭제.

### 신규 컬럼 필요 (스키마 확장 검토 항목)
- `reservations.threads_status` / `threads_post_id` / `threads_error` / `threads_attempted_at` — 현재 select-and-post 에서 로그만 기록하고 있음.
- `users.post_count_month` / `post_count` / `last_posted_at` — postCount 집계 컬럼 또는 집계 뷰/함수 필요 (select-and-post 에서 Blobs 시절 증감 로직을 일시 제거).
- auto_replies 테이블 — meta-webhook 의 DM/댓글 자동 응답 설정 저장용. 현재 스텁 상태.

### 보안/운영 확인 사항
- `ig_accounts_decrypted` 뷰는 `security_invoker=true`. service_role 만 SELECT 가능. Functions 는 `SUPABASE_SERVICE_ROLE_KEY` 경유이므로 OK.
- 토큰/secret_id 는 5개 파일 어디에서도 `console.log` 되지 않음 (ig_user_id 와 상태 플래그만 기록).
- `oauth_nonces` 정책 없음 → service_role 만 접근 가능 (스키마 의도에 부합).
- CORS 헤더는 기존 스타일 유지 (`Access-Control-Allow-Origin: *`).

### 테스트 플랜 (다음 에이전트가 수행할 것)
1. `reserve.js` REWRITE 완료 후 end-to-end:
   - IG OAuth → ig_accounts/Vault 저장 확인
   - 예약 생성 → reservations row 확인
   - scheduler cron → process-and-post 트리거 확인
   - 캡션 생성 → `caption_status='ready'`
   - 사용자 선택 → select-and-post → IG 게시 + `is_sent=true`
   - meta-webhook GET verify (`hub.challenge` 응답)
2. `scripts/verify-vault.js` 재실행 — 재연동 시 동일 secret_id 재사용 검증.
3. Netlify 배포 후 curl 로 각 엔드포인트 status 확인.

---

## 상태

**완료**: 5개 Function 전부 Blobs 제거, Supabase 재작성. 구문 검증 통과. Split-brain 경로 일치.

**블로커**: `reserve.js` 가 아직 Blobs 이므로 실제 end-to-end 실행은 불가 — 해당 파일 이행 전까지 이 5개 Function 은 Supabase 에 reservations row 가 이미 존재해야만 동작.
