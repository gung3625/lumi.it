# Design System: lumi — Bento Grid

## 1. Visual Theme & Atmosphere

lumi의 랜딩 페이지는 nevflynn.com에서 영감을 받은 드래그 가능한 벤토 그리드 레이아웃이다. 따뜻한 베이지 배경(`#fdf2f4`) 위에 둥근 카드들이 배치되며, 각 카드는 독립적인 콘텐츠 모듈 역할을 한다. 전체적으로 부드럽고 친근한 인상을 주되, 소상공인이 직관적으로 서비스를 이해할 수 있는 구조를 지향한다.

**Key Characteristics:**
- 벤토 그리드: react-grid-layout 기반, 드래그 재배치 가능
- 카드 border-radius: 32px — 부드럽고 둥근 인상
- 페이지 배경: `#fdf2f4` (라이트) / `#111` (다크)
- 폰트: Jua (한글 디스플레이) + 시스템 폰트
- 브랜드 액센트: 핑크 그라디언트 `linear-gradient(135deg, #FF6B8B, #DDA0DD)`
- 그리드 max-width: 1200px, centered
- 카드 hover → grab 커서, 드래그 중 → grabbing
- 호버 그림자: `rgba(100,100,111,0.1) 0 5px 24px`

## 2. Color Palette & Roles

### Page Background
- **Light**: `#fdf2f4` (따뜻한 베이지-핑크)
- **Dark**: `#111`

### Card Background
- **Light**: `#fff`
- **Dark**: `#1c1c1e`

### Accent Card Backgrounds
- **하늘색**: `#9DCBF5` (트렌드 카드)
- **핑크**: `#f5b5c8` (프로젝트 카드)
- **초록/민트**: `#5bbfa5` (데모 카드)
- **노란색**: `#f5d89a` (해시태그 카드)
- **인스타 그라디언트**: `linear-gradient(135deg, #feda75, #fa7e1e, #d62976, #962fbf, #4f5bd5)`

### Brand
- **Pink Gradient**: `linear-gradient(135deg, #FF6B8B, #DDA0DD)`
- **Pink Accent**: `#C8507A` (포커스, CTA 강조)
- **Logo Gradient**: `linear-gradient(90deg, #FF6B8B 0%, #DDA0DD 50%, #EDD080 85%, #DABA65 100%)`

### Text
- **Primary (Light)**: `#0d1117`
- **Primary (Dark)**: `#f0f2f8`
- **Secondary (Light)**: `rgba(13,17,23,.5)`
- **Secondary (Dark)**: `rgba(240,242,248,.6)`
- **Tertiary (Light)**: `rgba(13,17,35,.4)`
- **Tertiary (Dark)**: `rgba(240,242,248,.4)`

### Interactive
- **Button Dark**: `#0d1117` bg / `#fff` text
- **Button Dark (dark mode)**: `#f0f2f8` bg / `#0d1117` text
- **Input Focus Border**: `#C8507A`
- **Pill Shadow**: `rgb(240,242,248) 0 0 0 2px` → hover `5px`
- **Pill Shadow (dark)**: `rgba(255,255,255,.12) 0 0 0 2px`

## 3. Typography Rules

### Font Family
- **Display/Body**: `'Jua', -apple-system, BlinkMacSystemFont, sans-serif`
- **Logo**: `'Nunito', sans-serif` (weight 800)
- **금지**: Inter, Roboto, Arial 사용 금지

### Hierarchy

| Role | Size | Weight | Line Height | Letter Spacing | Notes |
|------|------|--------|-------------|----------------|-------|
| Logo | 42px | 800 | — | -0.5px | Nunito, 그라디언트 clip |
| Bio Name | 40px | 400 | — | -1px | 카드 내 대형 텍스트 |
| Card Title | 24px | 400 | 32px | — | h2 레벨 |
| Upload Prompt Large | 32px | 400 | — | — | 업로드 카드 강조 텍스트 |
| Body | 16px | 400 | 1.5 | — | 기본 본문 |
| Description | 15px | 400 | 1.5-1.7 | — | 카드 설명, 부가 텍스트 |
| Nav Pill | 14px | 400 | — | — | 필터 탭 |
| Caption/Small | 13-14px | 400 | — | — | 날짜, 부가정보 |
| Micro | 11-12px | 400-600 | — | — | 트렌드 태그, 배지 |
| Nano | 10px | 400-600 | — | — | 트렌드 변동, 최소 텍스트 |

### 반응형 텍스트 (필수)
모든 텍스트는 화면/카드 크기에 따라 잘리지 않아야 한다:
```css
/* 잘림 방지 필수 패턴 */
font-size: clamp([최소], [기본vw], [최대]);
overflow-wrap: break-word;
word-break: keep-all;  /* 한글 단어 단위 줄바꿈 */
```

| Role | clamp 값 |
|------|---------|
| Bio Name | `clamp(24px, 5vw, 40px)` |
| Card Title | `clamp(18px, 3vw, 24px)` |
| Body | `clamp(14px, 2.5vw, 16px)` |
| Description | `clamp(13px, 2vw, 15px)` |
| Nav Pill | `clamp(12px, 2vw, 14px)` |
| Button Text | `clamp(13px, 2vw, 16px)` |

## 4. Component Stylings

### Bento Card (공통)
```css
.bento-card {
  border-radius: 32px;
  overflow: hidden;
  min-height: 200px;           /* 카드 찌그러짐 방지 */
  height: 100%;
  width: 100%;
}
```
- Border: 없음 (box-shadow inset transparent 0 0 0 2px)
- Hover: `box-shadow: rgba(100,100,111,0.1) 0 5px 24px`
- Drag: `box-shadow: rgba(0,0,0,0.15) 0 20px 60px`
- Cursor: hover → `grab`, active → `grabbing`

### 카드 내부 텍스트 (잘림 방지 필수)
```css
.bento-card * {
  overflow-wrap: break-word;
  word-break: keep-all;
}
.bento-card h2,
.bento-card p,
.bento-card span {
  min-width: 0;              /* flex 잘림 방지 */
  max-width: 100%;           /* 부모 넘침 방지 */
}
```

### 카드 내부 패딩 (반응형)
```css
.card-text {
  padding: clamp(20px, 4vw, 44px);
}
```

### Nav Pills (필터 탭)
- Wrapper: `background: rgba(0,0,0,0.04)`, `border-radius: 23px`, `padding: 4px`
- Pill: `height: 32px`, `padding: 0 16px`, `border-radius: 50px`
- Active: `background: rgba(0,0,0,0.06)`
- Hover: `opacity: 0.5`, `transition: opacity 0.25s`
- 모바일: 가로 스크롤, `overflow-x: auto`, `scrollbar-width: none`

### Buttons

**Upload CTA (그라디언트)**
```css
.upload-btn {
  padding: clamp(12px, 2vw, 14px) clamp(24px, 4vw, 36px);
  border-radius: 24px;
  background: linear-gradient(135deg, #FF6B8B, #DDA0DD);
  color: #fff;
  font-size: clamp(14px, 2.5vw, 16px);
  white-space: nowrap;
  min-width: fit-content;    /* 버튼 텍스트 잘림 방지 */
}
```

**Pill Button (nevflynn 스타일)**
```css
.btn-pill {
  height: 36px;
  padding: 0 12px;
  border-radius: 18px;
  background: rgba(255,255,255,.9);
  font-size: 13px;
  white-space: nowrap;
  min-width: fit-content;    /* 잘림 방지 */
}
```

**Dark Solid Button**
```css
.upload-submit {
  padding: clamp(10px, 2vw, 12px);
  border-radius: 14px;
  background: #0d1117;
  color: #fff;
  font-size: clamp(13px, 2vw, 14px);
}
```

### Input Fields
```css
input, textarea, select {
  font-size: max(16px, 1em);  /* iOS 줌 방지: 16px 미만 금지 */
  min-height: 44px;            /* 터치 타겟 최소 크기 */
}
```

### Cards & Containers (Container Query 사용)
```css
.card-responsive {
  container-type: size;
}
/* 카드 높이 400px 이상일 때 내부 요소 확대 */
@container (min-height: 400px) { ... }
/* 카드 너비 600px 이상일 때 패딩 확대 */
@container (min-width: 600px) { ... }
```

## 5. Layout Principles

### Grid System
- Library: react-grid-layout (nevflynn.com과 동일)
- Columns: 12-column 기준 (4열 효과 = gs-w 3 per card)
- Cell Height: 280px (데스크톱 기준)
- Gap/Margin: 16px
- Container: `max-width: 1200px`, `margin: 0 auto`
- Float: true (자유 배치)
- Animate: true (드래그 시 전환 효과)

### Card Sizes (12-column 기준)
| Size | gs-w | gs-h | 실제 느낌 |
|------|------|------|----------|
| 1x1 | 3 | 1 | 작은 정사각형 |
| 2x1 | 6 | 1 | 가로 직사각형 |
| 1x2 | 3 | 2 | 세로 직사각형 |
| 2x2 | 6 | 2 | 큰 정사각형 |

### 반응형 Breakpoints
| Name | Width | Columns | Max Width |
|------|-------|---------|-----------|
| Desktop | >1200px | 12 (4열) | 1200px |
| Tablet | 800-1200px | 8 (2열) | 800px |
| Mobile | 375-799px | 4 (1열) | 375px |
| Small Mobile | <375px | 4 (1열) | 320px |

### 잘림 방지 레이아웃 규칙
```css
/* flex 컨테이너 내부 잘림 방지 */
.flex-container > * {
  min-width: 0;
  flex-shrink: 1;
}

/* grid 컨테이너 내부 잘림 방지 */
.grid-container {
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
}

/* 카드 내부 overflow 처리 */
.bento-card {
  overflow: hidden;        /* 카드 외곽은 숨김 */
}
.bento-card > .card-inner {
  overflow-y: auto;        /* 내부 콘텐츠가 넘치면 스크롤 */
  overflow-x: hidden;      /* 가로 넘침은 차단 */
  -webkit-overflow-scrolling: touch;
}
```

## 6. Animations

### 카드 전환
- Drag 재배치: `transition: 500ms`, `will-change: transform`
- Hover 그림자: `transition: 0.25s`
- Grid 높이 변경: `transition: height 0.2s`

### 데모 씬 (6단계 루프, 18초)
1. 사진 업로드 → 2. 스캔 → 3. 캡션 타이핑 → 4. 해시태그 → 5. 완료 체크 → 6. IG 피드 미리보기

### 트렌드 롤링
- 키워드 아이템 `transition: top 0.6s cubic-bezier(.4,0,.2,1)`
- 3초마다 순위 변경

### 기타
- 루미 캐릭터: `translateY(-6px)` idle 바운스 3초
- Arrow pulse: `translateY(-3px)` + box-shadow 핑크 글로우 2.5초
- 다크모드 전환: `background transition 0.3s`

## 7. Dark Mode

### 전환 방식
- `body.dark-mode` 클래스 토글
- localStorage: `lumi_dark_mode` (`1`=dark, `0`=light)
- FAB 토글 버튼 (카드 내 슬라이딩 스위치)

### 색상 매핑
| Element | Light | Dark |
|---------|-------|------|
| Page bg | `#fdf2f4` | `#111` |
| Card bg | `#fff` | `#1c1c1e` |
| Text primary | `#0d1117` | `#f0f2f8` |
| Text secondary | `rgba(13,17,23,.5)` | `rgba(240,242,248,.6)` |
| Nav pills bg | `rgba(0,0,0,.04)` | `rgba(255,255,255,.08)` |
| Pill active | `rgba(0,0,0,.06)` | `rgba(255,255,255,.12)` |
| Button | `#0d1117` bg | `#f0f2f8` bg |
| Input focus | `#C8507A` | `#C8507A` |
| Accent cards | 개별 색상 | `#1c1c1e` 통일 |
| Hover shadow | `rgba(100,100,111,.1)` | `rgba(255,255,255,.05)` |

## 8. Do's and Don'ts

### Do
- 모든 텍스트에 `clamp()` 사용하여 반응형 크기 조절
- 카드 내부 요소에 `min-width: 0` + `overflow-wrap: break-word` 적용
- 버튼에 `white-space: nowrap` + `min-width: fit-content` 적용
- 한글에 `word-break: keep-all` 적용 (단어 단위 줄바꿈)
- input/textarea에 `font-size: max(16px, 1em)` (iOS 줌 방지)
- 카드 패딩에 `clamp()` 사용: `clamp(20px, 4vw, 44px)`
- 터치 타겟 최소 44px 유지
- Container Query로 카드 크기별 내부 레이아웃 조절
- 다크모드에서 모든 텍스트·버튼 색상 대비 확인

### Don't
- `px` 고정값으로 폰트/패딩 하드코딩하지 않기 (반응형 깨짐)
- `overflow: hidden`을 텍스트 컨테이너에 직접 적용하지 않기 (글자 잘림)
- `height` 고정값을 카드 내부 요소에 주지 않기 (콘텐츠 넘침)
- `text-overflow: ellipsis` 남발하지 않기 (정보 손실)
- Inter, Roboto, Arial 사용하지 않기
- 보라 그라디언트 사용하지 않기
- 카드에 border 사용하지 않기 (shadow로 대체)
- flex 자식에 `min-width` 없이 사용하지 않기 (잘림 원인)

## 9. Agent Prompt Guide

### Quick Color Reference
- Page bg: `#fdf2f4` (light) / `#111` (dark)
- Card bg: `#fff` (light) / `#1c1c1e` (dark)
- Brand gradient: `linear-gradient(135deg, #FF6B8B, #DDA0DD)`
- Accent: `#C8507A`
- Text: `#0d1117` (light) / `#f0f2f8` (dark)
- Card radius: `32px`
- Button radius: `18px` (pill) / `24px` (CTA)

### 잘림 방지 체크리스트 (커밋 전 필수)
1. [ ] 모든 텍스트가 `clamp()` 사용하는가?
2. [ ] flex 자식에 `min-width: 0` 있는가?
3. [ ] 버튼에 `white-space: nowrap` + `min-width: fit-content` 있는가?
4. [ ] 한글에 `word-break: keep-all` 있는가?
5. [ ] input font-size가 16px 이상인가? (iOS)
6. [ ] 모바일(375px)에서 카드 내부 콘텐츠가 넘치지 않는가?
7. [ ] 다크모드에서 텍스트가 보이는가?
8. [ ] 터치 타겟이 44px 이상인가?

### Example Component Prompt
- "벤토 카드 추가: `#fff` 배경, 32px radius, border 없음, 패딩 `clamp(20px, 4vw, 44px)`. 제목 `clamp(18px, 3vw, 24px)` Jua weight 400, 설명 `clamp(13px, 2vw, 15px)` color `rgba(13,17,23,.5)`. 다크모드: `#1c1c1e` 배경, `#f0f2f8` 텍스트."
