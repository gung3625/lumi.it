# Reserve Rewrite Status (Phase B — Blobs → Supabase)

작성: 2026-04-18 · 작업자: oh-my-claudecode:executor
대상: `netlify/functions/reserve.js`, `netlify/functions/get-best-time.js`

## 1. 수정 요약

| 파일 | 성격 | 핵심 변경 |
|---|---|---|
| `netlify/functions/reserve.js` | 전면 재작성 | Blobs 완전 제거 → Supabase Auth 토큰 검증 + Storage 업로드 + `public.reservations` insert + `public.ig_accounts_decrypted` 뷰 조회 |
| `netlify/functions/get-best-time.js` | 재작성 | 단순 상수 반환 → Bearer 토큰 검증 + `reservations` 이력 조회 + 카테고리별 시간대 최빈값 계산(history) + 이력 부족 시 기본 슬롯 폴백 |

### reserve.js 주요 흐름
1. `extractBearerToken` + `verifyBearerToken` — `user.id` 확보
2. `busboy` multipart 파싱, 10MB 단일 파일 제한(`fileSize` limit) · JPEG/PNG/WebP 외 거부
3. `thumbnailFile` 필드는 `photos` 배열에서 제외 (기존과 동일)
4. `public.ig_accounts` → `user_id`로 `ig_user_id` 조회 → `public.ig_accounts_decrypted` 뷰로 토큰 평문 획득 (service_role)
5. `public.tone_feedback` like/dislike 각 20개 롤링 윈도우 조회
6. `public.users.custom_captions` 배열 → `|||` 조인
7. Supabase Storage `lumi-images` 버킷에 순차 업로드 (upsert=false). 실패 시 롤백
8. `public.reservations` insert — 실패 시 Storage 업로드 파일도 롤백
9. `process-and-post-background` 트리거 (LUMI_SECRET 유지)
10. 응답: `{ success: true, reserveKey, reservationKey, photoCount }` — 스펙(`reserveKey`) + 기존 프론트(`reservationKey`) 호환

### get-best-time.js 주요 흐름
1. Bearer 토큰 검증
2. `.from('reservations').select('posted_at, biz_category').eq('user_id', user.id).eq('caption_status', 'posted').order(desc).limit(200)`
3. 카테고리 필터 → 30분 버킷(HH:00 / HH:30)으로 빈도 집계 → 최빈값 반환
4. 이력 < 3건이면 업종 기본 슬롯(`BEST_TIMES[category]`) 폴백
5. `source: 'history' | 'category-default'` 및 `sampleSize` 필드 추가 (디버깅/UX용)
6. 기존 `module.exports.getTodayBestSlot`, `module.exports.BEST_TIMES` 유지 — 다른 Function에서 import 호환

## 2. Storage 업로드 경로 포맷

```
{user_id}/{reserveKey}/{timestamp}-{nonce}.{ext}
```

- `user_id`: `auth.uid()` (Supabase) — storage RLS 정책 `(storage.foldername(name))[1] = auth.uid()::text` 만족
  (단, 이 Function은 service_role로 업로드하므로 RLS 우회되지만 경로 포맷은 일관성 유지)
- `reserveKey`: `reserve:{Date.now()}` (기존 포맷 유지)
- `timestamp`: `Date.now()` (파일 단위 유니크성 보강)
- `nonce`: `crypto.randomBytes(8).toString('hex')` — 16자 hex, 예측 불가 (결정사항 #7 준수)
- `ext`: `image/jpeg → jpg`, `image/png → png`, `image/webp → webp`

Public URL: `supabase.storage.from('lumi-images').getPublicUrl(path).data.publicUrl`

## 3. `reservations` 컬럼 매핑

| Blobs(기존) 필드 | DB 컬럼 | 비고 |
|---|---|---|
| `photos[] (base64)` | `image_urls text[]`, `image_keys text[]` | base64를 더 이상 레코드에 저장하지 않음. URL과 Storage 객체 키만 저장 |
| `userMessage` | `user_message` | |
| `bizCategory` | `biz_category` | 기본 `cafe` |
| `captionTone` | `caption_tone` | |
| `tagStyle` | `tag_style` | 기본 `mid` |
| `weather { ..., airQuality }` | `weather jsonb` | airQuality는 PM2.5 등급 문자열 |
| `trends` | `trends jsonb` | |
| `storeProfile` | `store_profile jsonb` | |
| `postMode` | `post_mode` | `immediate|scheduled` CHECK |
| `scheduledAt` | `scheduled_at timestamptz` | |
| `submittedAt` | `submitted_at timestamptz` | |
| `storyEnabled` | `story_enabled` | `postToStory === 'true'` |
| `postToThread` | `post_to_thread` | |
| `nearbyEvent` | `nearby_event` | festivals.length > 0 |
| `nearbyFestivals` | `nearby_festivals text` | 요약 문자열 |
| `toneLikes` | `tone_likes text` | `|||` 조인 |
| `toneDislikes` | `tone_dislikes text` | `|||` 조인 |
| `customCaptions` | `custom_captions text` | `|||` 조인 |
| `relayMode` | `relay_mode` | 항상 true (릴레이 폐지) |
| `useWeather` | `use_weather` | |
| `isSent` | `is_sent` | false로 초기화 |
| — | `caption_status` | `'pending'` 초기화 (다운스트림 pipeline용) |
| `igUserId`, `igAccessToken`, `igPageAccessToken` | **저장 안 함** | 저장 시점에 토큰을 박제하지 않음. 다운스트림(`process-and-post-background`)이 `ig_accounts_decrypted` 뷰에서 다시 조회하는 것이 Split-brain 방지에 안전 |
| `reserveKey` | `reserve_key text UNIQUE` | 기존 포맷 `reserve:{ts}` 유지 |

**Blobs `user-index:{email}` 저장 없음** — 역인덱스는 `reservations_user_id_idx`, `reservations_user_scheduled_idx` DB 인덱스로 대체.

## 4. 검증

- `node -c netlify/functions/reserve.js` → OK
- `node -c netlify/functions/get-best-time.js` → OK
- `node -e "require('./netlify/functions/reserve')"` → handler function 로드 확인
- `node -e "require('./netlify/functions/get-best-time')"` → handler + getTodayBestSlot export 확인
- Grep `Blobs|getStore|NETLIFY_TOKEN|NETLIFY_SITE_ID|temp-img|user-index` 두 파일 공통 **0건**
- `reservations` 컬럼 전부 스키마(`20260418000000_initial_schema.sql`)에 존재 확인
- Storage 버킷명 `lumi-images` 정확 사용 확인 (`BUCKET` 상수)
- 업로드 10MB 제한 `busboy`의 `limits.fileSize` 로 enforce + 초과 시 413 응답

## 5. 이슈 / 의사결정

1. **IG 토큰을 reservation에 박제하지 않음** — 기존 Blobs 버전은 저장 시점 토큰을 스냅샷 했으나, Vault 설계(`ig_accounts_decrypted` 뷰)와 토큰 회전을 고려해 다운스트림이 재조회. 스플릿 브레인 가능성 감소. 기존 `process-and-post-background.js`는 Blobs를 읽으므로 **Day 3 재작성 시 `ig_accounts_decrypted` 뷰 조회로 교체 필요** (이 범위 밖, 미수정).
2. **응답 필드 중복** — 스펙은 `reserveKey`, 기존 프론트(`index.html:2152` 등)는 `reservationKey`를 읽음. 두 키 모두 포함해 점진적 전환 가능하게 유지. 프론트 재작성(Phase C)에서 `reservationKey` 제거 가능.
3. **이미지 base64 미저장** — 기존 레코드는 `photos[].base64` 를 그대로 들고 있었으나, 이제 `image_urls`로 URL만 전달. `process-and-post-background`가 base64 대신 URL fetch 하도록 Day 3 재작성 시 병행 필요.
4. **get-best-time 확장** — 기존에는 순수 상수 함수였으나 "유저 예약 이력 기반" 요구사항에 따라 인증 + DB 조회 추가. Supabase 없이도 동작하게 에러 폴백(기본 슬롯 반환) 유지.
5. **Storage RLS vs service_role** — service_role 업로드이므로 RLS 우회되지만 경로는 `{user.id}/...` 로 시작해 향후 프론트 직접 업로드 전환 시에도 호환되도록 설계.
6. **`caption_status: 'pending'` 초기화** — 스키마 CHECK 제약 통과. 이후 `process-and-post-background`가 `ready/posted/failed` 등으로 갱신.
7. **File size 초과 처리** — `busboy`가 `file.on('limit')` 이벤트로 truncation 알림. 단 하나라도 초과하면 전체 요청을 413으로 거부 (부분 업로드 방지).

## 6. 건드리지 않은 것 (지시 준수)

- 다른 Netlify Functions 전부 (`process-and-post-background.js` 포함)
- 프론트엔드 HTML 파일
- `supabase/migrations/*`
- `package.json` (이미 `@supabase/supabase-js` 설치됨)
- git commit/push

## 7. 다음 단계 추천 (참고)

- **Day 3 재작성**: `process-and-post-background.js` + `select-and-post-background.js`에서
  - Blobs `reservations` 읽기 → `supabase.from('reservations').select().eq('reserve_key', ...)`
  - Blobs `temp-img:*` → `image_urls`에서 fetch 또는 `image_keys`로 signed URL
  - IG 토큰 → `ig_accounts_decrypted` 뷰
- **프론트 통합**: `reserve.js` 응답 `reserveKey` 사용으로 전환 후 `reservationKey` alias 제거
- **Storage cleanup cron**: `reservations.cancelled = true` or 실패건의 이미지 정리 (`image_keys` → `storage.remove`)
