# Bento Redesign — nevflynn.com 카피 작업 기록

## 작성일: 2026-04-10
## 상태: 기본 껍데기 완성, 루미 콘텐츠 이식 대기

---

## 1. 참조 사이트 실측 스펙 (nevflynn.com)

### 페이지 기본
- **페이지 배경**: `html { background: #f7f2f2 }` (따뜻한 베이지)
- **폰트**: `-apple-system, system-ui, Segoe UI, Roboto` (시스템 폰트)
- **텍스트 색상**: `#0d1117`
- **그리드 라이브러리**: react-grid-layout (루미는 gridstack.js로 대체)
- **그리드 컨테이너**: `max-width: 1200px`, `margin: 0 auto`, `padding: 0 0 80px`
- **스크롤바**: 숨김 (`scrollbar-width: none`)

### 로고
- **스타일**: 세리프 폰트(Georgia), `font-size: 32px`, `font-weight: 700`
- **색상**: 그라데이션 `linear-gradient(135deg, #e8628a 0%, #d4a0c0 20%, #c4a4d4 40%, #a0c4a8 60%, #7ec8c8 80%, #98d0ff 100%)`
- **효과**: `-webkit-background-clip: text; -webkit-text-fill-color: transparent`

### Nav 필터 탭
- **래퍼**: `background: rgba(0,0,0,0.04)`, `border-radius: 23px`, `padding: 4px`
- **pill**: `height: 32px`, `padding: 0 16px`, `font-size: 14px`, `font-weight: 400`, `color: #0d1117`, `border-radius: 50px`
- **active**: `background: rgba(0,0,0,0.06)`
- **hover**: `opacity: 0.5`, `transition: opacity 0.25s`
- **탭 목록**: All / About / Projects / Media (루미: All / 소개 / 기능 / 요금)
- **Contact 링크**: 오른쪽 끝, `font-size: 16px`, `color: #000`

### 카드 공통
- **border-radius**: `32px`
- **box-shadow(inset)**: `transparent 0 0 0 2px inset`
- **transition**: `all 0.25s`
- **overflow**: `hidden`
- **호버 그림자**: `rgba(100,100,111,0.1) 0 5px 24px`
- **커서**: hover → `grab`, active → `grabbing`
- **드래그 중 그림자**: `rgba(0,0,0,0.15) 0 20px 60px`

### 카드 배치 (10개, 12-column 기준 gs-w 환산)
```
Card 0: Bio         — gs-w=6  gs-h=1 @(0,0)  bg=#fff     pad=36px 42px  flex-col space-between
Card 1: Map/Avatar  — gs-w=3  gs-h=1 @(6,0)  bg=#fff     pad=0           flex-row center
Card 2: Project 1   — gs-w=3  gs-h=2 @(9,0)  bg=#6ed2b7  pad=0           flex-row center (초록/민트)
Card 3: Spotify     — gs-w=3  gs-h=1 @(0,1)  bg=#fff     pad=32px 38px  flex-col space-between
Card 4: Twitter/X   — gs-w=3  gs-h=1 @(3,1)  bg=#98d0ff  pad=0           flex-row center (하늘색)
Card 5: Project 2   — gs-w=3  gs-h=2 @(6,1)  bg=#f5b5c8  pad=0           flex-row center (핑크)
Card 6: Blog        — gs-w=6  gs-h=1 @(0,2)  bg=#fff     pad=40px 44px  flex-col space-between
Card 7: Project 3   — gs-w=6  gs-h=1 @(0,3)  bg=#f5d89a  pad=0           flex-row center (노란색)
Card 8: Dark Toggle — gs-w=3  gs-h=1 @(9,2)  bg=#fff     pad=0           flex-row center
Card 9: Newsletter  — gs-w=6  gs-h=1 @(6,3)  bg=#fff     pad=40px 44px  flex-col space-between
```

### 카드 색상 팔레트
- **흰색 카드**: `#fff`
- **하늘색**: `#98d0ff` (rgb(152,208,255))
- **핑크**: `#f5b5c8`
- **초록/민트**: `#6ed2b7` (rgb(110,210,183))
- **노란색**: `#f5d89a`
- **다크모드 카드**: `#1c1c1e`
- **다크모드 페이지**: `#111`

### 버튼 (btn-pill, nevflynn 정확값)
- `height: 36px`, `padding: 0 12px`, `border-radius: 18px`
- `background: transparent`
- `box-shadow: rgb(240,242,248) 0 0 0 2px`
- hover: `box-shadow: rgb(240,242,248) 0 0 0 5px`
- `font-size: 13px`, `font-weight: 400`
- 다크모드: `box-shadow: rgba(255,255,255,.12) 0 0 0 2px`

### 화살표 링크 버튼 (카드 좌하단)
- `width: 36px`, `height: 36px`, `border-radius: 18px`
- `background: rgba(255,255,255,.9)`
- SVG: 대각선 화살표 (↗), `stroke-width: 2.5`
- hover: `transform: scale(1.1)`

### 타이포그래피 (실측)
- Bio "nev" 대형 텍스트: `font-size: 40px`, `font-weight: 400`
- Bio 본문: `font-size: 16px`, `line-height: 1.5`
- 카드 제목 (h2): `font-size: 24px`, `font-weight: 400`, `line-height: 32px`
- 카드 설명: `font-size: 15px`, `color: rgba(13,17,35,.6)`
- 날짜/부가정보: `font-size: 14px`, `color: rgba(13,17,35,.4)`

### 애니메이션
1. **Spotify 재생 바** — 3개 바, `width: 3px`, `background: #6ed2b7`, `animation: playing ease-in-out infinite`
   - bar1: `0.85s`, bar2: `1.26s`, bar3: `0.62s`
   - keyframes: `0%,100% { height: 3px }` → `50% { height: 12px }`
2. **카드 드래그 재배치** — gridstack 내장, `transition: left 0.3s, top 0.3s`
3. **카드 호버 그림자** — `transition: 0.25s`
4. **그랩 커서** — hover: grab, active: grabbing
5. **필터 탭 리플로우** — `grid.compact()` 호출
6. **Nav pill 호버** — `opacity: 0.5`, `transition: opacity 0.25s`
7. **버튼 hover ring** — box-shadow 2px → 5px, `transition: 0.2s ease-out`
8. **그리드 높이 전환** — `.grid-stack { transition: height 0.3s }`
9. **카드 내부 전환** — `transition: all 0.25s`
10. **다크모드 전환** — `background transition 0.3s`

### 다크모드 토글 (Card 8)
- CSS 달 모양: 검정 원(`#0d1117`, 48px) 위에 흰색 원(`#fff`, 20px, top:6px right:6px)
- 다크모드에서: 흰 원(`#f0f2f8`) 위에 어두운 원(`#1c1c1e`)
- 클릭 시 `document.body.classList.toggle('dark-mode')`
- `localStorage.setItem('lumi_dark_mode', isDark ? '1' : '0')`

### 뉴스레터/CTA 카드 (Card 9)
- 이메일 인풋: `border-bottom: 2px solid #f0f2f8`, focus 시 `border-color: #C8507A`
- Subscribe 버튼: btn-pill 스타일 동일
- 구독자 수 카운터: `font-size: 24px`

---

## 2. 기술 결정 사항

### gridstack.js v10 주의사항 (삽질 기록)
- **column: 4로 init하면 카드 width가 0px이 됨** — gridstack v10 기본 CSS는 12-column 전용
- **해결**: `column: 12`로 init하고, 4열 효과는 `gs-w=3`(1칸), `gs-w=6`(2칸)으로 구현
- **columnOpts.breakpoints 사용 금지** — `columnMax: 12` 기본값과 충돌하여 width 계산 실패
- **반응형**: JS `window.matchMedia`로 `grid.column(6)` / `grid.column(1)` 직접 호출

### CDN
```html
<link href="https://cdn.jsdelivr.net/npm/gridstack@10/dist/gridstack.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/gridstack@10/dist/gridstack-all.min.js"></script>
```

### gridstack init (작동하는 설정)
```js
var grid = GridStack.init({
  column: 12,
  cellHeight: 280,
  margin: 16,
  float: true,
  animate: true,
  draggable: { handle: '.bento-card' },
  resizable: { handles: '' }
});
```

---

## 3. 현재 파일 상태

### bento-preview.html (위치: /Users/kimhyun/lumi.it/bento-preview.html)
- nevflynn.com 카피 벤토 그리드 껍데기 완성
- 10개 카드 렌더링 확인됨
- Nav 그라데이션 로고 + pill 필터 탭 (All/소개/기능/요금)
- 다크모드 토글 동작
- 필터 탭 동작
- Toggle Lockdown 동작
- Spotify 재생 바 애니메이션 동작
- **아직 루미 실제 기능 이식 안 됨**

### 확인 방법
```bash
cd /Users/kimhyun/lumi.it
python3 -m http.server 8877
# → http://localhost:8877/bento-preview.html
```

---

## 4. 루미 콘텐츠 이식 계획

### 원칙
> nevflynn.com 디자인에서 출발하여, 카드 하나씩 루미 콘텐츠로 교체한다.
> 카드는 비주얼 중심 + 텍스트 최소화. 기존 루미 사이트의 긴 텍스트 블록은 넣지 않는다.

### 카드별 이식 매핑
```
Card 0 (Bio 2x1)        → 루미 소개: 한 줄 설명 + CTA 버튼 + Toggle Lockdown
Card 1 (Map 1x1)        → 루미 아이콘/로고 or 핵심 수치 (47초 평균)
Card 2 (Project 1x2)    → AI 캡션 데모 미리보기 (폰 목업 + 결과 스크린샷)
Card 3 (Spotify 1x1)    → 실시간 트렌드 (재생 바 → 트렌드 롤링 애니메이션)
Card 4 (Twitter 1x1)    → 인스타그램 아이콘 (하늘색 배경에 IG 아이콘)
Card 5 (Project 1x2)    → 자동 게시 데모 (폰 목업 + 게시 화면 스크린샷)
Card 6 (Blog 2x1)       → ChatGPT vs lumi 비교 (짧은 문구 + 자세히 보기 버튼)
Card 7 (Project 2x1)    → 해시태그 자동 (노란색 배경에 해시태그 시각화)
Card 8 (Dark Toggle 1x1) → 다크모드 토글 (현재 그대로 유지)
Card 9 (Newsletter 2x1) → 베타 신청 CTA (이메일 인풋 + 잔여석 카운터)
```

### 이식 순서 (제안)
1. **Card 0**: 루미 소개 텍스트 교체 + 아바타를 루미 로고로
2. **Card 9**: 베타 신청 폼 연결 (beta-apply API)
3. **Card 3**: 트렌드 API 연동 (get-trends)
4. **Card 2, 5**: 폰 목업 스크린샷 추가
5. **Card 4**: 인스타그램 아이콘으로 교체
6. **Card 6**: 비교 문구 교체
7. **Card 7**: 해시태그 시각화
8. **Card 1**: 핵심 수치 또는 지도
9. **기존 JS 이식**: 데모 캡션, reCAPTCHA, SEO meta, 구조화 데이터

### 추가 카드 (필요 시)
기존 루미에 있는데 현재 10개 카드에 없는 것들:
- 가격표 → 별도 페이지(/subscribe)로 유지, 카드에는 "₩19,000~" 한 줄만
- FAQ → 별도 페이지(/support)로 유지, 카드에는 넣지 않음
- 비교표 상세 → Card 6에서 "자세히 보기" 버튼으로 모달 또는 별도 페이지
- 후기 → 필요 시 카드 1개 추가 (11번)
- Footer 사업자 정보 → 페이지 하단 별도 영역 (법적 필수)

---

## 5. 기존 index.html에서 가져올 JS 기능 목록

### 반드시 이식
- [ ] 데모 캡션 생성 (demo-caption API, 파일 리사이즈, reCAPTCHA)
- [ ] 베타 잔여석 카운트 (beta-apply count API)
- [ ] 다크모드 초기화 (localStorage lumi_dark_mode, FOUC 방지)
- [ ] 로그인 상태 Nav 분기 (lumi_user localStorage)
- [ ] SEO: title, meta, OG, Twitter, canonical, JSON-LD (SoftwareApplication, Organization, FAQPage, BreadcrumbList)
- [ ] Sticky CTA (모바일 하단 고정)
- [ ] 상단 배너 (선착순 20명)

### 이식 불필요 (삭제된 기능)
- get-festival 관련
- 주변 행사·축제 기능
- beforeunload scrollTo(0,0)

---

## 6. 파일 구조

```
/Users/kimhyun/lumi.it/
├── bento-preview.html          ← 새 벤토 그리드 (작업 중)
├── index.html                  ← 현재 프로덕션 (기존 사이트)
├── index.backup.html           ← 백업
├── docs/
│   ├── bento-redesign-spec.md  ← 초기 설계 (14카드, 이제 10카드로 변경)
│   ├── bento-task-step1~8.md   ← 기존 스텝 문서 (참고용, 직접 따르지 않음)
│   └── bento-nevflynn-spec.md  ← 이 문서 (실측 스펙 + 이식 가이드)
└── (기타 기존 파일들)
```

---

## 7. 절대 규칙 (에이전트용)

1. **bento-preview.html은 str_replace로만 수정** — 전체 파일 덮어쓰기 금지
2. **nevflynn.com 디자인에서 벗어나지 않는다** — 카드 추가/크기 변경 시 현님 승인 필요
3. **기존 루미 페이지(dashboard, subscribe, beta 등) 절대 건드리지 않는다**
4. **카드에 긴 텍스트 넣지 않는다** — 비주얼 중심, 텍스트 최소화
5. **가격 데이터는 실제 값만 사용** — 베이직 ₩19,000 / 스탠다드 ₩29,000 / 프로 ₩39,000
6. **법적 필수 항목은 반드시 포함** — Footer 사업자 정보, privacy/terms/support 링크
7. **작업 전 관련 파일 전부 읽고 시작**
8. **작업 완료 후 docs/agent-reports/에 보고서 작성**
