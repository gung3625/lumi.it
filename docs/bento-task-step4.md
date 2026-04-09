# Bento Redesign Step 4: Nav 필터 탭 + gridstack reflow

## 선행 조건
- Step 1~3 완료

## 이번 단계 범위
상단 Nav에 pill 형태 필터 탭을 만들고, 탭 클릭 시 해당 카드만 표시 + 나머지 숨김 + 자동 reflow.

---

## 1. Nav HTML 구조

기존 nav(sticky 48px, 3-column grid)를 유지하되, 가운데 영역에 pill 필터 탭 추가:

```html
<nav>
  <!-- 왼쪽: 로고 -->
  <a href="/" class="nav-logo-wrap">
    <img src="/assets/logo.png" class="nav-logo" alt="lumi">
    <span class="nav-logo-txt">lumi</span>
  </a>

  <!-- 가운데: 필터 탭 -->
  <div class="nav-filter-wrap">
    <button class="nav-filter-pill active" data-filter="all" onclick="filterBento('all', this)">All</button>
    <button class="nav-filter-pill" data-filter="feature" onclick="filterBento('feature', this)">기능</button>
    <button class="nav-filter-pill" data-filter="price" onclick="filterBento('price', this)">요금</button>
    <button class="nav-filter-pill" data-filter="demo" onclick="filterBento('demo', this)">체험</button>
    <button class="nav-filter-pill" data-filter="start" onclick="filterBento('start', this)">시작하기</button>
  </div>

  <!-- 오른쪽: 로그인/대시보드 -->
  <div class="nav-right">
    <a href="/dashboard" class="nav-link" id="nav-auth-link">로그인</a>
  </div>
</nav>
```

## 2. 카드 data-filter 매핑

각 카드에 data-filter 속성으로 어떤 탭에 속하는지 표시:
```
01-hero:           data-filter="all"          (All에서만 표시)
02-demo:           data-filter="all demo"     (All + 체험)
03-metrics:        data-filter="all feature"  (All + 기능)
04-before-after:   data-filter="all feature"
05-trend:          data-filter="all feature"
06-how:            data-filter="all feature"
07-features:       data-filter="all feature"
08-proof:          data-filter="all feature"
09-compare:        data-filter="all feature"
10-pricing:        data-filter="all price"    (All + 요금)
11-faq:            data-filter="all"
12-cta:            data-filter="all start"    (All + 시작하기)
13-caption-samples: data-filter="all feature"
14-footer:         data-filter="all"          (항상 표시)
```

## 3. Nav CSS

```css
.nav-filter-wrap {
  display: flex;
  gap: 2px;
  background: rgba(255,255,255,.08);
  padding: 3px;
  border-radius: 50px;
}
body.light-mode .nav-filter-wrap {
  background: rgba(0,0,0,.05);
}

.nav-filter-pill {
  border-radius: 50px;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 16px;
  transition: opacity 0.3s, background 0.2s;
  color: var(--text-80);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  background: none;
  border: none;
  font-family: inherit;
  white-space: nowrap;
}
body.light-mode .nav-filter-pill {
  color: rgba(0,0,0,.6);
}

@media (hover: hover) {
  .nav-filter-pill:hover {
    opacity: 0.5;
    transition: opacity 0.25s;
  }
}

.nav-filter-pill.active {
  background: rgba(255,255,255,.15);
  color: #fff;
}
body.light-mode .nav-filter-pill.active {
  background: rgba(0,0,0,.08);
  color: #1d1d1f;
}

.nav-right {
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
.nav-link {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-80);
  text-decoration: none;
  transition: opacity .2s;
}
.nav-link:hover { opacity: .6; }
body.light-mode .nav-link { color: rgba(0,0,0,.7); }
```

## 4. 필터 JS 로직

```js
function filterBento(category, btnEl) {
  // 1. 필터 탭 active 상태 전환
  document.querySelectorAll('.nav-filter-pill').forEach(function(p) {
    p.classList.remove('active');
  });
  if (btnEl) btnEl.classList.add('active');

  // 2. 카드 표시/숨김
  document.querySelectorAll('.grid-stack-item').forEach(function(item) {
    var filters = (item.dataset.filter || '').split(' ');
    var show = category === 'all' || filters.indexOf(category) !== -1;

    if (show) {
      item.style.display = '';
      item.classList.remove('grid-stack-item-hidden');
    } else {
      item.style.display = 'none';
      item.classList.add('grid-stack-item-hidden');
    }
  });

  // 3. gridstack 레이아웃 재계산 (reflow)
  // compact()로 숨겨진 카드의 빈 공간을 메움
  if (typeof grid !== 'undefined') {
    grid.compact();
    // 필터 변경 후 0.1초 뒤 다시 한번 compact (렌더링 타이밍 보정)
    setTimeout(function() { grid.compact(); }, 100);
  }
}
```

## 5. 로그인 상태 Nav 분기

기존 루미 로직 유지 — localStorage에서 lumi_user 확인:
```js
function updateNavAuth() {
  var link = document.getElementById('nav-auth-link');
  if (!link) return;
  try {
    var raw = localStorage.getItem('lumi_user');
    if (raw) {
      var user = JSON.parse(raw);
      if (user && user.email) {
        link.textContent = '대시보드';
        link.href = '/dashboard';
        return;
      }
    }
  } catch(e) {}
  link.textContent = '로그인';
  link.href = '/dashboard';
}
// 페이지 로드 시 실행
document.addEventListener('DOMContentLoaded', updateNavAuth);
```

## 6. 모바일 Nav 대응

480px 이하에서 필터 탭을 가로 스크롤 가능하게:
```css
@media (max-width: 768px) {
  nav {
    grid-template-columns: auto 1fr auto;
    padding: 0 16px;
    gap: 8px;
  }
  .nav-filter-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    flex-shrink: 1;
    min-width: 0;
  }
  .nav-filter-wrap::-webkit-scrollbar { display: none; }
  .nav-filter-pill {
    font-size: 12px;
    padding: 0 12px;
    height: 28px;
  }
}

@media (max-width: 480px) {
  .nav-logo-txt { display: none; } /* 로고 텍스트 숨김, 아이콘만 */
  .nav-filter-pill { padding: 0 10px; font-size: 11px; }
}
```

## 7. Toggle Lockdown 버튼

nevflynn.com의 "Toggle Lockdown" 기능 — 드래그 on/off 전환:
```html
<button class="lockdown-btn" id="lockdown-btn" onclick="toggleLockdown()">
  <span id="lockdown-icon">🔓</span>
</button>
```

```css
.lockdown-btn {
  position: fixed;
  right: 16px;
  bottom: 80px; /* 다크모드 FAB 위에 */
  z-index: 9998;
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
.lockdown-btn:hover { transform: scale(1.08); }
body.light-mode .lockdown-btn {
  background: #fff;
  color: #191F28;
  box-shadow: 0 4px 16px rgba(0,0,0,.1);
}
```

```js
var isLocked = false;
function toggleLockdown() {
  isLocked = !isLocked;
  if (typeof grid !== 'undefined') {
    if (isLocked) {
      grid.disable();  // 드래그 비활성화
    } else {
      grid.enable();   // 드래그 활성화
    }
  }
  document.getElementById('lockdown-icon').textContent = isLocked ? '🔒' : '🔓';
}
```

---

## 확인 항목
- [ ] Nav pill 탭 5개 정상 렌더링
- [ ] 탭 클릭 시 해당 카드만 표시, 나머지 숨김
- [ ] 필터 후 gridstack compact → 빈 공간 없이 재배치
- [ ] All 탭 클릭 시 전체 카드 원래 위치로 복원
- [ ] active 탭 시각적 구분 (다크/라이트 양쪽)
- [ ] 모바일에서 필터 탭 가로 스크롤
- [ ] 로그인/비로그인 Nav 분기 정상
- [ ] Toggle Lockdown 버튼 동작 (드래그 on/off)
- [ ] Footer 카드(14)는 모든 필터에서 항상 표시
