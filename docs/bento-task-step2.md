# Bento Redesign Step 2: 카드별 CSS 스타일링 (nevflynn.com 스펙)

## 선행 조건
- Step 1 완료 (gridstack.js + 14개 카드 HTML 구조)
- index-old.html 백업 확인

## 이번 단계 범위
Step 1에서 만든 14개 카드에 nevflynn.com과 동일한 시각 스타일을 입힌다.

## 1. 페이지 배경
```css
/* 라이트 (기본 = 다크이므로 light-mode 클래스에 적용) */
body.light-mode { background: #f7f2f2; }
/* 다크 (기본) */
body { background: #111; }
```

## 2. 벤토 카드 기본 스타일
nevflynn.com에서 추출한 정확한 값:

```css
.bento-card {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  padding: 36px 42px;
  border-radius: 32px;
  overflow: hidden;
  background: #fff;
  box-shadow: transparent 0 0 0 2px inset;
  transition: 0.25s;
}

/* 다크모드 */
body:not(.light-mode) .bento-card {
  background: #1c1c1e;
  color: rgba(255,255,255,.8);
}
```

## 3. 카드 호버 효과 (nevflynn.com 정확 값)
```css
/* 그리드 아이템 래퍼 */
.grid-stack-item-content {
  overflow: hidden;
  border-radius: 32px;
  user-select: none;
  transition: 0.25s;
}
.grid-stack-item-content:hover {
  cursor: grab;
  box-shadow: rgba(100, 100, 111, 0.1) 0px 5px 24px 0px;
}
.grid-stack-item-content:active {
  cursor: grabbing;
}
```

## 4. 악센트 카드 (핑크 틴트)
카드 05-trend, 06-how, 13-caption-samples에 적용:
```css
.bento-card.accent {
  background: rgba(200, 80, 122, 0.06);
}
body:not(.light-mode) .bento-card.accent {
  background: rgba(200, 80, 122, 0.10);
}
```

## 5. 카드 내부 타이포그래피
기존 루미 디자인 시스템 유지:
```css
.bento-card .card-label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--text-48);
  margin-bottom: 8px;
}
.bento-card .card-title {
  font-size: 28px;
  font-weight: 600;
  line-height: 1.14;
  letter-spacing: -0.28px;
  color: var(--text);
  margin-bottom: 8px;
}
.bento-card .card-desc {
  font-size: 15px;
  font-weight: 400;
  letter-spacing: -0.2px;
  color: var(--text-80);
  line-height: 1.47;
}
/* 라이트모드 */
body.light-mode .bento-card .card-title { color: #1d1d1f; }
body.light-mode .bento-card .card-desc { color: rgba(0,0,0,.6); }
body.light-mode .bento-card .card-label { color: rgba(0,0,0,.48); }
```

## 6. 개별 카드 크기별 패딩 조정
- 2x2 카드 (hero, demo, pricing): padding 36px 42px (기본)
- 2x1 카드 (features, compare, caption-samples, footer): padding 28px 32px
- 1x1 카드: padding 24px 28px
- 1x2 세로 카드 (trend): padding 28px 28px

```css
.bento-card.size-2x1,
.bento-card.size-footer { padding: 28px 32px; }
.bento-card.size-1x1 { padding: 24px 28px; }
.bento-card.size-1x2 { padding: 28px 28px; }
```

## 7. 카드 내부 구분선 / 리스트 스타일
기존 루미 가격표, 비교표, FAQ 스타일을 벤토 카드 안에서 작동하도록 조정:
```css
/* 가격표 카드 내부 */
.bento-card .price-mini-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
  width: 100%;
}
.bento-card .price-mini-col {
  background: rgba(255,255,255,.06);
  border-radius: 12px;
  padding: 16px 12px;
  text-align: center;
}
body.light-mode .bento-card .price-mini-col {
  background: rgba(0,0,0,.03);
}

/* FAQ 카드 내부 */
.bento-card .faq-mini-item {
  padding: 12px 0;
  border-bottom: 1px solid rgba(255,255,255,.08);
  cursor: pointer;
  font-size: 14px;
}
.bento-card .faq-mini-item:last-child { border-bottom: none; }
body.light-mode .bento-card .faq-mini-item {
  border-color: rgba(0,0,0,.08);
}

/* 비교표 카드 내부 */
.bento-card .compare-mini-table {
  width: 100%;
  font-size: 13px;
  border-collapse: collapse;
}
.bento-card .compare-mini-table th {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .05em;
  padding: 8px 6px;
  border-bottom: 1px solid rgba(255,255,255,.1);
}
.bento-card .compare-mini-table td {
  padding: 8px 6px;
  border-bottom: 1px solid rgba(255,255,255,.06);
}
```

## 8. 버튼 스타일 (카드 내부)
nevflynn.com 버튼 호버 링 효과:
```css
.bento-card .btn-bento {
  display: inline-flex;
  align-items: center;
  height: 36px;
  padding: 0 16px;
  border: none;
  border-radius: 18px;
  background: transparent;
  box-shadow: rgba(240,242,248,1) 0 0 0 2px;
  color: var(--text-80);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: box-shadow 0.2s ease-out;
  will-change: box-shadow, transform;
  font-family: inherit;
}
.bento-card .btn-bento:hover {
  box-shadow: rgba(240,242,248,1) 0 0 0 5px;
}
body.light-mode .bento-card .btn-bento {
  box-shadow: rgba(48,54,61,1) 0 0 0 2px;
  color: rgba(0,0,0,.8);
}
body.light-mode .bento-card .btn-bento:hover {
  box-shadow: rgba(48,54,61,1) 0 0 0 5px;
}

/* 핑크 CTA 버튼 (기존 루미 스타일 유지) */
.bento-card .btn-bento-primary {
  background: var(--pink);
  color: #fff;
  box-shadow: none;
  border-radius: 980px;
  padding: 0 22px;
  height: 40px;
  font-size: 15px;
}
.bento-card .btn-bento-primary:hover {
  opacity: .88;
  box-shadow: none;
}
```

## 9. gridstack 오버라이드
gridstack 기본 스타일을 nevflynn.com 스펙으로 덮어쓰기:
```css
/* gridstack 기본 테두리/그림자 제거 */
.grid-stack > .grid-stack-item > .grid-stack-item-content {
  border: none;
  box-shadow: none;
  background: transparent;
  border-radius: 32px;
  overflow: hidden;
}

/* 드래그 중 플레이스홀더 */
.grid-stack > .grid-stack-item.grid-stack-placeholder > .placeholder-content {
  background: rgba(200, 80, 122, 0.15);
  border: 2px dashed var(--pink);
  border-radius: 32px;
}

/* 드래그 중인 아이템 */
.grid-stack > .grid-stack-item.ui-draggable-dragging {
  z-index: 100;
  box-shadow: rgba(0,0,0,.2) 0 20px 60px;
}
```

## 10. 스크롤바 숨기기 (기존 유지)
```css
html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar { display: none; }
html, body, * { scrollbar-width: none; }
```

## 절대 규칙
- 기존 루미 CSS 변수 (--pink, --text, --text-80, --text-48, --surface-2 등) 그대로 사용
- 기존 루미 폰트 (Pretendard Variable) 유지
- nevflynn.com 값과 루미 디자인 시스템이 충돌하면 루미 색상 + nevflynn 레이아웃으로 조합
- 다크모드 (body 기본=다크, body.light-mode=라이트) 기존 방식 유지
- 모든 카드는 다크/라이트 양쪽에서 텍스트가 읽혀야 함

## 확인 항목
- [ ] 모든 14개 카드에 .bento-card 클래스 적용됨
- [ ] hover shadow 동작 확인
- [ ] grab/grabbing cursor 동작 확인
- [ ] 다크모드 전환 시 카드 배경/텍스트 정상
- [ ] 가격표 카드 내부 3단 레이아웃 정상
- [ ] FAQ 아코디언 카드 내부 동작
- [ ] 비교표 카드 내부 표 정상
- [ ] 버튼 hover ring 효과 동작
