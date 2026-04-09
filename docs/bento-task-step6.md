# Bento Redesign Step 6: 다크모드 호환

## 선행 조건
- Step 1~5 완료

## 이번 단계 범위
기존 루미 다크모드 시스템(body 기본=다크, body.light-mode=라이트)을 벤토 그리드 전체에 적용.
모든 14개 카드, Nav, Footer, 애니메이션이 다크/라이트 양쪽에서 정상 동작해야 함.

---

## 1. 기존 다크모드 시스템 (변경 없이 유지)

index.html은 기본이 다크. body.light-mode 클래스 추가 시 라이트로 전환.

```js
// 페이지 로드 시 (body 직후, FOUC 방지)
if (localStorage.getItem('lumi_dark_mode') !== '0') {
  // 다크 유지 (기본)
} else {
  document.body.classList.add('light-mode');
}
```

```js
// FAB 토글 함수 (기존 그대로)
function toggleDarkMode(wantLight) {
  if (wantLight) document.body.classList.add('light-mode');
  else document.body.classList.remove('light-mode');
  localStorage.setItem('lumi_dark_mode', wantLight ? '0' : '1');
  var f = document.getElementById('dark-toggle-fab');
  if (f) f.textContent = wantLight ? '🌙' : '☀️';
}
```

## 2. 다크/라이트 색상 토큰 전체 목록

다크 (기본):
```css
body {
  --bg-page: #111;
  --bg-card: #1c1c1e;
  --bg-card-accent: rgba(200, 80, 122, 0.10);
  --bg-card-inner: rgba(255, 255, 255, 0.06);
  --text-primary: #f5f5f7;
  --text-secondary: rgba(255, 255, 255, 0.8);
  --text-muted: rgba(255, 255, 255, 0.48);
  --border-card: transparent;
  --border-subtle: rgba(255, 255, 255, 0.08);
  --shadow-hover: rgba(100, 100, 111, 0.1) 0 5px 24px;
  --nav-bg: rgba(17, 17, 17, 0.88);
  --pill-active-bg: rgba(255, 255, 255, 0.15);
  --btn-ring: rgba(240, 242, 248, 1);
}
```

라이트 (body.light-mode):
```css
body.light-mode {
  --bg-page: #f7f2f2;
  --bg-card: #ffffff;
  --bg-card-accent: rgba(200, 80, 122, 0.06);
  --bg-card-inner: rgba(0, 0, 0, 0.03);
  --text-primary: #1d1d1f;
  --text-secondary: rgba(0, 0, 0, 0.7);
  --text-muted: rgba(0, 0, 0, 0.48);
  --border-card: transparent;
  --border-subtle: rgba(0, 0, 0, 0.08);
  --shadow-hover: rgba(100, 100, 111, 0.08) 0 5px 24px;
  --nav-bg: rgba(247, 242, 242, 0.88);
  --pill-active-bg: rgba(0, 0, 0, 0.08);
  --btn-ring: rgba(48, 54, 61, 1);
}
```

## 3. CSS에서 토큰 사용으로 통일

하드코딩된 색상을 모두 CSS 변수로 교체:
```css
body { background: var(--bg-page); color: var(--text-secondary); }
.bento-card { background: var(--bg-card); }
.bento-card.accent { background: var(--bg-card-accent); }
.bento-card .card-title { color: var(--text-primary); }
.bento-card .card-desc { color: var(--text-secondary); }
.bento-card .card-label { color: var(--text-muted); }

nav { background: var(--nav-bg); }
.nav-filter-pill.active { background: var(--pill-active-bg); }

.btn-bento { box-shadow: var(--btn-ring) 0 0 0 2px; color: var(--text-secondary); }
.btn-bento:hover { box-shadow: var(--btn-ring) 0 0 0 5px; }

.grid-stack-item-content:hover { box-shadow: var(--shadow-hover); }
```

## 4. 개별 카드 다크모드 대응

### Pricing 카드
```css
.price-mini-col {
  background: var(--bg-card-inner);
}
.price-mini-col .price-amount { color: var(--text-primary); }
.price-mini-col .price-unit { color: var(--text-muted); }
.price-mini-col .price-label { color: var(--text-muted); }
.price-mini-col.highlight {
  box-shadow: 0 0 0 2px var(--pink);
}
```

### Compare 카드
```css
.compare-mini-table th { color: var(--text-muted); border-color: var(--border-subtle); }
.compare-mini-table td { color: var(--text-secondary); border-color: var(--border-subtle); }
.compare-mini-table .cell-lumi { color: var(--pink); font-weight: 600; }
```

### FAQ 카드
```css
.faq-mini-item { color: var(--text-secondary); border-color: var(--border-subtle); }
.faq-mini-item .faq-answer { color: var(--text-muted); }
```

### Before/After 카드
```css
.ba-mini-before { background: var(--bg-card-inner); }
.ba-mini-after { background: rgba(200, 80, 122, 0.08); }
.ba-mini-before .ba-label { color: var(--text-muted); }
.ba-mini-after .ba-label { color: var(--pink); }
```

### Proof/후기 카드
```css
.proof-mini-card {
  background: var(--bg-card-inner);
  border-radius: 12px;
  padding: 14px;
}
.proof-mini-name { color: var(--text-primary); }
.proof-mini-text { color: var(--text-secondary); }
.proof-mini-stars { color: var(--text-muted); }
```

### Trend 카드
```css
.trend-keyword { color: var(--pink); } /* 핑크는 다크/라이트 동일 */
.trend-card-title { color: var(--text-primary); }
```

### Caption Samples 카드
```css
.caption-sample-card { background: var(--bg-card-inner); }
.caption-sample-biz { color: var(--pink); }
.caption-sample-text { color: var(--text-secondary); }
.caption-sample-tags { color: var(--text-muted); }
```

### Footer 카드
```css
.bento-card.card-footer {
  background: var(--bg-card);
}
.footer-info { color: var(--text-muted); }
.footer-link { color: var(--text-secondary); }
.footer-link:hover { color: var(--pink); }
.footer-copy { color: var(--text-muted); }
```

### Metrics 카드
```css
.metric-num { color: var(--text-primary); }
.metric-label { color: var(--text-muted); }
```

### CTA 카드
```css
.bento-card.card-cta .cta-title { color: var(--text-primary); }
.bento-card.card-cta .cta-desc { color: var(--text-muted); }
/* CTA 버튼은 --pink 배경이므로 다크/라이트 동일 */
```

## 5. Demo 카드 다크모드 (기존 JS 보존)

데모 캡션 카드는 기존 index-old.html의 demo 섹션 스타일 그대로 가져오되, 새 토큰으로 교체:
```css
.bento-card.card-demo .demo-select {
  background: var(--bg-card-inner);
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
}
.bento-card.card-demo .demo-upload {
  border: 2px dashed var(--border-subtle);
  color: var(--text-muted);
}
.bento-card.card-demo .demo-btn {
  background: var(--pink);
  color: #fff;
}
.bento-card.card-demo .demo-btn:disabled {
  background: var(--bg-card-inner);
  color: var(--text-muted);
}
```

## 6. FOUC(Flash of Unstyled Content) 방지

기존 index-old.html에서 사용하던 방식 그대로:
```html
<body>
<script>
  if (localStorage.getItem('lumi_dark_mode') === '0') {
    document.body.classList.add('light-mode');
  }
</script>
<!-- 나머지 콘텐츠 -->
```
이 스크립트는 body 태그 직후에 위치해야 하며, DOMContentLoaded 전에 실행되어야 한다.

## 7. FAB 토글 버튼 (기존 스타일 유지)

```css
.dark-toggle-fab {
  position: fixed;
  right: 16px;
  bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  z-index: 9999;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: #191F28;
  color: #fff;
  font-size: 1.2rem;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0,0,0,.25);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all .3s;
}
.dark-toggle-fab:hover { transform: scale(1.08); }
body.light-mode .dark-toggle-fab {
  background: #fff;
  color: #191F28;
  box-shadow: 0 4px 16px rgba(0,0,0,.1);
}
```

---

## 확인 항목
- [ ] 다크 모드(기본): 페이지 bg #111, 카드 bg #1c1c1e, 텍스트 밝은색
- [ ] 라이트 모드: 페이지 bg #f7f2f2, 카드 bg #fff, 텍스트 어두운색
- [ ] FAB 토글 클릭 시 즉시 전환 (FOUC 없음)
- [ ] 모든 14개 카드에서 텍스트가 배경 위에서 읽힘
- [ ] Nav 배경 blur + 투명도 다크/라이트 양쪽 정상
- [ ] 핑크(#C8507A) 요소는 다크/라이트 양쪽에서 동일
- [ ] Pricing 카드: 가격 숫자, 플랜명, 기능 목록 다크/라이트 정상
- [ ] Compare 비교표: 헤더, 셀 텍스트, lumi 열 강조 다크/라이트 정상
- [ ] FAQ 아코디언: 질문/답변 텍스트 다크/라이트 정상
- [ ] Demo 카드: select, upload 영역, 버튼 다크/라이트 정상
- [ ] Caption scroll: 캡션 카드 배경/텍스트 다크/라이트 정상
- [ ] localStorage 값 유지 확인 (새로고침 시 모드 유지)
- [ ] 다른 페이지(dashboard, subscribe 등) 다크모드와 충돌 없음
