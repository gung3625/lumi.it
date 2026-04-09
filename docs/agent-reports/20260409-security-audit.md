# 보안 점검 보고서 — 2026-04-09

## 총 60건 (Critical 8 / High 15 / Medium 22 / Low 15)

---

## Critical (8건)

| # | 파일 | 문제 | 상태 |
|---|------|------|------|
| CRIT-1 | login.js, register.js | 토큰 만료 없음 — 영구 유효 | 수정 예정 |
| CRIT-2 | check-plan.js, count-post.js | 토큰 검증 안 함 + email body에서 받음 (IDOR) | 수정 예정 |
| CRIT-3 | payment-confirm.js | 인증 없음 + 이중 결제 레이스 컨디션 | 수정 예정 |
| CRIT-4 | serve-image.js | 인증 없는 이미지 프록시, 키 추측 가능 | 수정 예정 |
| CRIT-5 | dashboard.html | 토큰+PII localStorage 저장 — XSS 탈취 가능 | 장기 과제 (httpOnly 쿠키 전환) |
| CRIT-6 | admin-beta.html, beta-admin.js | 관리자 토큰 URL 파라미터 + 무제한 시도 | 수정 예정 |
| CRIT-7 | 다수 파일 | Bearer 토큰 .replace() 불안전 파싱 | 수정 예정 |
| CRIT-8 | check-plan.js, count-post.js, meta-webhook.js | ADMIN_EMAIL 하드코딩 | 수정 예정 |

## High (15건)

| # | 파일 | 문제 | 상태 |
|---|------|------|------|
| HIGH-1 | reserve.js, save-reservation.js | Bearer 토큰 Blobs 미검증 | 수정 예정 |
| HIGH-2 | regenerate-caption.js | 토큰 형식만 체크, email body | 수정 예정 |
| HIGH-3 | select-caption.js, save-caption.js | LUMI_SECRET JSON body 노출 | 수정 예정 |
| HIGH-4 | meta-webhook.js | 서명 검증 함수 호출 안 함 + PII 전체 로깅 | 수정 예정 |
| HIGH-5 | beta-apply.js | 내부 에러 메시지 클라이언트 노출 | 수정 예정 |
| HIGH-6 | find-id.js | 인증 없이 전체 사용자 스캔 (DoS+열거) | 수정 예정 |
| HIGH-7 | ig-oauth.js | OAuth state CSRF 미검증 | 수정 예정 |
| HIGH-8 | send-daily-schedule.js, check-expiry.js | httpMethod 없으면 인증 우회 | 수정 예정 |
| HIGH-9 | unsubscribe-retention.js | 영구 유효 구독해지 링크 | 수정 예정 |
| HIGH-10 | dashboard.html:4365 | innerHTML 캘린더 데이터 미이스케이프 (XSS) | 수정 예정 |
| HIGH-11 | dashboard.html:4106 | innerHTML 사용자 프로필 미이스케이프 (XSS) | 수정 예정 |
| HIGH-12 | dashboard.html:2193 | innerHTML auto-reply 미이스케이프 (XSS) | 수정 예정 |
| HIGH-13 | 전체 42개 함수 | CORS Access-Control-Allow-Origin: * | 수정 예정 |
| HIGH-14 | login.js, send-otp.js, verify-otp.js | 로그인/OTP 무제한 시도 | 수정 예정 |
| HIGH-15 | dashboard.html:9 | lucide@latest 플로팅 버전 CDN (SRI 없음) | 수정 예정 |

## Medium (22건)

- register.js: 이메일 HTML에 name 미이스케이프 (XSS)
- beta-apply.js: Blob 키 시간 기반 열거 가능 + 20명 레이스 컨디션
- save-auto-reply.js: 전체 body 그대로 저장 (stored injection)
- get-reservation.js: LUMI_SECRET URL 쿼리 파라미터
- demo-caption.js: reCAPTCHA 환경변수 없으면 우회
- demo-caption.js, generate-calendar.js: IP rate limit X-Forwarded-For 신뢰
- scheduled-trends.js: 인증 없음
- get-link-page.js: 전체 store 스캔 (DoS)
- reserve.js: IG 액세스 토큰 평문 저장
- payment-prepare.js: Math.random() 주문 ID (비CSPRNG)
- meta-webhook.js: 전체 webhook body 로깅 (PII)
- send-kakao.js: 사용자 제어 SMS 텍스트 폴백
- netlify.toml: CSP 헤더 없음
- netlify.toml: HSTS 헤더 없음
- 전체 CDN: SRI 없음 + @latest 플로팅
- ig-oauth.js: 토큰을 OAuth state로 전달
- dashboard.html: c.type 미이스케이프, reservationKey onclick 주입
- robots.txt: 민감 경로 노출
- admin-beta.html: 서버 레벨 인증 없음
- check-plan.js: 토큰 미검증 email 신뢰
- dashboard.html: localStorage에 phone+birthdate
- update-trends.js: LUMI_SECRET 없으면 인증 스킵

## Low (15건)

- 전체: CORS 와일드카드
- 전체: Netlify Site ID 하드코딩
- meta-webhook.js: raw webhook 로깅
- beta-admin.js: LUMI_SECRET URL 쿼리
- find-id.js: 이메일 마스킹 약함
- generate-calendar.js: 인증 없는 GPT 호출
- update-trends.js: 환경변수 없으면 인증 스킵
- scheduled-trends.js: 외부 API 타임아웃 없음
- .gitignore: git 히스토리에 시크릿 있을 수 있음
- index.backup.html, prototype.html: 공개 접근 가능
- dashboard.html: noopener noreferrer 불일치
- reset-password.js: OTP 토큰 users 스토어 네임스페이스 충돌

---

## 수정 우선순위

### 즉시 (이번 세션)
1. CRIT-1: 토큰 만료 추가 (30일)
2. CRIT-2: check-plan.js, count-post.js 토큰 Blobs 검증
3. CRIT-3: payment-confirm.js 인증 추가
4. CRIT-4: serve-image.js 인증 추가
5. CRIT-6: beta-admin.js 브루트포스 방지
6. CRIT-7: Bearer 파싱 안전하게 (전체)
7. CRIT-8: ADMIN_EMAIL 환경변수화

### 다음 세션
8. HIGH-1~9: 토큰 검증 강화, webhook 서명, CORS 제한 등
9. HIGH-10~15: XSS 수정, rate limit, CDN SRI

### 장기 과제
10. CRIT-5: localStorage → httpOnly 쿠키 전환 (아키텍처 변경)
11. MED 전체: CSP, HSTS, 기타
