# 결제·구독 Functions Supabase 재작성 상태 (2026-04-18)

**범위:** payment-prepare / payment-confirm / cancel-subscription / check-expiry 4개 파일
**작업:** Blobs → Supabase (`public.orders`, `public.users`) 전면 교체
**상태:** 완료 (구문 검증 통과, 잔존 Blobs 참조 0건)

---

## 1. 수정 파일 요약

| 파일 | 인증 | 대상 테이블 | 외부 API | 주요 변경 |
|---|---|---|---|---|
| `netlify/functions/payment-prepare.js` | `verifyBearerToken` | `public.orders` INSERT, `public.users` SELECT | PortOne v2 (후속 단계) | Blobs `orders` 스토어 → `orders` 테이블. orderId는 PortOne v2 paymentId 용도로 `portone_payment_id` 컬럼에 저장. 플랜 가격을 현 요금제(스탠다드 19,900 / 프로 29,900)로 정리(베이직 제거). |
| `netlify/functions/payment-confirm.js` | `verifyBearerToken` | `public.orders` SELECT/UPDATE, `public.users` SELECT/UPDATE | PortOne v2 결제 조회, Resend | `orders` 조회 `.eq('portone_payment_id', orderId)`. 성공 시 orders.status='paid' + raw.paidAt/paymentId 병합. `public.users.plan` 을 order.plan 으로 갱신, `trial_start` 가 비어있을 때만 결제 시점으로 세팅. service_role 경유(RLS 우회). |
| `netlify/functions/cancel-subscription.js` | `verifyBearerToken` | `public.users` SELECT/UPDATE | Resend (이탈 방지 메일) | 기존 `billingKey` 필드가 스키마에 없어 PortOne 빌링키 삭제 호출 제거. plan 유/무료 처리는 스키마 CHECK 제약(`trial/standard/pro`)에 맞춰 `trial` 로 다운그레이드 + `auto_renew=false`. |
| `netlify/functions/check-expiry.js` | cron (이벤트 컨텍스트 없음) 또는 `x-lumi-secret` | `public.users` SELECT | Resend | `trial_start` 기준 `TRIAL_DAYS(7)` 만료 임박 유저 조회. `.neq('plan','trial').not('trial_start','is',null).gte/lte(trial_start, ...)` 로 필터링. d7/d3/d1 3단계 알림. |

---

## 2. `orders` 테이블 컬럼 매핑

스키마(`supabase/migrations/20260418000000_initial_schema.sql`)의 `public.orders`:

| 컬럼 | 타입 | 본 작업에서 사용 |
|---|---|---|
| `id` | uuid (default gen_random_uuid) | 자동 생성, 사용 안 함 |
| `user_id` | uuid FK users.id | `user.id` (Bearer 토큰 검증 결과) |
| `portone_payment_id` | text UNIQUE | **클라이언트 생성 orderId(`lumi_<ts>_<hex>`)** 를 여기에 저장. PortOne v2의 `paymentId` 와 동일하게 사용. |
| `amount` | integer ≥0 | 플랜별 원화 금액 |
| `plan` | text CHECK (standard/pro) | `planType` 그대로 (스탠다드/프로만 허용) |
| `status` | text CHECK (prepared/paid/cancelled/failed/refunded) | `prepared` → `paid` 흐름 |
| `raw` | jsonb | `{ orderName, durationDays, createdAt, paidAt, paymentId }` 보관 |
| `created_at` / `updated_at` | timestamptz | DB 기본값 + 트리거 |

**스키마에 없는 필드**(기존 Blobs 문서에 있던 것): `email`, `billingCycle`, `lastOrderId` — `raw` jsonb 에만 남기거나 제거.

---

## 3. `users.plan` 업데이트 경로 (service role 확인)

- **payment-confirm.js**: `getAdminClient()` (SUPABASE_SERVICE_ROLE_KEY) → `admin.from('users').update({ plan, auto_renew, [trial_start] }).eq('id', user.id)`. RLS 우회 확인.
- **cancel-subscription.js**: 동일. `.update({ plan: 'trial', auto_renew: false })`.
- **payment-prepare.js**: SELECT 만 (이름 조회), 업데이트 없음.
- **check-expiry.js**: SELECT 만 (만료 임박 조회). 메일 발송 후 중복 방지 플래그 업데이트는 **스키마에 해당 필드가 없어 미구현**(아래 "발견 이슈" 참조).

---

## 4. 발견된 이슈

### 4-1. `cancel-subscription.js` 의 `'free'` 플랜
- 요구사항 원문은 "`public.users.plan`을 `'free'`로 변경". 그러나 스키마 제약 `CHECK (plan in ('trial','standard','pro'))` 때문에 `'free'` INSERT/UPDATE 는 실패함.
- **결정**: `'trial'` 로 다운그레이드 + `auto_renew=false` 처리. 실질적으로 "유료 기능 사용 중지" 의미.
- **추후 조치 제안**: 진짜 "해지 상태" 를 구분하려면 (a) CHECK 제약을 `'free'` 포함하도록 마이그레이션 추가, 또는 (b) 별도 `subscription_status` 컬럼 도입. 이번 작업 범위 밖(금지사항: `supabase/migrations/` 수정 금지).

### 4-2. `check-expiry.js` 중복 발송 방지 불가
- 기존 Blobs 구현은 `user.lastExpiryNotice` 필드에 `YYYY-MM-DD:dX` 태그 저장하여 같은 날 중복 메일 차단했음.
- 현 `public.users` 스키마에는 이 필드가 없음. 추가하려면 마이그레이션 필요(금지사항).
- **현재 동작**: cron 이 하루 1회 실행된다는 전제 하에 필터만(`trial_start` 범위) 의존. cron 이 하루 여러 번 돌면 중복 발송 가능.
- **추후 조치 제안**: `users.last_expiry_notice text` 컬럼을 추가하거나 별도 `expiry_notifications(user_id, notice_key, sent_at)` 테이블 도입.

### 4-3. `cancel-subscription.js` PortOne 빌링키 삭제 제거
- 기존 코드는 `user.billingKey` 가 있으면 `DELETE /billing-keys/{key}` 호출했음. 현 `public.users` 스키마에 `billing_key` 필드 없음.
- 일시불 전환 이후 빌링키가 실제로 운영 중인지 확인이 필요하면 별도 테이블(`billing_keys`) 신설 검토.
- **이번 작업에서는 호출 제거**(스키마에 소스가 없음).

### 4-4. `payment-prepare.js` 플랜 금액 조정
- 기존 Blobs 구현에 남아있던 `basic: 19000` (폐지 플랜) / `standard: 29000` / `pro: 39000` 를 현 도메인 정의(CLAUDE.md)에 맞춰 `standard: 19900` / `pro: 29900` 로 변경. 베이직 제거.

### 4-5. `payment-confirm.js` 에서 `billingCycle`/`planExpireAt` 제거
- 기존 Blobs 유저 문서에는 `planExpireAt`, `billingCycle`, `postCountMonth` 등이 있었음. `public.users` 스키마에는 `trial_start`, `plan`, `auto_renew` 만 존재.
- **결정**: 필수만 업데이트(plan, auto_renew, trial_start). 기간 만료/사이클은 `check-expiry.js` 가 `trial_start + TRIAL_DAYS` 로 추론.
- 월별 플랜 구독 모델을 엄격히 구현하려면 스키마에 `plan_expire_at`, `billing_cycle` 컬럼이 필요함.

### 4-6. Orders CHECK(plan) 제약이 standard/pro 만 허용
- 스키마 `orders.plan CHECK (plan in ('standard','pro'))` — trial 결제 주문은 불가. (정상: trial 은 결제 필요 없음.)
- `payment-prepare.js` 가 `PLANS` 에서 `trial` 키 미제공 → 일관됨.

---

## 5. 검증

```
$ node -c netlify/functions/payment-prepare.js  → OK
$ node -c netlify/functions/payment-confirm.js  → OK
$ node -c netlify/functions/cancel-subscription.js → OK
$ node -c netlify/functions/check-expiry.js     → OK
$ grep -E "@netlify/blobs|getStore|NETLIFY_TOKEN" [4개 파일]  → 0건
```

- CORS/try-catch/statusCode 표준 유지
- PortOne 환경변수(`PORTONE_API_SECRET`) 그대로 사용
- Resend 로직 유지 (이메일 템플릿 브랜드 컬러 `#C8507A` 로 통일)
- 개인정보(이름/이메일) 로그 출력 없음 — 실패 시 에러 메시지만 찍음

---

## 6. 다른 파일에 미친 영향

- 없음. 4개 파일 외 터치 없음.
- 프론트엔드(index.html 등)에서 이 endpoint 들을 호출하는 부분은 이번 범위 밖. Bearer 토큰을 Supabase session access_token 으로 전달하도록 프론트 재작성 시(Day 5) 별도 처리 필요.
- `package.json` 의 `@supabase/supabase-js`, `resend` 의존성은 이미 설치된 것으로 가정 (phase 1 에서 추가됨).

---

**다음 단계(본 작업 범위 밖):**
1. 스키마 확장: `users.plan` CHECK 에 `'free'` 추가, 또는 `subscription_status`/`plan_expire_at`/`last_expiry_notice` 컬럼 신설 — 별도 마이그레이션 파일.
2. 프론트 `fetch('/api/payment-*')` 호출 시 Supabase session token 사용하도록 교체.
3. PortOne 결제 성공 후 `paid_at`/`plan_expire_at` 계산 로직 도입 시 `payment-confirm.js` 에 반영.
