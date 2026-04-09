# Lumi Bento Grid Redesign Spec

## 참조 사이트
- nevflynn.com — 드래그 가능한 4x4 벤토 그리드 (react-grid-layout)

## 기술 스택
- gridstack.js (jQuery-free, 12KB) — React 없이 드래그 가능한 그리드
- Vanilla HTML/CSS/JS — 기존 루미 스택 유지
- CDN: https://cdn.jsdelivr.net/npm/gridstack@10/dist/gridstack-all.min.js

## Grid System
- 4 columns, gap: 16px
- Base unit: 1x1 = 280x280px (데스크톱 기준)
- Card border-radius: 32px
- Page bg: #f7f2f2 (라이트) / #111 (다크)
- Card bg: #fff (라이트) / #1c1c1e (다크)
- Accent card bg: rgba(200,80,122,0.08) (라이트) / rgba(200,80,122,0.12) (다크)
- Container max-width: 1200px, centered
- 반응형: lg(4col) md(2col, ≤996px) sm(1col, ≤480px)

## Animations (from nevflynn.com)
1. Card drag & rearrange: transition transform 0.5s, will-change: transform
2. Card hover: transition 0.25s; hover box-shadow: rgba(100,100,111,0.1) 0 5px 24px
3. Grab cursor: cursor: grab; active: grabbing
4. Filter tab reflow: gridstack built-in layout animation
5. Nav pill hover: transition opacity 0.3s; hover opacity 0.5
6. Button hover ring: box-shadow 0 0 0 2px → 5px; transition 0.2s ease-out
7. Grid height transition: 0.2s
8. Inner content transition: all; border-radius 32px; overflow hidden
9. Toggle lockdown: 드래그 on/off 토글

## Lumi Custom Animations
A. Typewriter: 캡션 데모 글자 하나씩 나타남 (border-right blink 0.7s)
B. Trend rolling: 트렌드 키워드 세로 스크롤 (@keyframes rollUp translateY(-100%) 3s)
C. Check cascade: 비교표 체크마크 순차 등장 (scale 0→1, stagger 0.1s)
D. Caption scroll: 캡션 샘플 가로 무한 스크롤 (pauseOnHover)

## 카드 배치 (총 14개)

### Row 1 (y=0)
| Card | Grid pos | Size | 내용 |
|------|----------|------|------|
| 01-hero | x0,y0 | 2x2 | Hero: "사진 한 장이면, 인스타는 끝이에요" + 폰 목업 + CTA 2개 |
| 02-demo | x2,y0 | 2x2 | 데모: 업종선택 + 사진업로드 + AI 캡션 생성 체험 (비로그인) |

### Row 2 (y=2)
| Card | Grid pos | Size | 내용 |
|------|----------|------|------|
| 03-metrics | x0,y2 | 1x1 | 핵심 수치: 평균 47초 / 4.9점 / 캡션 3개 |
| 04-before-after | x1,y2 | 1x1 | Before/After 캡션 비교 |
| 05-trend | x2,y2 | 1x2(세로) | 실시간 트렌드 키워드 롤링 애니메이션 |
| 06-how | x3,y2 | 1x1 | 3-step: 사진→캡션→게시 (간결 버전) |

### Row 3 (y=3)
| Card | Grid pos | Size | 내용 |
|------|----------|------|------|
| 07-features | x0,y3 | 2x1 | 핵심 기능 4개 아이콘 그리드 (날씨/트렌드/말투/자동게시) |
| 08-proof | x3,y3 | 1x1 | 후기 캐러셀 (4명) |

### Row 4 (y=4)
| Card | Grid pos | Size | 내용 |
|------|----------|------|------|
| 09-compare | x0,y4 | 2x1 | ChatGPT vs lumi 비교표 (체크 cascade) |
| 10-pricing | x2,y4 | 2x2 | 가격표 3단: 베이직 ₩19,000 / 스탠다드 ₩29,000 / 프로 ₩39,000 |

### Row 5 (y=5)
| Card | Grid pos | Size | 내용 |
|------|----------|------|------|
| 11-faq | x0,y5 | 1x1 | FAQ 아코디언 (8개) |
| 12-cta | x1,y5 | 1x1 | CTA: "지금 무료로 시작하기" + 잔여석 표시 |

### Row 6 (y=6)
| Card | Grid pos | Size | 내용 |
|------|----------|------|------|
| 13-caption-samples | x0,y6 | 2x1 | 실제 AI 캡션 샘플 가로 자동 스크롤 |
| 14-footer | x2,y6 | 2x1 | 사업자 정보 + 링크 (이용약관/개인정보/고객센터) — 법적 필수 |

## Navigation (상단)
- 왼쪽: lumi 로고
- 가운데: pill nav 필터 탭 — All / Feature / Price / Demo / Start
  - All: 모든 카드 표시
  - Feature: 03,04,05,06,07,08 카드만
  - Price: 09,10 카드만
  - Demo: 02 카드만
  - Start: 12 카드 (베타 신청으로 이동)
- 오른쪽: 로그인 / 대시보드 링크
- 탭 전환 시 gridstack reflow 애니메이션

## 기존 페이지 매핑
| 기존 | 새 구조 |
|------|---------|
| index.html Hero | Card 01-hero |
| index.html Demo | Card 02-demo |
| index.html Metrics | Card 03-metrics |
| index.html Proof (Before/After) | Card 04-before-after |
| index.html Features | Card 07-features |
| index.html Proof (후기) | Card 08-proof |
| index.html Compare | Card 09-compare |
| index.html Pricing | Card 10-pricing |
| index.html FAQ | Card 11-faq |
| index.html CTA | Card 12-cta |
| index.html Footer | Card 14-footer |
| (신규) 트렌드 미리보기 | Card 05-trend |
| (신규) 3-step HOW 요약 | Card 06-how |
| (신규) 캡션 샘플 롤링 | Card 13-caption-samples |

## 변경 없이 유지하는 페이지 (기능 보존)
- dashboard.html — 메인 앱 (로그인/회원가입/캡션생성/게시/설정 등 전부)
- subscribe.html — 결제 (₩19,000/₩29,000/₩39,000 + PortOne)
- beta.html — 베타 신청 폼
- support.html — 고객센터 + FAQ + 구독취소 + 회원탈퇴
- privacy.html — 개인정보 처리방침 (법적 필수)
- terms.html — 이용약관 (법적 필수)
- link.html — 공개 링크 페이지
- calendar.html — 콘텐츠 캘린더
- admin-beta.html — 관리자

## 삭제 대상
- index.backup.html
- prototype.html
- logo-preview.html
- get-festival.js (삭제된 기능 잔재)

## 법적 필수 항목 체크리스트
- [x] 개인정보 처리방침 (privacy.html) — 개인정보보호법 제30조
- [x] 이용약관 (terms.html) — 전자상거래법
- [x] 사업자 정보 Footer (상호/대표/사업자번호/통신판매업/주소/이메일) — 전자상거래법 제13조
- [x] 환불 정책 (terms.html #refund) — 전자상거래법 제17조
- [x] 회원 탈퇴 수단 (support.html) — 개인정보보호법 제36·37조
- [x] 구독 취소 수단 (dashboard + support) — 전자상거래법
- [x] 약관 동의 체크박스 (subscribe.html) — 약관규제법

## Netlify Functions (53개) — 전부 유지
인증: login, register, send-otp, verify-otp, reset-password, find-id, check-plan, check-expiry
IG연동: ig-oauth, save-ig-token, disconnect-ig, meta-webhook
캡션: demo-caption, welcome-caption, reserve, process-and-post-background, regenerate-caption, select-caption, edit-caption, save-caption, get-caption-history, select-and-post-background
예약: save-reservation, get-reservation, cancel-reservation, scheduler, get-best-time, send-daily-schedule
데이터: get-trends, update-trends, scheduled-trends, get-weather-kma, get-air-quality, get-festival, generate-calendar, get-calendar
결제: payment-prepare, payment-confirm, cancel-subscription, unsubscribe-retention, count-post
링크/프로필: get-link-page, update-link-page, update-profile, serve-image
자동응답/알림: save-auto-reply, send-kakao, send-notifications, relay-list, tone-feedback
베타/관리: beta-apply, beta-admin, feedback

## 다크모드
- 기존 루미 방식 유지: localStorage lumi_dark_mode (1=dark, 0=light)
- index.html은 body.light-mode 클래스 (기본=다크)
- FAB 토글 버튼 우하단

## 작업 순서
1. gridstack.js CDN 추가 + 기본 그리드 셋업
2. 14개 카드 HTML 구조 작성 (기존 index.html 콘텐츠 재배치)
3. 카드별 CSS 스타일링 (nevflynn.com 스펙 적용)
4. 애니메이션 8+4개 적용
5. Nav 필터 탭 + gridstack reflow
6. 반응형 (4col→2col→1col)
7. 다크모드 호환
8. 기존 JS 기능 연결 (데모 캡션, 베타 잔여석 카운트 등)
