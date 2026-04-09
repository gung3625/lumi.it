# Bento Redesign Step 1: index.html 벤토 그리드 기본 셋업

## 작업 지시
docs/bento-redesign-spec.md를 읽고 그대로 따라서 index.html을 벤토 그리드로 변환한다.

## 이번 단계 범위
1. 기존 index.html을 index-old.html로 백업
2. 새 index.html 작성 — gridstack.js 기반 벤토 그리드
3. 14개 카드 HTML 구조만 우선 (콘텐츠는 기존 index.html에서 그대로 가져옴)
4. 기본 CSS (nevflynn.com 스펙: radius 32px, bg, hover shadow, grab cursor)
5. gridstack 초기화 + 카드 배치
6. Nav 상단 pill 탭 (All/Feature/Price/Demo/Start)

## 절대 규칙
- 기존 기능(데모 캡션, 베타 잔여석 카운트 등) JS 로직은 그대로 가져온다
- 가격은 반드시 실제 데이터: 베이직 ₩19,000 / 스탠다드 ₩29,000 / 프로 ₩39,000
- 법적 필수: Footer에 사업자 정보 전부 포함 (상호/대표/사업자번호/통신판매업/주소/이메일)
- privacy.html, terms.html, support.html 링크 반드시 포함
- 다크모드 기존 방식 유지 (body.light-mode, localStorage lumi_dark_mode)
- str_replace만 사용, 파일 전체 덮어쓰기 금지
- 작업 전 관련 파일 전부 읽고 시작

## gridstack.js 설정
```html
<link href="https://cdn.jsdelivr.net/npm/gridstack@10/dist/gridstack.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/gridstack@10/dist/gridstack-all.min.js"></script>
```

gridstack 초기화:
```js
var grid = GridStack.init({
  column: 4,
  cellHeight: 280,
  margin: 16,
  float: true,
  animate: true,
  draggable: { handle: '.gs-item-content' },
  resizable: { handles: '' } // 리사이즈 비활성화
});
```

## 카드 HTML 패턴
```html
<div class="grid-stack-item" gs-x="0" gs-y="0" gs-w="2" gs-h="2" data-card="hero" data-filter="all">
  <div class="gs-item-content bento-card">
    <!-- 기존 hero 섹션 콘텐츠 -->
  </div>
</div>
```

## 참고
- 기존 index.html: 1358줄
- nevflynn.com 분석: docs/bento-redesign-spec.md 참조
- 다른 페이지(dashboard, subscribe, beta 등)는 건드리지 않는다
