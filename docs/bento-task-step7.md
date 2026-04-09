# Bento Redesign Step 7: 기존 JS 기능 연결

## 선행 조건
- Step 1~6 완료

## 이번 단계 범위
index-old.html에 있던 모든 JS 기능을 새 벤토 그리드 index.html에 연결.
기능 하나도 빠뜨리지 않는다.

---

## 기능 목록 (index-old.html에서 추출)

### 1. 데모 캡션 생성 (Card 02-demo)
가장 중요. 비로그인 사용자가 사진 올려서 AI 캡션 체험.

이식할 요소:
- select#demo-biz (업종 선택)
- div#demo-upload (드래그 앤 드롭 + 클릭 업로드)
- input#demo-file (파일 인풋, hidden)
- div#demo-preview + img#demo-preview-img (미리보기)
- button#demo-submit (캡션 생성 버튼)
- div#demo-remaining + #demo-remain-count (무료 체험 N회 남음)
- div#demo-loading + .demo-spinner (로딩 상태)
- div#demo-result + #demo-caption-text + #demo-copy (결과)
- #demo-disclaimer-text (면책)

이식할 JS 함수:
```
- 파일 선택/드래그 이벤트 핸들러
- 파일 리사이즈 (Canvas API)
- reCAPTCHA 검증
- fetch('/.netlify/functions/demo-caption', ...) POST 호출
- 결과 표시 + 복사 기능
- localStorage 데모 횟수 제한 (lumi_demo_count)
```

이식 방법:
index-old.html의 <script> 영역에서 데모 관련 함수를 전부 찾아서 새 index.html의 <script>에 그대로 복사.
HTML 요소 ID는 동일하게 유지해서 JS 수정 없이 연결.

### 2. 베타 잔여석 카운트 (Card 12-cta)
현재 몇 자리 남았는지 실시간 표시.

이식할 요소:
- #cta-count (잔여석 숫자)
- #cta-remaining (설명 텍스트)

이식할 JS:
```js
// 기존 로직 (index-old.html에서 추출)
async function fetchBetaCount() {
  try {
    var resp = await fetch('/.netlify/functions/beta-apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'count' })
    });
    var data = await resp.json();
    var remaining = 20 - (data.count || 0);
    var el = document.getElementById('cta-count');
    if (el) el.textContent = Math.max(0, remaining);
  } catch(e) {}
}
fetchBetaCount();
```

이 동일 함수를 배너의 잔여석에도 연결:
- .hero-chip 내부 잔여석 텍스트

### 3. HOW 섹션 타이핑 애니메이션 (Card 06-how)
기존 index-old.html의 step3 타이핑은 4-step 확장 패널 안에 있었음.
벤토 그리드에서는 Card 06이 1x1이므로 간결 버전으로 축소.

신규 구현 (기존 로직 참고하되 단순화):
```js
var howTypingTexts = [
  '사진 올리기',
  'AI가 사진 분석 중...',
  '캡션 3개 완성!',
  '인스타에 자동 게시'
];
var howCurrentStep = 0;

function cycleHowSteps() {
  var el = document.getElementById('how-step-text');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(function() {
    el.textContent = howTypingTexts[howCurrentStep];
    el.style.opacity = '1';
    howCurrentStep = (howCurrentStep + 1) % howTypingTexts.length;
  }, 300);
}
setInterval(cycleHowSteps, 2500);
```

### 4. Scroll Reveal 애니메이션
기존 index-old.html의 IntersectionObserver 기반 .reveal 클래스.
벤토 그리드에서는 gridstack이 카드를 배치하므로, 초기 로드 시 카드가 순차적으로 나타나는 효과로 변경:

```js
function revealBentoCards() {
  var cards = document.querySelectorAll('.bento-card');
  cards.forEach(function(card, i) {
    card.style.opacity = '0';
    card.style.transform = 'translateY(16px)';
    setTimeout(function() {
      card.style.transition = 'opacity 0.5s, transform 0.5s';
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    }, i * 80); // 80ms 간격 순차 등장
  });
}
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(revealBentoCards, 200); // gridstack 초기화 후
});
```

### 5. FAQ 아코디언 (Card 11-faq)
기존 onclick toggle 방식 그대로:
```js
// HTML에서 각 faq-mini-item에 onclick="this.classList.toggle('open')"
// CSS:
// .faq-mini-item .faq-answer { max-height: 0; overflow: hidden; transition: max-height 0.3s; }
// .faq-mini-item.open .faq-answer { max-height: 200px; }
// .faq-mini-item .faq-icon { transition: transform 0.2s; }
// .faq-mini-item.open .faq-icon { transform: rotate(45deg); }
```

FAQ 내용 8개 (index-old.html에서 그대로):
```
1. 무료 체험 끝나면 자동 결제되나요?
2. AI가 쓴 티 안 나나요?
3. 내 사진이 다른 곳에 쓰이진 않나요?
4. 비밀번호 넘겨야 하나요?
5. 하루에 몇 개까지 올릴 수 있나요?
6. ChatGPT로 직접 쓰면 안 되나요?
7. 대행사보다 나은 점이 뭔가요?
8. 인스타 말고 다른 SNS도 되나요?
```

### 6. 트렌드 키워드 API 연동 (Card 05-trend)
Step 3에서 정의한 loadTrendKeywords() 함수를 DOMContentLoaded에서 호출:
```js
document.addEventListener('DOMContentLoaded', function() {
  loadTrendKeywords(); // Step 3에서 구현
});
```

### 7. SEO / Structured Data (HEAD)
index-old.html의 HEAD 영역 전체를 그대로 가져온다:
- title
- meta description, keywords
- OG tags (og:title, og:description, og:image, og:url)
- Twitter cards
- canonical
- favicon, apple-touch-icon
- JSON-LD: SoftwareApplication, Organization, FAQPage, BreadcrumbList
- Pretendard CDN
- Iconify CDN (defer)

변경 없이 100% 동일하게 복사.

### 8. Sticky CTA (하단 고정)
기존 index-old.html의 .sticky-cta:
```html
<div class="sticky-cta"><a href="/beta">지금 무료로 시작하기</a></div>
```

벤토 그리드에서도 유지. 모바일에서 특히 중요:
```css
.sticky-cta {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 9000;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
  background: var(--nav-bg);
  backdrop-filter: saturate(180%) blur(20px);
  text-align: center;
  display: none; /* 데스크톱에서 숨김 */
}
.sticky-cta a {
  display: block;
  background: var(--pink);
  color: #fff;
  border-radius: 980px;
  padding: 14px;
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
}
@media (max-width: 768px) {
  .sticky-cta { display: block; }
}
```

### 9. 배너 (상단)
기존 index-old.html의 배너:
```html
<div class="top-banner" id="top-banner">
  <span>선착순 20명 · 4월 마감 예정</span>
  <button onclick="this.parentElement.style.display='none'" aria-label="닫기">✕</button>
</div>
```
이 배너는 벤토 그리드 위에 위치 (nav 위 또는 nav 아래).

### 10. reCAPTCHA (데모 캡션용)
기존 index-old.html의 reCAPTCHA v3:
```html
<script src="https://www.google.com/recaptcha/api.js?render=SITE_KEY" defer></script>
```
이 스크립트와 관련 JS 로직 그대로 이식.

---

## 이식하면 안 되는 것 (삭제 대상)
- index-old.html의 기존 섹션별 HTML 구조 (section.hero, section.demo-sec 등) → 벤토 카드로 대체됨
- 기존 CSS에서 섹션 레이아웃 관련 (.hero, .demo-sec, .how-sec 등의 position/padding/max-width) → gridstack이 대체
- beforeunload 이벤트의 scrollTo(0,0) → 이미 삭제됨
- get-festival 관련 코드 → 이미 삭제된 기능

## 이식 순서
1. HEAD 전체 (meta, structured data, CDN) → 그대로 복사
2. 배너 HTML → nav 위에 배치
3. 데모 캡션 JS → script 영역에 전체 복사
4. 베타 잔여석 JS → script 영역에 복사
5. reCAPTCHA → script 태그 + 관련 로직 복사
6. FAQ 토글 → CSS + onclick 그대로
7. 다크모드 초기화 + FAB → 기존 그대로
8. Sticky CTA → body 하단에 배치
9. revealBentoCards() → 새로 추가
10. 트렌드 API 호출 → DOMContentLoaded에 추가

---

## 확인 항목
- [ ] 데모 캡션: 업종 선택 → 사진 업로드 → 생성 버튼 → API 호출 → 결과 표시 → 복사
- [ ] 데모 카운트 제한 (localStorage lumi_demo_count) 동작
- [ ] 베타 잔여석: 페이지 로드 시 숫자 표시
- [ ] FAQ: 질문 클릭 → 답변 펼침/접힘
- [ ] 트렌드 키워드: API에서 가져와서 롤링 애니메이션에 반영
- [ ] SEO: view-source로 meta/OG/JSON-LD 확인
- [ ] Sticky CTA: 모바일에서만 표시, 클릭 시 /beta 이동
- [ ] 배너: 닫기 버튼 동작
- [ ] 카드 순차 등장 애니메이션 정상
- [ ] reCAPTCHA 로드 + 데모 캡션에서 토큰 전송
- [ ] 콘솔 에러 0개
