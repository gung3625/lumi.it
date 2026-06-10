# 루미(lumi) 인수인계 — 2026-06-04

> 새 로컬/세션이 이어받기 위한 문서. `~/.claude` 자동 메모리는 머신 간 동기화 안 되므로 이 파일이 단일 소스.
> 새 세션 첫 메시지에 이 내용을 붙여넣거나, repo에서 `git pull` 후 이 파일을 읽게 할 것.

## 0. 환경 / 접근

- **repo**: `~/lumi.it` · **라이브**: lumi.it.kr · **진단**: `/api/cron-health`
- **스택**: Netlify Functions + Supabase(ap-northeast-2 서울) + Netlify CDN
- **배포**: `git push main` 만으로 빌드 트리거. ⚠️ 강제 `/builds` API 금지 (push만).
- **인증**: `~/.ssh/` 격리, GitHub PAT 키체인 저장 → push 자동.
- **브라우저 정정**: 메모리 `user_browser.md`에 "Chrome"으로 적혀 있는데 **사장님은 크롬 안 씀**(직접 정정함). 메모리가 틀림 — pull-to-refresh/overscroll 가정 시 주의.
- **현재 상태(2026-06-08 갱신)**: `main`, 최신 커밋 `c4b2373`. 코드 클린. 루트에 미적용 ops SQL 2개 untracked — `security-hardening.sql`(✅적용완료), `performance-rls.sql`(선택, 0명 규모라 비긴급).

## 1. lumi 현재 배포 상태 (전부 main 머지 완료)

### ⭐ 2026-06-09~10 세션 (가장 최근)
- **scheduler 26일 잠수 발견·수습** (`ad92098`): 05-15 커밋 3be1470 이 for→map 변환하며 `continue` 3개를 남겨 `SyntaxError: Illegal continue` → 모듈 로드 실패 → **매분 예약픽업 크론 26일 사망**. continue→return 수정 + 게이트 추가(`e5c1fc0`). 교훈: **배포 성공 ≠ 함수 로드 성공** — `node --check` 전수 + 스텁 로드테스트 필수.
- **전수 버그감사** (134 에이전트 워크플로): 확정 8건 수정(`9322af4`, `9c71849`) — regenerate-caption 잘못된 OpenAI responses API→chat/completions, tiktok-disconnect 없는 user_id 컬럼, pending-caption-rating 없는 profiles 테이블, select-caption stale scheduled_at 반환, followers-snapshot noToken 카운터, history.js null 가드, process-account-deletion listUsers 200명 페이징→sellers.id 직접 deleteUser, cleanup-stale event ReferenceError(시간당 크론 사망). 오탐 5건 검증 후 기각.
- **워치독 감시망 전수 확장** (`84ce073`): scheduler 26일 잠수를 워치독이 못 잡은 원인 = WATCH_TARGETS 가 트렌드 3종뿐. **스케줄 함수 13개 전체에 cron-guard heartbeat** (9개 신규 runGuarded 래핑, 게이트는 가드 밖 = 외부 poke 의 heartbeat 위장 차단), WATCH_TARGETS 3→12(주기별 임계치), cron-health 4→13, heartbeat 9행 사전 시딩(false alert 방지). process-account-deletion 에 게이트 신규 추가(유일하게 없었음). **라이브 검증: scheduler heartbeat success=true 프로덕션 확인**. 이제 어떤 cron 이 죽어도 워치독이 임계치 내 메일 알림.
- **토스 UX라이팅 적용** (`8c81157`, `415a5cd`): index/pricing 기능카드 제목 기능명→유저결과("내 매장 말투 그대로" 등), '실시간 트렌드' 허위표현 4곳→'매일 갱신'.
- **data-deletion-callback 멱등성 검증완료**(수정 불필요): Meta 재시도 → not_found 200 + 추적 row, 오류/중복삭제 없음. 비즈니스 심사 안전.
- 참고: ig-hashtag 크론 스케줄 이중선언(netlify.toml 17:00 UTC vs 파일 config 18:00 UTC — 둘 다 일간이라 감시 무영향, 통일은 추후).

### 2026-06-07~08 대규모 세션 (git log 가 정확한 소스)
- **초안 모드**(`post_mode='draft'`): Meta 승인 없이 사진→캡션 생성 후 게시 안 함(유일한 런칭 경로). register "초안만" 버튼·`?draft=1`, history 캡션 복사 버튼, dashboard IG모달 진입로. 흐름: reserve(scheduled_at=null)→process-and-post(status='draft', TikTok·즉시IG 둘다 스킵)→scheduler 무시→list-reservations(필터없음)→history. ⚠️ **끝-끝(실 업로드) 미검증 — 사진 1장 테스트 필요**.
- **트렌드 = 완전 정상화 + OpenAI 0원**: ①GPT 전부 제거(`TRENDS_USE_OPENAI=false`, 네이버 직접) ②데이터랩 keywordGroups 5개 제한 버그 수정(cafe/food/hair 0건 원인) ③큐레이션 데이터랩 시드 우선(merge `[datalab,adKws]` — 검색광고 의미드리프트 차단) ④시드 접미사 정리. **8개 카테고리 깨끗·업종적합 검증완료**(수동 크론 3회, collected_date 2026-06-08). 05-27부터 11일 멈춤 해소. ⚠️ get-trends.js 읽기필터(BLACKLIST 오마카세·마라탕·크로플 등 일반메뉴명 + `X맛집` 패턴)가 특정 트렌드만 노출 → 시드에 일반명사 넣어도 페이지엔 안 뜸.
- **캡션 버그 수정**(`acfc812`): 트렌드/해시태그 사진매칭 visualText 가 imageAnalysis(JSON 문자열)에 `.subjects` 객체접근→undefined로 죽어있던 것 복구(visionToContext 파싱).
- **보안 최상화**: 어드바이저 WARN 35건 해소(anon/auth SECURITY DEFINER 함수 16 REVOKE+service_role 재GRANT, 공개버킷 listing 6 DROP, 함수 search_path 13 `public,pg_temp` 고정) + **엔드포인트 78개 전수 감사**(네이티브 cron 백그라운드 5개 외부 HTTP 트리거 차단 `c4b2373`, `_shared/auth.js allowScheduledOrSecret`). RLS-no-policy 7테이블=백엔드전용 deny-all로 안전. tiktok-oauth-callback=중화확인. 남은 건 Leaked password protection 토글(Pro 전용, 무료면 스킵 OK).
- **품질**: 텍스트 그라데이션 헤드라인 가독성 전면수정(`--gradient-signature-text`, index/beta/pricing 12곳), 멀티마켓 잔재 제거.
- **OpenAI 쿼터 게이트 점검**: 셀러별 무제한, 서비스 ₩100k/일(사용량 0) → 초안 캡션 안 막힘. **키 충전만 하면 작동**.

### (이전) 2026-06-04 작업
- **트렌드 네이버 단일화** (`9e44ca3`): 쇼핑인사이트 메인 + 데이터랩 보조. 블로그/유튜브/IG/뉴스 소스 전부 제거.
  - `SOURCE_WEIGHTS = { shopping: 4, datalab: 2 }`
  - `classifySignalTier` 2축(monthlySearchTotal≥5000 = volume, velocityPct≥30 = velocity): 둘 다=strong, 하나=medium, 없음=weak.
  - 파일: `netlify/functions/scheduled-trends-v2-background.js`, `_shared/naver-shopping-insight.js`(8업종→네이버 쇼핑 대분류 매핑).
- **요금제**: `pricing.html` + `css/pages/pricing.css` 신설 (Free ₩0 / Pro ₩19,900), `netlify.toml`에 `/pricing` 라우트, index에 price-section.
- **햅틱**: `js/haptic.js` — 토스 절제 원칙대로 confirm/CTA 셀렉터만(`.cta`, `.cta-primary`, `a.beta__kakao-cta`, `.oauth-button`, `[data-ig-connect]`, `[data-next]` 등). reduce/iOS 가드.
- **토스급 마이크로 인터랙션 풀세트** (`23a7800`): toss.tech 실측 기반(bezier+spring, "한 타겟 한 모션", 절제, 완료·축하에 집중).
- **시그니처 확산 전 페이지** (`351f787`): 4색 그라데이션(--signature-1~4: #FF6B8B 핑크 / #DDA0DD 라일락 / #EDD080 노랑 / #DABA65 골드), wavy underline, warm-glow. linktree `.lt-avatar` ring을 box-shadow+토큰으로 수정.
- **seller_links 테이블 복구 완료**: 이전 대청소 때 실수로 drop됐던 걸 마이그레이션 `restore_seller_links_table`로 복구(8컬럼+인덱스+RLS). 프로필 링크 "주소 못 가져옴" 버그의 진짜 원인이었음(캐싱 아님). get-my-linktree.js는 ensureSlugForSeller 사용. 사장님 slug = `lumi-3mhru5`.

## 2. lumi 미해결 / 진행중 ⚠️ (가장 중요)

- **✅ trends cron 해결됨**(2026-06-08): OpenAI 의존 제거(돈 안 씀)+네이버 직접+데이터랩 버그 수정. 8개 카테고리 정상 적재 검증. 결정은 **(b) graceful degradation**(OpenAI 없이 네이버만)으로 확정. → 내일 아침 *네이티브* 00:00 KST 크론(수동아닌)도 8개 적재하는지 한 번 확인하면 완결.
- **★ 코어 루프 끝-끝 미검증**: `reservations`·`caption_history` 0건 = 사진→캡션→게시가 실 작동한 적 0회. **초안 모드로 사진 1장 테스트** 필요(Meta 자동게시 막혀 draft 가 유일 런칭 경로). 코드 경로는 전부 검증됨, 런타임만 미확인.
- **★ OpenAI 키 충전 확인**: 캡션 생성(gpt-4o vision)에 필수 — 키 invalid 면 캡션 status='failed'. (트렌드는 OpenAI 0원이라 무관.) 쿼터 게이트는 첫 캡션 안 막음(셀러 무제한·서비스 ₩100k/일 사용량0, 점검완료).
- **앱인토스 출시 [보류]**: 외부 OAuth(카카오/메타) 금지가 걸림돌. 워크어라운드 아이디어 = 웹에서 인스타 1회 연동 → 미니앱은 Supabase Vault에 저장된 토큰 사용(기술적으로 유효). 사장님이 "잠시 보류"함.

## 3. 사업자 / 비즈니스 인증 (마지막 작업 — 중단됨)

- **사업자 정보**: 상호 루미(lumi) · 대표 김현 · 사업자등록번호 **404-09-66416** · 통신판매업 **제2024-서울용산-1166호** · 주소 서울특별시 용산구 회나무로 32-7 04345 · 문의 lumi@lumi.it.kr · 010-6424-6284
- **★ 마지막 막힌 지점**: "통신판매업 신고증에 전화번호가 안 나온다." 어떤 인증(메타 비즈니스 인증 등)이 **사업자등록번호 + 전화번호가 한 문서에 같이 나오는** 증빙을 요구하는데, 통신판매업 신고증엔 전화번호가 없음. → 전화번호+BRN이 함께 표시되는 대체 문서(예: 사업자등록증명원, 부가세 관련 서류 등) 찾는 게 다음 작업.

## 4. 별도 프로젝트: AI 콘텐츠 수익화 (★ lumi와 무관)

- 유튜브 쇼츠 자동화 검토함. 무료 스택 가능: **edge-tts**(무료 한국어 신경망 TTS, 키 불필요) + ffmpeg + Whisper(자막) + Pexels(스톡) + ShortGPT/SaarD00 레포.
- **솔직한 결론**: 공짜 자동화 페이스리스 쇼츠 광고수익으로 월 1000만원 = 비현실(RPM 30~80원/1000뷰 → 월 1.25~2억 조회 필요). 게다가 YouTube가 2025.7 "inauthentic content" 정책으로 양산 AI demonetize 중(2026.1에 16채널 정지).
- **피벗 권고**: "AI 콘텐츠로 월 1000만원"은 B2C 광고수익이 아니라 **B2B/결과 판매**에서 나옴.
  - Tier A(현실적): ① AI 콘텐츠 대행(고객 10명×100만원) ② lumi SaaS 유료 500명(₩19,900×500≈1000만, 구독=복리) ③ 디지털 상품
  - 사장님 강점: 소상공인 이해 + lumi 엔진 보유 → 대행으로 현금 + lumi로 복리 조합 추천.
- **★ 사용자 미선택 상태**: ①대행 ②lumi 500명 ③다른 디지털상품 중 고르기로 했으나 통신판매업 질문으로 넘어가며 중단. 새 세션에서 선택 이어받으면 됨.

## 5. 작업 원칙 (반드시 준수 — 사장님이 반복 강조함)

1. **정식 운영 단계로**: "베타라 X 생략" 정당화 금지. 인증·quota·rate limit·에러 핸들링 기본 포함.
2. **추측 금지**: 검증 가능한 사실(가격·정책·사양·API 동작)은 1차 source 확인 후 답. 추정이면 명시. ← 사장님이 가장 강하게 요구한 원칙.
3. **재확인 금지**: 명확한 작업 동사 있으면 재질문 없이 즉시 시작.
4. **마이크로 인터랙션 필수**: 모든 UI 작업에 hover/focus/상태변경/stagger/유도 + reduced-motion 존중.
5. **UI 새 요소는 공간 확보**: absolute로 콘텐츠 위에 띄우지 말고 padding/flex로 분리(사진·글씨 겹침 차단).
6. **삭제 confirm 강도 조절**: 회원탈퇴급만 텍스트 입력 검증, soft delete는 단순 confirm.
7. **진행 상황 능동 모니터링**: 묻기 전에 먼저 진단·근본 원인. 같은 증상 2번이면 환경 fix.

## 6. 새 세션에서 할 것 (우선순위)

1. **★ 초안 모드 사진 1장 테스트** — 실 업로드→캡션 생성 확인(런칭 게이트). 실패 시 `reservations.caption_error` / netlify logs / `/api/cron-health` 로 디버깅.
2. **★ OpenAI 키 충전 확인** — 1번이 되려면 필수.
3. (확인) 내일 아침 `/trends` *네이티브* 크론이 cafe/food/hair 포함 8개 적재했는지.
4. (사장님 선택 대기) 통신판매업 전화번호 증빙 → BRN+전화번호 함께 나오는 문서 찾기.
5. (선택) `performance-rls.sql` 실행(스케일 전), AI 콘텐츠 수익화 ①대행/②lumi500명/③디지털상품 중 선택.
