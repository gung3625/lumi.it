# 루미(lumi) 인수인계 — 2026-06-04

> 새 로컬/세션이 이어받기 위한 문서. `~/.claude` 자동 메모리는 머신 간 동기화 안 되므로 이 파일이 단일 소스.
> 새 세션 첫 메시지에 이 내용을 붙여넣거나, repo에서 `git pull` 후 이 파일을 읽게 할 것.

## 0. 환경 / 접근

- **repo**: `~/lumi.it` · **라이브**: lumi.it.kr · **진단**: `/api/cron-health`
- **스택**: Netlify Functions + Supabase(ap-northeast-2 서울) + Netlify CDN
- **배포**: `git push main` 만으로 빌드 트리거. ⚠️ 강제 `/builds` API 금지 (push만).
- **인증**: `~/.ssh/` 격리, GitHub PAT 키체인 저장 → push 자동.
- **브라우저 정정**: 메모리 `user_browser.md`에 "Chrome"으로 적혀 있는데 **사장님은 크롬 안 씀**(직접 정정함). 메모리가 틀림 — pull-to-refresh/overscroll 가정 시 주의.
- **현재 상태**: `main` 브랜치, 워킹트리 클린, 최신 커밋 `9e44ca3`, SW `lumi-v58`.

## 1. lumi 현재 배포 상태 (전부 main 머지 완료)

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

- **★ trends cron 죽어 있음** — `OPENAI_API_KEY` invalid. 05-27부터 0 rows(6일+). `scheduled-trends-v2-background.js` 655·1809·1927·1967행이 OpenAI 의존. 이미지 생성(gpt-image-2)도 같은 키라 같이 죽음.
  - **결정 필요**: (a) OpenAI 결제/충전 vs (b) graceful degradation — OpenAI 없어도 네이버 키워드만이라도 노출되게. 사장님 아직 미결정.
- **todo (in_progress)**: 첫 trends cron 로그 모니터링 (쇼핑 상위·tier·에러 확인). `netlify logs` 또는 `/api/cron-health`로 확인.
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

1. (사장님 선택 대기) 통신판매업 전화번호 증빙 문제 이어받기 → BRN+전화번호 함께 나오는 문서 찾기.
2. trends cron OpenAI 이슈 결정 (충전 vs graceful degradation).
3. (선택 시) AI 콘텐츠 수익화 ①/②/③ 중 하나 실행 플랜.
