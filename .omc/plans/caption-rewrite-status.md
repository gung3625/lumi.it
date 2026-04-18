# Caption Functions Blobs → Supabase 재작성 완료 (2026-04-18)

## 파일별 변경 요약

### 1. `regenerate-caption.js`
- **제거**: `@netlify/blobs` getStore (reservations, caption-regen, users, trends 스토어 전부)
- **추가**: `supabase-admin.js` + `supabase-auth.js` 공유 모듈 사용
- **인증**: Blobs `token:*` 키 조회 → `verifyBearerToken()` (Supabase JWT)
- **재생성 제한**: Blobs `caption-regen` 월별 카운터 → `reservations.regenerate_count` 컬럼 (건당 최대 3회)
- **예약 조회**: `reserveStore.get(key)` → `.from('reservations').eq('reserve_key').eq('user_id')` (IDOR 방지)
- **말투 학습 데이터**: Blobs `tone-like:*`/`tone-dislike:*` → `tone_feedback` 테이블 SELECT
- **dislike 저장**: Blobs set → `tone_feedback` INSERT (20개 롤링 DELETE + INSERT)
- **예약 업데이트**: Blobs set → `.update({ captions, generated_captions, regenerate_count, captions_generated_at, caption_status })`
- **캡션뱅크**: Blobs trends store → `caption_bank` 테이블 SELECT
- **OpenAI**: gpt-5.4 Responses API + Moderation API 전부 유지

### 2. `select-caption.js`
- **제거**: `@netlify/blobs` getStore (reservations, temp-images, users 스토어)
- **인증**: Blobs `token:*` + LUMI_SECRET 이중 인증 → `verifyBearerToken()` 단일 Bearer 인증
- **예약 조회**: Blobs get → `.from('reservations').eq('reserve_key').eq('user_id')` (IDOR 자동 처리)
- **like 저장**: Blobs users store → `tone_feedback` INSERT (20개 롤링)
- **캡션 선택 저장**: Blobs set → `.update({ selected_caption_index, captions, caption_status })`
- **즉시 게시 트리거**: `select-and-post-background` 호출 유지 (userId로 변경, email 제거)
- **트리거 실패 롤백**: Blobs set → Supabase `.update({ caption_status: 'ready' })`

### 3. `welcome-caption.js`
- **제거**: `@netlify/blobs` getStore (users 스토어 — token 조회용으로만 사용됐음)
- **인증**: Blobs `token:*` 조회 → `verifyBearerToken()` (Supabase JWT)
- **DB 저장**: 없음 — 원본과 동일하게 응답만 반환 (첫 방문 데모, 저장 불필요)
- **OpenAI**: gpt-4o Chat Completions API 전부 유지

### 4. `demo-caption.js`
- **제거**: `@netlify/blobs` getStore (demo-rate 스토어)
- **추가**: `supabase-admin.js` (service_role, rate_limits 접근)
- **Rate-limit**: Blobs `demo-rate:${ip}` → `rate_limits` 테이블 (kind=`demo-caption:YYYY-MM-DD`, ip)
  - 하루 단위 리셋 (kind에 날짜 포함)
  - 조회: `.maybeSingle()` + upsert로 카운트 증가
- **인증**: 없음 유지 (비로그인 체험용)
- **DB 저장**: 없음 유지 (캡션 반환만)
- **OpenAI**: gpt-4o 이미지 분석 + gpt-5.4 Responses API 전부 유지

---

## 20개 롤링 구현 방식

`tone_feedback` 테이블에서 user_id + kind 기준으로:

1. 기존 행 전체 SELECT (created_at ASC 정렬)
2. `기존 개수 + 새로 추가할 개수 > 20` 이면 오래된 행부터 DELETE
3. 새 행 INSERT

삭제 개수 = `(기존 개수 + 새 개수) - 20`

### 적용 위치
- `regenerate-caption.js`: 기존 captions 배열 전체를 dislike로 추가 (재생성 = 싫어한 스타일)
- `select-caption.js`: 선택한 캡션 1개를 like로 추가 (선택 = 좋아한 스타일)

---

## 말투 학습 경로

```
재생성 요청
  → tone_feedback WHERE kind='dislike' ORDER BY created_at DESC LIMIT 20
  → buildToneGuide(toneLikes, toneDislikes)
  → GPT 프롬프트에 "❌ 싫어했던 스타일" 주입

선택 확정
  → tone_feedback INSERT { kind: 'like', caption: selectedCaption }
  → 다음 regenerate 시 "✅ 좋아했던 스타일"로 활용
```

---

## 이슈 및 주의사항

### regenerate_count 컬럼 누락
- 초기 스키마(`20260418000000_initial_schema.sql`)에 `regenerate_count` 컬럼 없음
- 새 마이그레이션 `20260418000005_add_regenerate_count.sql` 추가 후 적용 완료
- 기존 migrations 파일은 수정하지 않음

### select-caption.js — select-and-post-background 호출 변경
- 기존: `email` 파라미터 전달 (Blobs 조회용)
- 변경: `userId` (user.id) 전달 — `select-and-post-background.js`가 아직 Blobs 기반이면 해당 파일 REWRITE 시 userId 수신 처리 필요

### rate_limits upsert first_at 처리
- upsert 시 `first_at`은 신규 행에만 설정 (currentCount === 0 조건)
- 기존 행 update 시 `first_at` undefined → Supabase가 해당 필드 무시

### demo-caption rate-limit 정책 변경
- 기존: IP당 영구 3회 (Blobs에 날짜 무관하게 저장)
- 변경: IP당 **하루** 3회 (kind에 날짜 포함 → `demo-caption:YYYY-MM-DD`)
- 결정 근거: 태스크 요구사항 "IP당 하루 N회" 명시
