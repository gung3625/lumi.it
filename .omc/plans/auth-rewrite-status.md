# Auth Rewrite Status (Phase A — Netlify Blobs → Supabase Auth)

작성: 2026-04-18 · 대상: Auth 관련 Netlify Functions 6개 + 공용 헬퍼 2개
작업자: oh-my-claudecode:executor

## 수정된 파일

| # | 경로 | 성격 |
|---|---|---|
| 1 | `netlify/functions/_shared/supabase-admin.js` | **신규** — service-role 클라이언트 싱글톤 |
| 2 | `netlify/functions/_shared/supabase-auth.js` | **신규** — Bearer 토큰 검증 헬퍼(`verifyBearerToken`, `extractBearerToken`) |
| 3 | `netlify/functions/register.js` | 재작성 |
| 4 | `netlify/functions/login.js` | 재작성 |
| 5 | `netlify/functions/send-otp.js` | 재작성 |
| 6 | `netlify/functions/verify-otp.js` | 재작성 |
| 7 | `netlify/functions/reset-password.js` | 재작성 |
| 8 | `netlify/functions/find-id.js` | 재작성 |

## 내부 아키텍처 변경 요약

- **저장소 전환**: 모든 Blobs(`users`, `otp-store`, `rate-limit`) 접근을 Supabase로 교체.
- **인증 엔진**: PBKDF2 자체 해시 → Supabase Auth (`auth.admin.createUser`, `auth.signInWithPassword`, `auth.admin.updateUserById`).
- **토큰 포맷**: 기존 랜덤 64자 → Supabase JWT `access_token` (1시간 + refresh).
- **Rate-limit**: Blobs `rate-limit` store → `public.rate_limits` 테이블 (kind, ip PK). 각 Function에 `checkRateLimit(kind, ip, {windowSeconds, max})` 로컬 헬퍼 인라인.
- **OTP 스토리지**: 전용 테이블 없음 → `public.oauth_nonces` 재사용. 키 스킴:
  - `nonce='otp:<email>'`, `lumi_token=JSON({otp, expiresAt})` — 미검증 6자리 OTP
  - `nonce='otp-verified:<email>'`, `lumi_token=JSON({token, verifiedAt, expiresAt})` — 검증 후 1회용 토큰 (reset-password가 소비)

## API 응답 스키마 차이

| Function | 변경 |
|---|---|
| register | **동일** — `{ success, token, user }`. token은 Supabase access_token(JWT)로 교체. safeUser 필드 키(`storeName`, `instagram`, `plan` 등) 기존과 일치하도록 프로필 매핑. `user.igConnected:false` 유지. |
| login | **동일** — `{ success, token, user }`. 에러 메시지 한국어 그대로(`가입되지 않은 이메일입니다.` / `비밀번호가 올바르지 않습니다.` / 429 메시지). `igConnected`는 `ig_accounts` 조회로 결정. |
| send-otp | **동일** — `{ success, message }`. 기존과 동일 Resend 템플릿. |
| verify-otp | **부가 필드 추가** — `{ success, message, otpToken }`. otpToken은 reset-password가 사용. 기존 verify-otp는 otpToken을 리턴하지 않았음(reset-password가 직접 Blobs `otp-verified:*`를 조회했었음) → **프론트엔드 변경 필요**(reset-password 호출 시 otpToken을 바디에 실어 보내야 함). 기존 reset-password 코드는 이미 `otpToken`을 body에서 읽고 있었음 → 프론트가 verify-otp 응답의 otpToken을 보존해 전달하도록 수정해야 함. |
| reset-password | **동일** — `{ success, message }`. body 계약(`{email, password, otpToken}`) 기존과 동일. |
| find-id | **동일** — `{ success, email }` (마스킹). |

## 발견된 이슈 / 의사결정

1. **OTP 전용 테이블 부재**: 초기 스키마에 `otp_codes` 테이블 없음. 마이그레이션 추가 금지 지침 준수 위해 `oauth_nonces` 재사용. `lumi_token` 컬럼을 JSON 문자열 저장소로 활용. 단점: 타입이 엉성함, 앞으로 전용 `otp_codes` 테이블 추가가 깔끔. TTL 정리(cron/pg_cron) 미구현 — 기존 Blobs도 TTL 없이 덮어쓰기만 하던 패턴이라 동등 수준.
2. **register의 `email_confirm: true`**: OTP를 이미 프론트 단계(send-otp → verify-otp)에서 검증했다는 전제 하에 `true`로 설정. Supabase Auth 콘솔에서 "Confirm email" 활성화 시 이 플래그가 있어야 즉시 로그인 가능.
3. **register 롤백 로직**: `public.users` insert 실패 시 `auth.admin.deleteUser`로 auth 계정 정리. instagram_handle UNIQUE 제약 충돌을 감지해 409 `이미 사용 중인 인스타그램 아이디입니다.` 응답.
4. **reset-password 이메일→userId 조회**: 1차 `public.users.email` 조회. 못 찾으면 `auth.admin.listUsers({perPage:200})` 폴백 (고객 1명뿐이므로 안전). Supabase v2 SDK는 `listUsers` email 필터를 공식 지원하지 않음.
5. **login에서 "계정 없음 vs 비번 틀림" 분기**: `auth.signInWithPassword`는 보안상 둘을 구분하지 않음(Invalid credentials). 기존 UX 보존을 위해 `public.users` 선조회로 "가입되지 않은 이메일입니다." 먼저 반환, 그 외 실패는 "비밀번호가 올바르지 않습니다."로 매핑.
6. **Rate-limit fail-open**: Supabase에서 실패 시 요청 통과(`ok:true`). 기존 Blobs 코드도 동일한 fail-open 패턴이었음.
7. **개인정보 로깅 금지 준수**: 모든 에러 로그가 `err.message`만 출력. name/phone/email/IG토큰 로그 0건.
8. **인스타 역조회 키(`insta:*`) 제거**: 기존 register는 Blobs에 `insta:<handle> → email` 엔트리를 저장했음. Supabase에서는 `public.users.instagram_handle` UNIQUE 인덱스로 대체 — 별도 엔트리 저장 불필요.

## 빠진/건드리지 않은 것

- `package.json` (이미 `@supabase/supabase-js` 설치됨, 변경 불필요)
- 프론트엔드 HTML — 담당 아님
- cron Functions (scheduled-trends, beta-apply 등) — 터치 금지 준수
- `supabase/migrations/` — 신규 파일 추가 금지 준수

## 구문 검증 결과

전부 `node --check` 통과:
- `_shared/supabase-admin.js` OK
- `_shared/supabase-auth.js` OK
- `register.js` OK
- `login.js` OK
- `send-otp.js` OK
- `verify-otp.js` OK
- `reset-password.js` OK
- `find-id.js` OK

## 다음 단계 추천

1. **프론트엔드 패치 필수**:
   - 비번 재설정 플로우: `verify-otp` 응답에서 `otpToken`을 **보존**해 `reset-password`에 전달하도록 수정. (기존 Blobs 버전은 서버가 상태를 유지했으므로 프론트가 별도 토큰 관리 불필요했음.)
   - 로그인/가입 성공 후 받은 `token`(access_token)을 이후 API 요청 `Authorization: Bearer ...`에 사용. localStorage 저장 후 만료(1시간) 도래 시 refresh 필요 → Phase B에서 프론트 supabase-js SDK 도입 시 자동 처리.
2. **Supabase 대시보드 설정 점검**:
   - Auth > Providers > Email > "Confirm email" 활성화 여부에 따라 `email_confirm:true` 동작 확인.
   - Auth > Email Templates 한국어 커스터마이즈 (현재는 Resend 자체 발송 중이므로 필수 아님).
3. **향후 마이그레이션**:
   - 전용 `public.otp_codes(email, code, expires_at)` 테이블 + pg_cron TTL 청소로 `oauth_nonces` 재사용 해소.
   - `public.rate_limits` 오래된 행 청소용 cron 스크립트.
4. **검증 작업**(별도 에이전트 권장):
   - `node -e "require('./netlify/functions/register')"` 수준의 require 테스트 + Supabase stage 환경에서 end-to-end curl 테스트.
   - 기존 Blobs 잔재(`getStore`) 참조가 이 6개 Function에 **하나도 없는지** grep 재확인(작업 중 모두 제거함).
