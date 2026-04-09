# Bento Redesign Step 5: 반응형 (4col → 2col → 1col)

## 선행 조건
- Step 1~4 완료

## 이번 단계 범위
gridstack.js 반응형 브레이크포인트 설정 + 각 브레이크포인트에서 카드 재배치 규칙

---

## 1. gridstack 반응형 설정

gridstack.js는 column 수를 동적으로 변경 가능:

```js
var grid = GridStack.init({
  column: 4,
  cellHeight: 280,
  margin: 16,
  float: true,
  animate: true,
  columnOpts: {
    breakpoints: [
      { w: 480, column: 1 },    // 모바일: 1열
      { w: 768, column: 2 },    // 태블릿: 2열
      { w: 996, column: 2 },    // 태블릿 큰: 2열
      { w: 1200, column: 4 }    // 데스크톱: 4열
    ]
  }
});
```

## 2. 브레이크포인트별 카드 재배치

### Desktop (≥1200px): 4 columns
스펙 원본 배치 그대로. docs/bento-redesign-spec.md 참조.

### Tablet (769px ~ 996px): 2 columns
모든 카드가 2열로 리플로우. 크기 변환 규칙:
```
2x2 카드 → 2x2 유지 (가로 꽉 참)
2x1 카드 → 2x1 유지 (가로 꽉 참)
1x1 카드 → 1x1 유지
1x2 카드 → 1x2 유지
```

카드 순서 (위→아래):
```
Row 0: [01-hero: 2x2]
Row 2: [02-demo: 2x2]
Row 4: [03-metrics: 1x1] [04-before-after: 1x1]
Row 5: [05-trend: 1x2]  [06-how: 1x1]
                         [08-proof: 1x1] ← 06 아래
Row 7: [07-features: 2x1]
Row 8: [09-compare: 2x1]
Row 9: [10-pricing: 2x2]
Row 11: [11-faq: 1x1] [12-cta: 1x1]
Row 12: [13-caption-samples: 2x1]
Row 13: [14-footer: 2x1]
```

### Mobile (≤480px): 1 column
모든 카드가 1열로 세로 스택. 크기 변환:
```
모든 카드 → w=1 (가로 꽉 참)
2x2 카드 → 1x2 (높이 유지)
2x1 카드 → 1x1 (높이 축소)
1x2 카드 → 1x2 유지
1x1 카드 → 1x1 유지
```

순서: hero → demo → metrics → before-after → trend → how → features → proof → compare → pricing → faq → cta → caption-samples → footer

## 3. 모바일에서 드래그 비활성화

모바일 터치에서 드래그가 스크롤을 방해하므로:
```js
function checkMobileDrag() {
  if (window.innerWidth <= 768) {
    grid.disable(); // 드래그 비활성화
    var lockBtn = document.getElementById('lockdown-btn');
    if (lockBtn) lockBtn.style.display = 'none'; // 잠금 버튼도 숨김
  } else {
    grid.enable();
    var lockBtn = document.getElementById('lockdown-btn');
    if (lockBtn) lockBtn.style.display = '';
  }
}
window.addEventListener('resize', checkMobileDrag);
document.addEventListener('DOMContentLoaded', checkMobileDrag);
```

## 4. 카드 내부 반응형

### Hero 카드 (2x2 → 모바일 1x2)
```css
@media (max-width: 480px) {
  .bento-card.card-hero .hero-title {
    font-size: clamp(1.5rem, 6.5vw, 2.2rem);
  }
  .bento-card.card-hero .hero-cta-row {
    flex-direction: column;
    gap: 8px;
  }
  .bento-card.card-hero .phone {
    width: 160px;
    height: 320px;
  }
}
```

### Demo 카드 (2x2 → 모바일 1x2)
```css
@media (max-width: 480px) {
  .bento-card.card-demo .demo-card {
    padding: 16px;
  }
  .bento-card.card-demo .demo-upload {
    min-height: 120px;
  }
}
```

### Pricing 카드 (2x2 → 모바일)
```css
@media (max-width: 480px) {
  .bento-card.card-pricing .price-mini-grid {
    grid-template-columns: 1fr; /* 3열→1열 세로 스택 */
    gap: 10px;
  }
  .bento-card.card-pricing .price-mini-col {
    padding: 14px;
  }
}
```

### Compare 카드 (2x1 → 모바일)
```css
@media (max-width: 480px) {
  .bento-card.card-compare .compare-mini-table {
    font-size: 12px;
  }
  .bento-card.card-compare .compare-mini-table th,
  .bento-card.card-compare .compare-mini-table td {
    padding: 6px 4px;
  }
}
```

### Features 카드 (2x1 → 모바일)
```css
@media (max-width: 480px) {
  .bento-card.card-features .feat-mini-grid {
    grid-template-columns: 1fr 1fr; /* 4열→2열 */
    gap: 8px;
  }
}
@media (max-width: 360px) {
  .bento-card.card-features .feat-mini-grid {
    grid-template-columns: 1fr; /* 극소 화면→1열 */
  }
}
```

### Caption Samples 카드 (2x1)
가로 스크롤이므로 별도 대응 불필요. 카드 폭에 맞게 자동 조정.

## 5. cellHeight 반응형

모바일에서 cellHeight가 280px이면 너무 클 수 있으므로:
```js
function updateCellHeight() {
  if (!grid) return;
  if (window.innerWidth <= 480) {
    grid.cellHeight(220);
  } else if (window.innerWidth <= 768) {
    grid.cellHeight(250);
  } else {
    grid.cellHeight(280);
  }
}
window.addEventListener('resize', updateCellHeight);
document.addEventListener('DOMContentLoaded', updateCellHeight);
```

## 6. 그리드 컨테이너 반응형
```css
.grid-stack-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 16px;
}
@media (max-width: 768px) {
  .grid-stack-container {
    padding: 0 12px;
  }
}
@media (max-width: 480px) {
  .grid-stack-container {
    padding: 0 8px;
  }
}
```

---

## 확인 항목
- [ ] Desktop(≥1200px): 4열 배치 정상, 카드 위치 스펙과 일치
- [ ] Tablet(769~996px): 2열로 리플로우, 빈 공간 없음
- [ ] Mobile(≤480px): 1열 세로 스택, 모든 카드 가로 꽉 참
- [ ] 모바일에서 드래그 비활성화됨, 스크롤 정상
- [ ] Pricing 3단이 모바일에서 1열로 변환
- [ ] Hero 타이틀 폰트 사이즈 clamp 동작
- [ ] Features 4열→2열→1열 변환
- [ ] 브라우저 리사이즈 시 실시간 반영
- [ ] 회전(landscape↔portrait) 시 정상 동작
- [ ] 잠금 버튼이 모바일에서 숨겨짐
