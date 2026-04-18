# Netlify Functions 분류 결과 (2026-04-18)

58개 Function을 **KEEP / REWRITE / DELETE / REFACTOR** 로 분류.

## 통계
- 전체: 58개
- **KEEP** (외부 API 필수, 유지): 12개
- **REWRITE** (Function 유지, 내부만 Supabase로): 10개
- **DELETE** (프론트 직접 Supabase 호출): 30개
- **REFACTOR** (혼재, 분리/재배치 필요): 7개 (일부 REWRITE/DELETE와 중복)

## KEEP (12개) — 외부 API/시크릿 필수

| 파일 | 역할 | 외부 API/비밀 | 비고 |
|---|---|---|---|
| `register.js` | 회원가입 | Resend(웰컴) + Solapi(알림톡) | 내부 Blobs→Supabase REWRITE 필요 |
| `send-otp.js` | OTP 이메일 | Resend + RESEND_API_KEY | rate-limit도 Supabase로 |
| `process-and-post-background.js` | 캡션 생성 + IG 게시 | OpenAI + IG Graph API + Solapi | Blobs→Supabase REWRITE |
| `select-and-post-background.js` | 선택 캡션 IG 게시 | IG Graph API + Solapi | Blobs→Supabase REWRITE |
| `regenerate-caption.js` | 캡션 재생성 | OpenAI | Blobs→Supabase REWRITE |
| `select-caption.js` | 캡션 선택 확정 | OpenAI | Blobs→Supabase REWRITE |
| `welcome-caption.js` | 첫 사용자 데모 | OpenAI | Blobs→Supabase REWRITE |
| `demo-caption.js` | 체험용 캡션 | OpenAI | Blobs→Supabase REWRITE |
| `payment-confirm.js` | 결제 확정 | PortOne + Resend | Blobs→Supabase REWRITE |
| `ig-oauth.js` | Facebook Login + IG | IG Graph + pageAccessToken | Blobs→Supabase REWRITE |
| `meta-webhook.js` | DM/댓글 웹훅 | IG Graph API | Blobs→Supabase REWRITE |
| `send-kakao.js` | 알림톡 전송 | Solapi | Blobs 미사용, 그대로 유지 |

## REWRITE (10개) — Function 유지, 내부 저장소만 교체

| 파일 | 역할 | 외부 API | 교체 대상 |
|---|---|---|---|
| `scheduled-trends.js` | 일 1회 트렌드 cron | OpenAI | `trends` → `trend_cache` 테이블 |
| `generate-calendar.js` | 캘린더 생성 | OpenAI | `users`, `cal` → `profiles`, `calendar` |
| `send-daily-schedule.js` | 아침 알림톡 cron | Solapi + KMA | `reservations`, `users` → Supabase |
| `send-notifications.js` | 종합 알림 cron | Solapi + Resend + PortOne | `users`, `reservations` → Supabase |
| `check-expiry.js` | 만료 임박 알림 | Resend | `users` → `profiles` |
| `cancel-subscription.js` | 구독 해지 | PortOne + Resend | `users` → `profiles` |
| `payment-prepare.js` | 결제 사전 등록 | PortOne | `orders` → `orders` 테이블 |
| `reserve.js` | 예약 생성 (사진) | IG Graph(검증) | `users`, `reservations`, `temp-images` → Storage+DB |
| `scheduler.js` | 1분 cron 예약 트리거 | 없음 | `reservations` → 테이블 |
| `beta-apply.js` | 베타 신청 | Solapi | `beta-applicants`, `beta-waitlist` → 테이블 |

## DELETE (30개) — 프론트가 Supabase SDK로 직접 호출

| 파일 | 현재 역할 | Supabase 대체 |
|---|---|---|
| `login.js` | 로그인 | `supabase.auth.signInWithPassword()` |
| `find-id.js` | 이메일 찾기 | `supabase.from('profiles').select()` |
| `verify-otp.js` | OTP 검증 | `supabase.auth.verifyOtp()` |
| `reset-password.js` | 비번 재설정 | `supabase.auth.updateUser()` |
| `update-profile.js` | 프로필 수정 | `supabase.from('profiles').update()` |
| `check-plan.js` | 플랜 확인 | `supabase.from('profiles').select('plan')` |
| `disconnect-ig.js` | IG 연동 해제 | `supabase.from('ig_accounts').delete()` |
| `unsubscribe-retention.js` | 리텐션 구독해제 | `supabase.from('profiles').update()` |
| `get-reservation.js` | 예약 조회 폴링 | `supabase.from('reservations').select()` |
| `cancel-reservation.js` | 예약 취소 | `supabase.from('reservations').update()` |
| `save-reservation.js` | 예약 저장 | `supabase.from('reservations').insert()` |
| `edit-caption.js` | 캡션 수정 | `supabase.from('reservations').update()` |
| `save-caption.js` | 캡션 이력 저장 | `supabase.from('caption_history').insert()` |
| `get-caption-history.js` | 캡션 이력 조회 | `supabase.from('caption_history').select()` |
| `tone-feedback.js` | 좋아요/싫어요 | `supabase.from('tone_feedback').insert()` |
| `get-trends.js` | 트렌드 캐시 읽기 | `supabase.from('trend_cache').select()` |
| `update-trends.js` | 트렌드 캐시 쓰기 | Service Role 경유 유지 검토 (LUMI_SECRET) |
| `get-link-page.js` | 링크 페이지 공개 조회 | `supabase.from('link_pages').select()` (RLS public) |
| `update-link-page.js` | 링크 페이지 수정 | `supabase.from('link_pages').upsert()` |
| `last-post.js` | 최근 게시 이미지 | Supabase Storage signed URL |
| `serve-image.js` | 이미지 바이트 서빙 | Storage public URL → Function 삭제 |
| `get-best-time.js` | 최적 시간 계산 | 순수 로직 → 프론트 실행 |
| `get-calendar.js` | 캘린더 조회 | `supabase.from('reservations').select()` |
| `get-weather-kma.js` | KMA 프록시 | 공개 API, CORS 확인 후 프론트 직접 |
| `get-air-quality.js` | 대기질 프록시 | 공개 API, CORS 확인 |
| `get-festival.js` | 축제 프록시 | 공개 API, CORS 확인 |
| `count-post.js` | 게시물 개수 | `supabase.select({ count: 'exact' })` |
| `feedback.js` | 피드백 수집 | `supabase.from('feedback').insert()` (테이블 신설) |
| `admin-reservations.js` | 운영자 대시보드 | Service Role + RLS로 대체 |
| `relay-list.js` | 릴레이 목록 | 폐지 기능, 즉시 삭제 |

## REFACTOR (7개) — 혼재 로직 분리

| 파일 | 혼재 이유 | 분리 방향 |
|---|---|---|
| `register.js` | Auth 생성 + 프로필 + 메일/알림톡 | Function 유지, 내부 REWRITE |
| `save-ig-token.js` | LUMI_SECRET + Blobs | `ig_accounts` upsert로 교체, Function 유지 (시크릿 보호) |
| `beta-admin.js` | LUMI_SECRET + Blobs CRUD | Function 유지, 내부 Supabase로 |
| `scheduled-trends.js` | OpenAI + Blobs | 이미 REWRITE 분류, OpenAI 로직 별도 검토 |
| `get-reservation.js` | LUMI_SECRET + 단순 조회 | DELETE + 프론트 직접, LUMI_SECRET 제거 |
| `migrate-user-index.js` | Blobs 역인덱스 빌더 | **마이그레이션 완료 후 즉시 삭제** |
| `diag-blobs.js` | Blobs 진단 도구 | **마이그레이션 완료 후 즉시 삭제** |

## 의존관계 / 주의사항

- **게시 파이프라인**: `scheduler.js` → `process-and-post-background.js` → `select-and-post-background.js` 순서. 세 파일 전부 Blobs 의존 → 순서대로 REWRITE.
- **가입 플로우**: `register.js` → `send-kakao.js` → `send-otp.js`. send-kakao만 독립 유지.
- **IG 토큰 Split-brain 방지**: `ig-oauth.js`(저장)와 `process-and-post-background.js`(조회)는 **동일 Day에 REWRITE**. 저장/조회 경로 일관성.
- **공공 API 프록시**: `get-weather-kma.js`, `get-air-quality.js`, `get-festival.js` 삭제 전 CORS 허용 여부 확인.

## 작업 우선순위

### Day 1 (저위험)
- DELETE: `get-trends.js`, `relay-list.js`, `feedback.js` 등 단순 CRUD
- REWRITE: `scheduled-trends.js`, `beta-apply.js`

### Day 2 (인증 + 예약)
- DELETE: `login.js`, `verify-otp.js`, `reset-password.js`, `update-profile.js`, 예약 CRUD 다수
- REWRITE: `register.js`, `reserve.js`

### Day 3 (IG + 게시 파이프라인)
- REWRITE: `ig-oauth.js`, `process-and-post-background.js`, `select-and-post-background.js` (묶음)
- REWRITE: `scheduler.js`, `meta-webhook.js`

### Day 4 (결제 + 구독)
- REWRITE: `payment-prepare.js`, `payment-confirm.js`, `cancel-subscription.js`, `check-expiry.js`
- REWRITE: `send-notifications.js`, `send-daily-schedule.js`

### Day 5 (QA + 정리)
- `migrate-user-index.js`, `diag-blobs.js` 삭제
- 통합 테스트, 배포
