# Bento Redesign Step 3: 애니메이션 12개 적용

## 선행 조건
- Step 1 완료 (gridstack + 14개 카드 HTML)
- Step 2 완료 (CSS 스타일링)

## 이번 단계 범위
nevflynn.com에서 추출한 애니메이션 8개 + 루미 커스텀 애니메이션 4개 = 총 12개 적용

---

## Part A: nevflynn.com 애니메이션 (8개)

### A1. 카드 드래그 & 재배열
gridstack.js가 자체 처리. 추가 설정:
```js
var grid = GridStack.init({
  animate: true,           // 위치 이동 애니메이션
  float: true,             // 자유 배치
  draggable: {
    handle: '.bento-card'  // 카드 전체가 드래그 핸들
  }
});
```
```css
/* gridstack 기본 전환 (이미 내장이지만 명시) */
.grid-stack-item {
  transition: transform 0.5s, left 0.2s, top 0.2s;
  will-change: transform;
}
/* 드래그 중에는 전환 제거 */
.grid-stack-item.ui-draggable-dragging {
  transition: none;
  z-index: 100;
}
```

### A2. 카드 호버 섀도
Step 2에서 이미 적용. 확인만:
```css
.grid-stack-item-content { transition: 0.25s; }
.grid-stack-item-content:hover {
  box-shadow: rgba(100,100,111,0.1) 0 5px 24px;
}
```

### A3. 그랩 커서
Step 2에서 이미 적용:
```css
.grid-stack-item-content:hover { cursor: grab; }
.grid-stack-item-content:active { cursor: grabbing; }
```

### A4. 필터 탭 리플로우
Step 4에서 상세 구현. 여기서는 gridstack API만:
```js
function filterCards(category) {
  document.querySelectorAll('.grid-stack-item').forEach(item => {
    var filter = item.dataset.filter || '';
    var show = category === 'all' || filter.includes(category);
    grid.update(item, { hidden: !show }); // gridstack 내장 숨김/표시
  });
}
```

### A5. Nav 필 호버
```css
.nav-filter-pill {
  border-radius: 50px;
  display: flex;
  align-items: center;
  height: 32px;
  padding: 0 16px;
  transition: opacity 0.3s;
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  background: none;
  border: none;
  font-family: inherit;
}
@media (hover: hover) {
  .nav-filter-pill:hover {
    opacity: 0.5;
    transition: opacity 0.25s;
  }
}
.nav-filter-pill.active {
  background: rgba(255,255,255,.12);
}
body.light-mode .nav-filter-pill.active {
  background: rgba(0,0,0,.06);
}
```

### A6. 버튼 호버 링
Step 2의 .btn-bento에서 이미 적용:
```css
.btn-bento {
  box-shadow: rgba(240,242,248,1) 0 0 0 2px;
  transition: 0.2s ease-out;
  will-change: box-shadow, transform;
}
.btn-bento:hover {
  box-shadow: rgba(240,242,248,1) 0 0 0 5px;
}
```

### A7. 그리드 높이 전환
```css
.grid-stack {
  transition: height 0.2s;
}
```

### A8. 카드 내부 콘텐츠 전환
```css
.bento-card {
  transition: all 0.25s;
  border-radius: 32px;
  overflow: hidden;
}
```

---

## Part B: 루미 커스텀 애니메이션 (4개)

### B1. 타이핑 효과 (Card 02-demo: AI 캡션 생성 결과)
캡션이 글자 하나씩 타이핑되는 효과. 기존 index-old.html의 step3 타이핑 로직 활용:

```css
@keyframes blink-cursor {
  0%, 100% { border-right-color: var(--pink); }
  50% { border-right-color: transparent; }
}
.typing-text {
  border-right: 2px solid var(--pink);
  padding-right: 4px;
  animation: blink-cursor 0.7s step-end infinite;
  white-space: pre-wrap;
}
.typing-text.done {
  border-right-color: transparent;
  animation: none;
}
```

```js
function typeCaption(element, text, speed) {
  speed = speed || 30;
  var i = 0;
  element.textContent = '';
  element.classList.remove('done');
  var timer = setInterval(function() {
    if (i < text.length) {
      element.textContent += text.charAt(i);
      i++;
    } else {
      clearInterval(timer);
      element.classList.add('done');
    }
  }, speed);
  return timer;
}
```

### B2. 트렌드 키워드 롤링 (Card 05-trend)
세로 방향으로 키워드가 위로 올라가며 바뀌는 애니메이션:

```html
<div class="trend-roller">
  <div class="trend-roller-inner">
    <div class="trend-keyword">#봄카페추천</div>
    <div class="trend-keyword">#성수맛집</div>
    <div class="trend-keyword">#벚꽃명소</div>
    <div class="trend-keyword">#브런치카페</div>
    <div class="trend-keyword">#네일아트</div>
    <div class="trend-keyword">#오늘의빵</div>
    <div class="trend-keyword">#봄카페추천</div><!-- 첫 번째 복제 (무한루프) -->
  </div>
</div>
```

```css
.trend-roller {
  overflow: hidden;
  height: 36px; /* 키워드 1줄 높이 */
  position: relative;
}
.trend-roller-inner {
  animation: rollUp 12s linear infinite;
}
.trend-keyword {
  height: 36px;
  line-height: 36px;
  font-size: 17px;
  font-weight: 600;
  color: var(--pink);
  white-space: nowrap;
}
@keyframes rollUp {
  0% { transform: translateY(0); }
  14.28% { transform: translateY(0); }        /* 첫 번째 키워드 유지 */
  16.66% { transform: translateY(-36px); }    /* 두 번째로 이동 */
  30.95% { transform: translateY(-36px); }    /* 유지 */
  33.33% { transform: translateY(-72px); }    /* 세 번째로 이동 */
  47.61% { transform: translateY(-72px); }
  50.00% { transform: translateY(-108px); }
  64.28% { transform: translateY(-108px); }
  66.66% { transform: translateY(-144px); }
  80.95% { transform: translateY(-144px); }
  83.33% { transform: translateY(-180px); }
  97.61% { transform: translateY(-180px); }
  100%   { transform: translateY(-216px); }   /* 복제본 → 0 위치로 점프 */
}
```

```js
// 트렌드 API에서 실제 키워드 가져와서 교체
async function loadTrendKeywords() {
  try {
    var resp = await fetch('/.netlify/functions/get-trends?scope=domestic');
    var data = await resp.json();
    if (data.trends && data.trends.length > 0) {
      var keywords = data.trends.slice(0, 6).map(function(t) { return t.keyword || t.title; });
      var inner = document.querySelector('.trend-roller-inner');
      if (inner) {
        inner.innerHTML = keywords.map(function(k) {
          return '<div class="trend-keyword">#' + k + '</div>';
        }).join('') + '<div class="trend-keyword">#' + keywords[0] + '</div>';
      }
    }
  } catch(e) { /* 실패 시 기본 키워드 유지 */ }
}
```

### B3. 체크마크 캐스케이드 (Card 09-compare: ChatGPT vs lumi)
비교표의 lumi 열 체크마크가 순차적으로 나타나는 효과:

```css
.check-cascade {
  transform: scale(0);
  opacity: 0;
  transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s;
}
.check-cascade.visible {
  transform: scale(1);
  opacity: 1;
}
```

```js
function triggerCheckCascade() {
  var checks = document.querySelectorAll('.check-cascade');
  checks.forEach(function(el, i) {
    setTimeout(function() {
      el.classList.add('visible');
    }, i * 150); // 150ms 간격으로 순차 등장
  });
}

// IntersectionObserver로 카드가 뷰포트에 들어올 때 트리거
var compareCard = document.querySelector('[data-card="compare"]');
if (compareCard) {
  var compareObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        triggerCheckCascade();
        compareObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });
  compareObserver.observe(compareCard);
}
```

### B4. 캡션 샘플 가로 스크롤 (Card 13-caption-samples)
실제 AI 생성 캡션 예시가 가로로 무한 스크롤. 호버 시 멈춤:

```html
<div class="caption-scroll-wrap">
  <div class="caption-scroll-track">
    <!-- 캡션 카드들 -->
    <div class="caption-sample-card">
      <div class="caption-sample-biz">☕ 성수동 카페</div>
      <p class="caption-sample-text">딸기 라떼 올리려고 사진 찍다가 크림 흘림 (3번째) 근데 이 비주얼 미쳤다</p>
      <div class="caption-sample-tags">#성수카페 #딸기라떼 #카페추천</div>
    </div>
    <div class="caption-sample-card">
      <div class="caption-sample-biz">💅 마포 네일샵</div>
      <p class="caption-sample-text">이 디자인 하려고 3시간 걸렸는데 고객님이 "와 이거 스티커예요?" 하셔서 뿌듯했다</p>
      <div class="caption-sample-tags">#네일아트 #마포네일 #봄네일</div>
    </div>
    <div class="caption-sample-card">
      <div class="caption-sample-biz">🌸 연남동 꽃집</div>
      <p class="caption-sample-text">비 오는 날 꽃다발이 더 예쁜 이유, 물방울이 꽃잎 위에서 보석처럼 빛나거든요</p>
      <div class="caption-sample-tags">#연남꽃집 #비오는날 #꽃다발</div>
    </div>
    <div class="caption-sample-card">
      <div class="caption-sample-biz">✂️ 용산 헤어샵</div>
      <p class="caption-sample-text">요즘 남자분들 레이어드컷 많이 하시는데 이 분은 진짜 찰떡이었어요</p>
      <div class="caption-sample-tags">#용산헤어 #남자머리 #레이어드컷</div>
    </div>
    <!-- 무한루프를 위해 위 4개 복제 -->
  </div>
</div>
```

```css
.caption-scroll-wrap {
  overflow: hidden;
  width: 100%;
  mask-image: linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%);
  -webkit-mask-image: linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%);
}
.caption-scroll-track {
  display: flex;
  gap: 12px;
  animation: scrollCaptions 30s linear infinite;
  width: max-content;
}
.caption-scroll-wrap:hover .caption-scroll-track {
  animation-play-state: paused;
}
.caption-sample-card {
  flex-shrink: 0;
  width: 260px;
  background: rgba(255,255,255,.06);
  border-radius: 16px;
  padding: 16px 18px;
}
body.light-mode .caption-sample-card {
  background: rgba(0,0,0,.03);
}
.caption-sample-biz {
  font-size: 12px;
  font-weight: 600;
  color: var(--pink);
  margin-bottom: 8px;
}
.caption-sample-text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-80);
  margin-bottom: 8px;
}
.caption-sample-tags {
  font-size: 11px;
  color: var(--text-48);
}

@keyframes scrollCaptions {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); } /* 복제본이 있으므로 -50%에서 리셋 */
}
```

```js
// 캡션 무한루프를 위해 트랙 내용 복제
function initCaptionScroll() {
  var track = document.querySelector('.caption-scroll-track');
  if (!track) return;
  var items = track.innerHTML;
  track.innerHTML = items + items; // 원본 + 복제본
}
```

---

## Part C: Spotify-style "playing" 바 (nevflynn.com에서 추출, 선택 적용)
nevflynn.com의 Spotify 카드에 있던 재생 바 애니메이션.
루미의 "AI가 분석 중" 상태에 활용 가능:

```css
@keyframes playing {
  0% { height: 3px; }
  50% { height: 12px; }
  100% { height: 3px; }
}
.analyzing-bars {
  display: flex;
  gap: 2px;
  align-items: flex-end;
  height: 14px;
}
.analyzing-bars span {
  width: 3px;
  background: var(--pink);
  border-radius: 1px;
  animation: playing 0.8s ease-in-out infinite;
}
.analyzing-bars span:nth-child(2) { animation-delay: 0.15s; }
.analyzing-bars span:nth-child(3) { animation-delay: 0.3s; }
.analyzing-bars span:nth-child(4) { animation-delay: 0.45s; }
```

---

## 확인 항목
- [ ] 카드 드래그 시 부드러운 전환 (0.5s)
- [ ] 드래그 중 그림자 + z-index 상승
- [ ] 호버 시 섀도 + 그랩 커서
- [ ] 타이핑 효과: 커서 깜빡임 + 글자 순차 표시
- [ ] 트렌드 롤링: 매끄러운 세로 스크롤 + API 연동
- [ ] 체크마크 캐스케이드: 뷰포트 진입 시 순차 등장
- [ ] 캡션 스크롤: 가로 무한 + 호버 시 멈춤 + 양쪽 페이드
- [ ] 모든 애니메이션이 다크/라이트 양쪽에서 정상 동작
- [ ] prefers-reduced-motion 대응 (접근성):
```css
@media (prefers-reduced-motion: reduce) {
  .trend-roller-inner,
  .caption-scroll-track,
  .analyzing-bars span { animation: none; }
  .check-cascade { transition: none; opacity: 1; transform: scale(1); }
}
```
