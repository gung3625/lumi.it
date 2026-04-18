# Final Wave — Day 4 REWRITE + 스키마 보강 + 프론트 otpToken 연결 보고

## 1. 수정 파일 요약

### A. REWRITE Functions (Blobs → Supabase)

| 파일 | 원본 | 수정 후 | 주요 변경 |
|---|---|---|---|
| `netlify/functions/save-ig-token.js` | 77줄 | 146줄 | Blobs `users` 스토어 → `ig_accounts` upsert + Vault RPC(`set_ig_access_token`, `set_ig_page_access_token`). LUMI_SECRET `timingSafeEqual` 인증 유지. `email → user_id` 해석 후 ig_accounts upsert → 기존 secret_id 재사용. |
| `netlify/functions/generate-calendar.js` | 499줄 | 436줄 | Blobs `calendar-rate`, `users`, `calendars` 완전 제거. 비로그인 rate limit → `rate_limits` 테이블(kind='calendar'). 로그인 사용자 캘린더 저장 → `reservations` 테이블(`post_mode='scheduled'`, `reserve_key='cal:{user_id}'` upsert). Bearer 검증 = `verifyBearerToken`. |
| `netlify/functions/send-daily-schedule.js` | 179줄 | 179줄 | Blobs `users`/`trends` → `users.in(['standard','pro'])` + `trends.in(['trends:cafe', ...])`. KMA 날씨/Solapi 로직 유지. |
| `netlify/functions/send-notifications.js` | 635줄 | 569줄 | Blobs `users`/`beta-applicants` → `users` 전체 SELECT + `caption_history`/`orders` 집계. 발송 이력은 `rate_limits`(ip='notification', kind='notif:{key}:{userId}')로 저장. 구독 만료는 `orders.eq('status','paid')` 최신 + 30일. 운영자 SMS/베타 카운트는 `beta_applicants` COUNT. |
| `netlify/functions/beta-admin.js` | 60줄 | 93줄 | Blobs `beta-applicants` + `rate-limit` → `beta_applicants SELECT` + `rate_limits`(kind='beta-admin') 재활용. LUMI_SECRET `timingSafeEqual` 유지. 실패 5회/10분 초과 시 429. |

### B. 스키마 보강

신규 마이그레이션: `supabase/migrations/20260418000006_users_feat_toggles.sql`

```sql
alter table public.users
  add column if not exists feat_toggles jsonb not null default '{}'::jsonb;
```

### C. 프론트 otpToken 연결 (index.html)

수정 위치 2곳 (총 +2줄):

| 라인 | 변경 |
|---|---|
| L5027 (신규) | `if (data && data.otpToken) { liData.otpToken = data.otpToken; }` — `verify-otp` 응답의 otpToken을 liData에 저장 |
| L5052 | `reset-password` body에 `otpToken: liData.otpToken` 추가 |

## 2. 스키마 변경 적용 결과

```
$ node scripts/apply-one.js supabase/migrations/20260418000006_users_feat_toggles.sql
OK 20260418000006_users_feat_toggles.sql
```

후속 검증:

```
$ node -e "SELECT column_name,data_type,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='feat_toggles'"
[
  {
    column_name: 'feat_toggles',
    data_type: 'jsonb',
    column_default: "'{}'::jsonb"
  }
]
```

`scripts/verify-schema.js` 재실행 — 기존 테이블/뷰/함수/Storage 버킷 모두 정상, Vault 함수 등록 확인.

## 3. otpToken 연결 diff

```diff
# index.html L5026-5028
      if (res.ok) {
+       if (data && data.otpToken) { liData.otpToken = data.otpToken; }
        liPhase = 2;

# index.html L5051
-   var res = await fetch('/api/reset-password', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email: liData.forgotEmail, password: pw}) });
+   var res = await fetch('/api/reset-password', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email: liData.forgotEmail, password: pw, otpToken: liData.otpToken}) });
```

HTML 파서 검증 통과: `python3 -c "import html.parser; html.parser.HTMLParser().feed(...)"` OK.

## 4. 검증 결과

### 구문 검증 (`node -c`)
```
save-ig-token.js       OK
generate-calendar.js   OK
send-daily-schedule.js OK
send-notifications.js  OK
beta-admin.js          OK
```

### Blobs 참조 0건 확인
```
$ grep -E "@netlify/blobs|getStore|NETLIFY_SITE_ID|NETLIFY_TOKEN" \
    netlify/functions/{save-ig-token,generate-calendar,send-daily-schedule,send-notifications,beta-admin}.js
No matches found
```

### 스키마
- `users.feat_toggles jsonb DEFAULT '{}'` 적용 확인
- 전체 테이블/RLS/Vault 함수/Storage 버킷 정상

## 5. 남은 DELETE-category Functions (정보 차원, 행동 안 함)

아래 파일은 이번 범위 밖. 역할이 완전히 Supabase에 이행된 후 후속 cleanup 작업에서 제거 예정:

- `netlify/functions/diag-blobs.js` — Blobs 진단 유틸 (이행 종료 후 불필요)
- `netlify/functions/migrate-user-index.js` — 일회성 마이그레이션 스크립트
- `netlify/functions/get-calendar.js` — 구 Blobs `calendars:{email}` 조회용 (generate-calendar가 reservations 경로 사용 시 Supabase 조회로 교체 또는 삭제)
- `netlify/functions/save-caption.js` — 구 Blobs `caption-history` 경로 (신규 REWRITE 범위 재점검 필요)
- `netlify/functions/save-reservation.js` — 구 Blobs `reservations` 경로 (reserve.js Supabase로 이행 완료 상태 전제)
- `netlify/functions/save-auto-reply.js` — meta-webhook 자동응답 (auto_replies 테이블 미존재, 후속 스키마 확장 필요)
- `netlify/functions/update-link-page.js` — linkpages 이전 확인 필요
- `netlify/functions/update-profile.js` — 프론트가 DIRECT 교체 진행 중. feat_toggles 컬럼 추가됐으므로 L4010 DIRECT로 치환 가능

## 6. 다음 단계 (배포 전 체크리스트)

### 필수 확인
- [ ] `netlify dev` 로 로컬 구동 후 각 엔드포인트 smoke test:
  - `POST /api/save-ig-token` (LUMI_SECRET + igUserId/accessToken/email) → 200 + ig_accounts insert 확인
  - `POST /api/generate-calendar` (비로그인) → 200 + rate_limits INSERT/UPDATE 확인
  - `POST /api/generate-calendar` (Bearer) → 200 + reservations upsert 확인
  - `POST /api/beta-admin` (LUMI_SECRET) → 200 + 신청자 목록 반환
  - scheduled: send-daily-schedule / send-notifications 수동 호출(`x-lumi-secret`)
- [ ] 프론트 `index.html` OTP 플로우 end-to-end:
  1. 로그인 모달 → "비밀번호 찾기" 클릭
  2. 이메일 → OTP 발송 → 6자리 입력 → 인증 → `liData.otpToken` 세팅 확인(콘솔)
  3. 새 비밀번호 입력 → 변경 성공 → 로그인 가능

### 보안/운영
- [ ] `users.retention_unsubscribed`, `users.agree_marketing` 플래그 기반 수신거부 동작 재검증 (send-notifications)
- [ ] Solapi 알림톡 템플릿 ID 실제 승인 여부 재확인 (monthly_report/season_event/first_post_coach/expiry_d7 플레이스홀더 ID 사용 중)
- [ ] `rate_limits` 테이블에 `kind='notif:*'` 발송 이력이 누적됨 — 필요 시 오래된 row 정리 cron 설계

### 알려진 제약 (후속 작업 대상)
- `send-notifications.js`: `users.post_count`/`last_posted_at` 컬럼 부재 → `caption_history` 집계로 대체. 유저 수 증가 시 쿼리 비용 상승 → postgres view(`v_user_post_stats`) 도입 권장.
- `send-notifications.js`: 구독 만료일은 `orders.status='paid'` 최신 + 30일로 근사. 실제 갱신/환불 이력과 불일치 가능 → `users.subscription_end` 또는 `orders.expires_at` 컬럼 신설 고려.
- `generate-calendar.js`: 로그인 사용자 캘린더는 `reservations`(reserve_key='cal:{user_id}')에 단건 upsert. 별도 `calendars` 테이블 신설 시 재설계 필요.
- `save-ig-token.js`: `email → user_id` 해석 실패 시 400 — 내부 호출 측에서 email이 항상 존재하는지 재확인 필요.

## 7. 금지사항 준수 확인

- [x] 지정 5개 Function만 수정, 다른 파일 무수정
- [x] HTML 중 index.html만 수정 (settings.html, subscribe.html 무수정)
- [x] 기존 마이그레이션 0000~0005 무수정 (신규 0006만 추가)
- [x] 새 테이블 생성 없음 (컬럼 추가만)
- [x] git commit/push 없음
