# lumi.it Supabase Phase 1 — 스키마 적용 상태

**완료일:** 2026-04-18
**프로젝트:** `cldsozdocxpvkbuxwqep.supabase.co` (ap-northeast-2, Free 플랜)
**적용 방식:** `scripts/apply-migrations.js` + `scripts/apply-one.js` (pg 클라이언트, pooler 경유)
**연결:** `aws-1-ap-northeast-2.pooler.supabase.com:5432` (직접 `db.*.supabase.co` 는 DNS 없음 → pooler 필수)

---

## 1. 생성된 마이그레이션 파일

| 파일 | 내용 | 상태 |
|---|---|---|
| `supabase/migrations/20260418000000_initial_schema.sql` | 13개 테이블 + 인덱스 + `pgcrypto` + `updated_at` 트리거 | 적용 완료 |
| `supabase/migrations/20260418000001_rls_policies.sql` | 13개 테이블 RLS on + 21개 정책 | 적용 완료 |
| `supabase/migrations/20260418000002_pgsodium_encryption.sql` | **Supabase Vault** 기반 토큰 암호화 (helper 2개 + 복호화 뷰 + cascade cleanup 트리거) | 적용 완료 |
| `supabase/migrations/20260418000003_storage_buckets.sql` | `lumi-images` 버킷(public, 10MB, jpeg/png/webp) + objects 정책 4개 | 적용 완료 |

보조 스크립트 (`scripts/`):
- `apply-migrations.js` — 전체 순차 적용
- `apply-one.js` — 개별 파일 적용(디버깅용)
- `probe-pooler.js` — pooler 리전 탐색
- `probe-pgsodium.js`, `probe-vault.js` — 확장 탐색
- `fix-helpers.js` — 일회성 helper 함수 재적용
- `verify-schema.js` — 테이블/RLS/정책/Storage 검증 + service_role CRUD 테스트
- `verify-vault.js` — Vault 암호화 round-trip 테스트

---

## 2. 생성된 테이블 (13개)

모두 `public` 스키마.

| 테이블 | 주요 PK | 비고 |
|---|---|---|
| `users` | `id uuid` → `auth.users(id)` | 1:1, `plan CHECK (trial/standard/pro)` |
| `ig_accounts` | `ig_user_id text` | 토큰 컬럼을 `access_token_secret_id/uuid` + `page_access_token_secret_id/uuid` 로 대체 (Vault 참조) |
| `reservations` | `id bigserial`, `reserve_key text UNIQUE` | 예약/게시 플로우 중심 |
| `orders` | `id uuid` | PortOne 결제 |
| `tone_feedback` | `id bigserial` | 말투 학습 (like/dislike) |
| `caption_history` | `id bigserial` | 캡션 이력 |
| `linkpages` | `user_id uuid` (1:1) | `/p/:handle` 공개 |
| `trends` | `category text` | 트렌드 캐시 |
| `caption_bank` | `id bigserial` | 카테고리별 캡션 뱅크 |
| `beta_applicants` | `id uuid` | 베타 신청자 |
| `beta_waitlist` | `id uuid` | 대기 명단 |
| `rate_limits` | `(kind, ip)` 복합 | IP×action |
| `oauth_nonces` | `nonce text` | IG OAuth CSRF (10분 TTL) |

기본 정비:
- `pgcrypto` 확장 활성화 (`gen_random_uuid()`)
- `tg_set_updated_at` 트리거 함수 + users/ig_accounts/orders/linkpages 4개 테이블에 `updated_at` 자동 갱신 적용

---

## 3. RLS 정책 요약

**13/13 테이블 RLS ON** (검증 통과).

| 테이블 | 정책 | 요지 |
|---|---|---|
| `users` | select(본인), update(본인) | INSERT/DELETE 는 service_role 전용 |
| `ig_accounts` | select(본인) | 토큰 접근은 `ig_accounts_decrypted` 뷰(service_role 전용) |
| `reservations` | select/insert/update/delete (모두 본인) | |
| `orders` | select(본인) | 결제 검증은 service_role |
| `tone_feedback` | all(본인) | |
| `caption_history` | all(본인) | |
| `linkpages` | select(공개) + insert/update/delete(본인) | `/p/:handle` 공개 읽기 |
| `trends` | select(authenticated) | 쓰기는 service_role 스케줄러 |
| `caption_bank` | select(authenticated) | 쓰기는 service_role |
| `beta_applicants` | insert(anon/authenticated) | 조회/삭제는 service_role |
| `beta_waitlist` | insert(anon/authenticated) | 조회/삭제는 service_role |
| `rate_limits` | **정책 없음** | service_role 전용 (anon/authenticated 모두 거부) |
| `oauth_nonces` | **정책 없음** | service_role 전용 |

정책 개수 검증:
- beta_applicants=1, beta_waitlist=1, caption_bank=1, caption_history=1, ig_accounts=1, linkpages=4, orders=1, reservations=4, tone_feedback=1, trends=1, users=2 (합 18)
- rate_limits, oauth_nonces 는 의도적으로 정책 없음 → 기본 거부

---

## 4. 토큰 암호화 (Vault 기반)

**중요 변경사항**: 당초 계획의 `pgsodium` 은 Supabase 2025년 이후 **deprecated** 되었음을 실측으로 확인 (`pg_extension` 에 `pgsodium` 없음, `supabase_vault` 0.3.1 만 설치). 설계를 Supabase 공식 대체안인 **Vault** 로 변경.

### 암호화된 컬럼 (간접 저장)
- `ig_accounts.access_token_secret_id uuid` → `vault.secrets(id)` FK (논리)
- `ig_accounts.page_access_token_secret_id uuid` → `vault.secrets(id)` FK (논리)
- **평문은 `ig_accounts` 테이블에 존재하지 않음** (verify-vault.js 로 검증됨)

### 헬퍼 함수 (service_role 전용, `security definer`)
```
public.set_ig_access_token(p_ig_user_id text, p_existing_secret uuid, p_access_token text) returns uuid
public.set_ig_page_access_token(p_ig_user_id text, p_existing_secret uuid, p_page_token text) returns uuid
```
- `p_existing_secret=NULL` 이면 `vault.create_secret` → 신규 uuid 반환
- 기존 uuid 를 넘기면 `vault.update_secret` → 동일 uuid 재사용

### 복호화 뷰
```
public.ig_accounts_decrypted
```
- `security_invoker = true`
- `GRANT SELECT TO service_role`, `REVOKE FROM anon, authenticated`
- 필드: `access_token`, `page_access_token` 을 `vault.decrypted_secrets` 조인으로 평문 제공

### 삭제 cascade
- `ig_accounts` 레코드 삭제 시 AFTER DELETE 트리거(`tg_ig_accounts_delete_secrets`)로 `vault.secrets` 에서도 자동 삭제 (verify-vault.js 로 0건 남음 확인)

### 앱 연동 가이드 (Netlify Functions 재작성 시 참고)
```js
// 1) IG OAuth 콜백에서 토큰 저장
const { data: r } = await admin.rpc('set_ig_access_token', {
  p_ig_user_id: igUserId,
  p_existing_secret: existingRow?.access_token_secret_id ?? null,
  p_access_token: accessToken,
});
const secretId = r;       // uuid
await admin.from('ig_accounts').upsert({
  ig_user_id: igUserId, user_id, ..., access_token_secret_id: secretId,
});

// 2) 게시 Function 에서 토큰 조회 (service_role)
const { data } = await admin.from('ig_accounts_decrypted').select('access_token, page_access_token').eq('ig_user_id', igUserId).single();
```

---

## 5. Storage 버킷

| 버킷 | Public | 크기 제한 | MIME |
|---|---|---|---|
| `lumi-images` | true | 10 MiB | image/jpeg, image/png, image/webp |

### storage.objects 정책 (4개, `bucket_id='lumi-images'` 한정)
- SELECT: 공개 (URL에 nonce 포함 전제)
- INSERT: 인증 사용자 + 경로 첫 segment 가 `auth.uid()` 여야 함 (`{user_id}/...`)
- UPDATE: owner 만
- DELETE: owner 만

---

## 6. 검증 결과

### 6-1. 자동 검증 (scripts/verify-schema.js)
- 13/13 테이블 존재
- 13/13 RLS ON
- 21개 정책 배치 (rate_limits/oauth_nonces 는 정책 없음으로 정상)
- `ig_accounts` 컬럼에 plaintext 토큰 없음, `*_secret_id` 로 치환됨
- `public.ig_accounts_decrypted` 뷰 존재
- `set_ig_access_token`, `set_ig_page_access_token` 함수 존재
- `lumi-images` 버킷 + storage 정책 4개 확인
- service_role 로 `auth.users → public.users` INSERT/SELECT/DELETE 성공
- anon 으로 `users.select` 빈 결과(세션 없음), `rate_limits.insert` RLS 거부, `beta_applicants.insert` 허용 — 모두 정상

### 6-2. Vault round-trip (scripts/verify-vault.js)
- `set_ig_access_token(ig, null, plaintext)` → 신규 uuid 반환, vault 에 암호화 저장
- `ig_accounts` row 에 평문 포함 여부 0건 확인
- `ig_accounts_decrypted` 로 평문 조회 일치
- `vault.decrypted_secrets` 직접 조회 일치
- 동일 uuid 로 두 번째 호출 → `update_secret` 경로로 평문 교체, uuid 재사용 확인
- `ig_accounts` 삭제 후 `vault.secrets` 0건 남음 (트리거 cascade 확인)

---

## 7. 다음 Phase 로 넘기는 주의사항

### 연결 정보 (Netlify env 그대로 사용)
- `SUPABASE_URL` = `https://cldsozdocxpvkbuxwqep.supabase.co`
- `SUPABASE_ANON_KEY` = `sb_publishable_WjWg5o05Y7lhib674Cr_fw_0mpY-ccG`
- `SUPABASE_SERVICE_ROLE_KEY` = `sb_secret_...` (이미 등록됨)
- `SUPABASE_DB_URL` 은 **Netlify env 값(`db.*.supabase.co` 직접 호스트)이 DNS 미존재**.
  → 서버(마이그레이션/스크립트)에서 DB 직접 접속이 필요하면 pooler 문자열을 써야 함:
  `postgres://postgres.cldsozdocxpvkbuxwqep:%21qhfk717390@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres`
  다만 **Functions 코드에서는 DB 직결 대신 `@supabase/supabase-js` 사용이 원칙**이므로 이 이슈는 운영 영향 없음.

### Supabase 외부(설계 결정에서 벗어난 점)
- **pgsodium 미설치** — 계획서에 남아있던 `pgsodium` 표현은 `supabase_vault` 로 교체됨. 다음 Phase 에서 Functions/프론트 재작성 시 pgsodium 언급 코드 있으면 Vault 호출 패턴으로 치환 필요.
- RLS 에서 **`oauth_nonces`, `rate_limits`** 는 정책 없음 = 전부 거부가 의도. Functions 가 service_role 로만 접근해야 함.

### Auth 관련 미처리 항목 (Phase 2+ 에서 설정)
- Auth 이메일 템플릿 한국어화 (비밀번호 재설정, OTP) — Supabase Dashboard 에서 수동 설정 필요
- Site URL/Redirect URL 등록 — `https://lumi.it.kr` + dev preview 도메인
- 확인 이메일 비활성/활성 정책 — 기존 OTP 플로우(솔라피) 유지 결정에 맞춰 Dashboard 에서 선택

### 김현님 계정 생성 (결정사항 #4)
- `scripts/` 에 `create-kimhyun-user.js` 같은 1회성 스크립트를 만들어
  `admin.auth.admin.createUser({ email: '...', email_confirm: true })` → `public.users insert` 하는 흐름이 필요.
- 다음 에이전트 작업 시 이 스크립트도 함께 만들 것. (이 스크립트는 본 Phase 에서 작성하지 않음 — 본 Phase 범위는 "스키마 + RLS + 암호화 + Storage".)

### Free 플랜 제약 / 백업
- PITR 없음 → 실수 대비 **역방향 SQL 준비** 권장:
  - 롤백: `drop policy ... ; drop table ... cascade;` — 현 파일들의 역순
  - 재적용: `node scripts/apply-migrations.js`
- 스토리지 1GB / DB 500MB 한도 — 이미지 업로드 증가 시 모니터링 필요

### 확장/의존성 추가
- `package.json` 에 `@supabase/supabase-js@^2`, `pg@^8` 추가됨
  - `@supabase/supabase-js` 는 Netlify Functions 및 향후 프론트에서 사용
  - `pg` 는 마이그레이션 스크립트 전용 (프로덕션 코드에서 사용 금지)

---

## 8. 산출물 체크리스트

| 항목 | 상태 |
|---|---|
| 스키마 SQL (`20260418000000_initial_schema.sql`) | 생성 + 적용 |
| RLS SQL (`20260418000001_rls_policies.sql`) | 생성 + 적용 |
| Vault 암호화 SQL (`20260418000002_pgsodium_encryption.sql`) | 생성 + 적용 (pgsodium → Vault 로 설계 변경) |
| Storage SQL (`20260418000003_storage_buckets.sql`) | 생성 + 적용 |
| 테이블 13개 모두 생성 | 확인 |
| RLS 전 테이블 활성화 | 확인 |
| 토큰 암호화 round-trip | 확인 |
| `lumi-images` 버킷 + 정책 | 확인 |
| service_role CRUD 통과 | 확인 |
| anon RLS 차단/허용 | 확인 |
| 검증 스크립트 (`verify-schema.js`, `verify-vault.js`) | 생성 + 통과 |

**Phase 1 완료. 다음 Phase (데이터 마이그레이션 / Functions 재작성) 로 진행 가능.**
