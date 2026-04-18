# RLS 보강 + serve-image 전환 완료 (2026-04-18)

## 1. RLS 정책 적용 결과

마이그레이션: `supabase/migrations/20260418000004_rls_hardening.sql` — **OK**

verify-schema.js 재실행 결과 요약:
- 모든 13개 테이블 RLS 활성화 확인
- `ig_accounts` 정책 수: 1 → **2** (DELETE 정책 추가됨)
- `users_plan_lock_trigger` 트리거 생성 완료
- service_role CRUD 테스트: OK
- anon RLS 차단 테스트: OK

## 2. serve-image.js 변경 요약

**변경 전**: Netlify Blobs (`temp-images`, `last-post-images`) 바이트 직접 서빙  
**변경 후**: `scripts/image-url-mapping.json` 기반 302 리디렉션 (Supabase Storage URL)

- Blobs 의존성(`@netlify/blobs`, `getStore`) 완전 제거 — 0건 확인
- `image-url-mapping.json` 없을 시 404 반환 (데이터 마이그레이션 전까지 safe)
- 구문 검증: `node -c` → SYNTAX OK

## 3. 다음 단계

1. `scripts/migrate-blobs-to-supabase.js` 실행 → `image-url-mapping.json` 생성
2. 프론트엔드 이미지 URL을 Supabase Storage URL로 교체 후 serve-image.js 호출 제거
3. 설정 페이지 disconnect-ig 버튼: 이제 authenticated 유저가 본인 `ig_accounts` 행 DELETE 가능
