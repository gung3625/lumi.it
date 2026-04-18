# Supabase 마이그레이션 최종 결정사항 (2026-04-18)

김현님이 11개 결정사항 확정. 이 문서가 모든 에이전트 작업의 **정본(authority)**.

## 결정사항

| # | 항목 | 결정 |
|---|---|---|
| 1 | Supabase 플랜 | **Free** |
| 2 | Region | **ap-northeast-2 (서울)** |
| 3 | JWT 세션 수명 | **1시간 + refresh token** (Supabase 기본) |
| 4 | 기존 계정 처리 | **기존 Blobs 유저 아카이브, Supabase Auth에 김현님 계정 1개 스크립트로 생성** (실제 베타 테스터 없음 — 김현님 계정만 존재) |
| 5 | 회원가입 이메일 인증 | **기존 OTP 6자리 플로우 유지** (Supabase `signInWithOtp` 사용, Resend 메일러 유지 또는 Supabase 기본) |
| 6 | IG 토큰 암호화 | **pgsodium 컬럼 암호화 적용** (`ig_accounts.access_token`, `pageAccessToken`) |
| 7 | 이미지 Storage 접근 | **Public 버킷 + 예측 불가능한 파일명(nonce)** |
| 8 | Rate-limit 구현 | **Supabase Postgres 테이블** (`public.rate_limits`) |
| 9 | Blobs 원본 삭제 타이밍 | **1개월 유예 후 삭제** |
| 10 | `/ig-img/*` 레거시 URL | **30일 유지 후 제거** |
| 11 | 프론트 호출 방식 | **프론트엔드가 `supabase-js` SDK로 직접 호출** (Functions 대폭 축소) — 고객 없는 시점에 큰 변화 다 소화 |
| 12 | 실행 시간 | **지금 바로** |

## 핵심 영향

- **#11 결정 (프론트 직접 호출)** 때문에 원본 계획(Functions 유지안) 대비 범위 확장:
  - 많은 Functions 삭제 가능 (단순 CRUD, 인증 래퍼 등)
  - `index.html`의 `fetch('/api/...')` 25개 지점 → `supabase.from(...)` 호출로 재작성
  - RLS 정책 매우 신중히 설계 필요 (anon key가 클라이언트 노출됨)
  - 남길 Functions: 외부 API 호출(IG Graph, OpenAI, Resend, 결제사) + 서버 사이드 비밀 필요한 것만

- **#4 결정**: 비번 마이그레이션 스크립트 불필요, 단순히 김현님 계정 1개 생성

## 환경변수 (Netlify env 등록 완료)

- `SUPABASE_URL` = `https://cldsozdocxpvkbuxwqep.supabase.co`
- `SUPABASE_ANON_KEY` = `sb_publishable_...`
- `SUPABASE_SERVICE_ROLE_KEY` = `sb_secret_...`
- `SUPABASE_DB_URL` = `postgresql://postgres:%21qhfk717390@db.cldsozdocxpvkbuxwqep.supabase.co:5432/postgres`

## 참고 문서

- 전체 계획: `.omc/plans/supabase-migration.md`
- 오픈 질문(해결됨): `.omc/plans/open-questions.md`
