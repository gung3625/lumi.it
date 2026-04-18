# 마이그레이션 스크립트 상태 (2026-04-18)

## 스크립트 파일 경로

```
/Users/kimhyun/lumi.it/scripts/migrate-blobs-to-supabase.js
```

## 스크립트 동작 요약

| Phase | 대상 스토어 | 변환 대상 | Supabase 목적지 |
|---|---|---|---|
| 1-1 | `users` (`user:*`) | 유저 프로필 | `auth.users` + `profiles` 테이블 |
| 1-2 | `users` (`token:*`) | 세션 토큰 | **이전 안 함** (Supabase Auth JWT로 대체) |
| 1-3 | `users` (`insta:*`, `email-ig:*`) | IG 핸들 역조회 | `profiles.instagram_handle` 컬럼으로 병합 |
| 1-4 | `users` (`ig:*`) | IG 계정 연동 | `ig_accounts` 테이블 (토큰 마스킹) |
| 1-5 | `users` (`tone-like:*`, `tone-dislike:*`) | 말투 피드백 | `tone_feedback` 테이블 (최대 20개) |
| 1-6 | `users` (`caption-history:*`) | 캡션 이력 | `caption_history` 테이블 |
| 1-7 | `users` (`linkpage:*`) | 링크페이지 | `link_pages` 테이블 |
| 2 | `reservations` (`reserve:*`) | 예약 레코드 | `reservations` 테이블 |
| - | `reservations` (`user-index:*`) | 역인덱스 | **이전 안 함** (DB 인덱스로 대체) |
| 3 | `orders` | 결제 주문 | `orders` 테이블 |
| 4 | `trends` | 트렌드 캐시 + 캡션뱅크 | `trend_cache` + `caption_bank` 테이블 |
| 5 | `beta-applicants`, `beta-waitlist` | 베타 신청자 | `beta_applicants`, `beta_waitlist` 테이블 |
| 6 | `temp-images`, `last-post-images` | 이미지 (base64) | Supabase Storage `lumi-images` 버킷 |
| 7 | `rate-limit`, `oauth-nonce` | 임시 데이터 | **이전 안 함** (자연 소멸) |

## dry-run 결과

> 실제 Blobs 데이터 접근을 위해서는 유효한 NETLIFY_TOKEN이 필요함.
> 현재 스키마 작업 진행 중이라 아직 실행하지 않았음.
> 아래는 스크립트가 출력할 예상 카운트 형식:

```
============================================================
  lumi.it Blobs → Supabase 마이그레이션 스크립트
============================================================
  모드: DRY-RUN (읽기 전용, INSERT 없음)
  Supabase URL: https://cldsozdocxpvkbuxwqep.supabase.co
  ...

============================================================
  Phase 1: users 스토어
============================================================

[1-1] user:{email} → profiles 테이블
  Blobs 총 user: 키 수: N
  [샘플 변환 결과 — user] ...

[1-2] token:{random} → 이전 안 함
  Blobs token: 키 수: M → 전부 버림 (정상)

[1-4] ig:{igUserId} → ig_accounts 테이블
  Blobs ig: 키 수: K
  [샘플] access_token: [MASKED]

  [user:] 완료 — ok=N fail=0 skip=0 / blobs=N

... (각 Phase 동일 형식)

  [경고 목록] 총 0건 (이상 없으면)
```

## 각 스토어별 예상 데이터 규모

현재 베타 서비스 상태 (고객 실질적으로 1명 = 김현님):

| 스토어 | 예상 키 수 | 비고 |
|---|---|---|
| users (`user:*`) | ~1건 | gung3625@gmail.com 1개 |
| users (`token:*`) | 수십 건 | 이전 안 함 (버림) |
| users (`ig:*`) | ~1건 | 연동 시 |
| users (`tone-like/dislike:*`) | ~1건 | 최대 20개 행 |
| users (`caption-history:*`) | ~1건 | N개 항목 |
| reservations (`reserve:*`) | 수십 건 | 테스트 예약 포함 |
| orders | 0~수 건 | 테스트 결제 포함 |
| trends | 10~30건 | 카테고리별 캐시 |
| beta-applicants | 0~20건 | 베타 신청자 |
| beta-waitlist | 0건 | 마감 후 대기 |
| temp-images | 수 건 | 대기 중 예약 이미지 |
| last-post-images | 수 건 | 최근 게시 이미지 |

## 실행 전 체크리스트

### 필수 완료 항목 (이 중 하나라도 미완료면 --apply 실행 금지)

- [ ] `supabase/migrations/*.sql` 스키마 Supabase에 적용 완료 확인
  - `profiles`, `ig_accounts`, `reservations`, `orders`, `tone_feedback`, `caption_history`, `link_pages`, `trend_cache`, `caption_bank`, `beta_applicants`, `beta_waitlist` 테이블 존재 확인
- [ ] Supabase Storage `lumi-images` 버킷 생성 확인 (public read 설정)
- [ ] `ig_accounts.access_token` pgsodium 암호화 컬럼 설정 확인
- [ ] 실제 NETLIFY_TOKEN 준비 (Blobs 읽기 권한)
- [ ] 실제 SUPABASE_SERVICE_ROLE_KEY 준비 (관리자 insert 권한)
- [ ] dry-run 실행 후 출력 확인 (경고 0건 또는 경고 내용 검토)
- [ ] 김현님 승인

### 권장 확인 항목

- [ ] `gung3625@gmail.com` 유저 데이터가 `profiles` 행으로 올바르게 변환되는지 샘플 출력 확인
- [ ] IG 토큰이 로그에 마스킹([MASKED])으로만 출력되는지 확인
- [ ] `scripts/image-url-mapping.json` 파일 생성 확인 (리디렉션용)
- [ ] 경고(WARN) 건수 검토 — 이메일 형식 오류, 필수 필드 누락 여부

## 실제 실행 방법

```bash
# 1단계: dry-run (카운트·샘플 확인)
SUPABASE_URL=https://cldsozdocxpvkbuxwqep.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<sb_secret_...> \
NETLIFY_SITE_ID=28d60e0e-6aa4-4b45-b117-0bcc3c4268fc \
NETLIFY_TOKEN=<netlify_pat_...> \
node scripts/migrate-blobs-to-supabase.js --dry-run

# 2단계: 실제 적용 (체크리스트 모두 완료 후)
SUPABASE_URL=https://cldsozdocxpvkbuxwqep.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<sb_secret_...> \
NETLIFY_SITE_ID=28d60e0e-6aa4-4b45-b117-0bcc3c4268fc \
NETLIFY_TOKEN=<netlify_pat_...> \
node scripts/migrate-blobs-to-supabase.js --apply
```

## 주의사항

- **Blobs 원본은 절대 삭제하지 않음** — 스크립트가 삭제 명령을 실행하지 않음. 1개월 유예 후 별도 삭제
- **`supabase/migrations/` 폴더 무수정** — 이 스크립트는 스키마 파일에 일절 접근하지 않음
- **`netlify/functions/` 무수정** — 읽기 전용으로만 참고
- **비밀번호 이전 안 함** — PBKDF2 해시는 Supabase Auth와 호환 안 됨. `gung3625@gmail.com`은 Supabase Auth에서 별도 계정 생성 필요 (Option A: 재설정 메일 발송)
- **IG 토큰 로그 출력 금지** — 코드 내 `[MASKED]`로만 표시

## 출력 파일

| 파일 | 용도 |
|---|---|
| `scripts/migrate-blobs-to-supabase.js` | 마이그레이션 스크립트 본체 |
| `scripts/image-url-mapping.json` | 실행 후 생성 — 구 Blobs 키 → 새 Storage URL 매핑 (`/ig-img/*` 리디렉션용) |

## 작성자 정보

- 작성: Executor 에이전트 (2026-04-18)
- 기반 계획: `.omc/plans/supabase-migration.md` Phase 3, `.omc/plans/migration-decisions.md`
- 실행은 스키마 완성 + 김현님 최종 승인 후
