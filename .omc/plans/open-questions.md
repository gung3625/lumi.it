# Open Questions — 계획별 미결정 사항

## supabase-migration - 2026-04-18

- [ ] **비밀번호 재설정 정책** — 베타 유저 전원에게 "재설정 링크" 메일 발송 OK? — PBKDF2 해시를 Supabase Auth가 지원하지 않아, 마이그레이션 시점에 전원 재설정이 가장 깔끔함. 거부 시 Option C(이중 인증 Proxy) 복잡도 폭발.
- [ ] **Supabase 플랜 선택** — Free ($0) vs Pro ($25/mo)? — Free는 500MB DB + 1GB Storage + PITR 없음. 베타·고객 0명 기준 Free 충분하지만, 정식 출시 시점에는 Pro(PITR + SLA) 전환 권장.
- [ ] **Region 선택** — `ap-northeast-2`(서울) vs `ap-northeast-1`(도쿄)? — 기본값 서울 권장. 단, Netlify Edge Functions와의 왕복 지연은 배포 전 ping 측정으로 최종 결정.
- [ ] **JWT 세션 수명** — Supabase 기본 1시간 유지 vs 4시간 연장? — 현 자체 토큰은 30일 수명. 1시간 + refresh token 조합으로 전환 시 프론트 경험은 동일하나, 모바일에서 잦은 refresh가 부담될 수 있음.
- [ ] **`/ig-img/*` 레거시 URL 유지 기간** — 최소 30일 유지 권장 but 정확한 TTL 몰라 실측 필요. Instagram CDN이 이미지 캐시를 얼마나 오래 가지고 있는지 확인.
- [ ] **Blobs 원본 삭제 타이밍** — 현 권고 "2주 무사고 + 7일 관찰" vs 보수적 "1개월 유예"? — 고객 0명이므로 공격적 2주 OK, 하지만 베타 테스터 피드백에 따라 늘릴 여지.
- [ ] **프론트 직접 호출 전환 로드맵** — Phase 5에서는 Functions 유지(최소 변경). 정식 출시 후 `supabase-js`로 프론트 직접 호출 리팩터링할지? — 하면 Functions 개수 ↓ 콜드스타트 ↓, 대신 RLS 정책 신중히 작성 필요.
- [ ] **rate-limit 구현 선택** — (a) Supabase `public.rate_limits` 테이블, (b) Upstash Redis, (c) Supabase Edge `@upstash/ratelimit` 중 최종안? — 현 `rate-limit` Blobs는 IP 키당 10분 윈도우. DB 테이블이 가장 단순하지만 DB 경합 우려.
- [ ] **IG Storage 이미지 접근 정책** — 공개 버킷 + path nonce vs 매번 signed URL 발급? — IG Graph API는 URL 다운로드 완료까지만 유효성 필요. public + 예측 불가 path가 성능/안정성 우위.
- [ ] **`ig_accounts.access_token` 암호화** — pgsodium/Vault로 암호화할지 평문 저장할지? — Supabase는 데이터베이스 레벨 암호화 기본 제공. 컬럼 레벨 추가 암호화는 운영 복잡도 증가 vs 유출 시 피해 감소.
- [ ] **이메일 확인(Email confirm) 강제 여부** — Supabase Auth 기본값은 확인 이메일 필수. 기존 가입 플로우는 즉시 로그인 → 이 정책 유지할지 비활성화할지?
- [ ] **마이그레이션 실행 시간대** — 새벽 02:00 KST 권장했으나, 대표님이 직접 수동 모니터링 가능한 시간대로 조정 가능.
