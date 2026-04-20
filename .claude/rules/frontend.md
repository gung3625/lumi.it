---
globs: "*.html"
---
# HTML 파일 작업 규칙

## 수정 원칙
- 수정 전 원본 파일 반드시 읽기
- str_replace/edit_block 최소 범위만 수정 (전체 재작성 금지)
- 수정 후 반드시 배포 실행

## 디자인 시스템 (Apple-style, 확정)
- 브랜드 컬러: `--pink: #C8507A`
- 폰트: Pretendard (시스템 폰트 fallback)
- 아이콘: Lucide Icons (이모지 금지)
- Body: 17px / 400 / 1.47 / letter-spacing −0.374px
- Nav: sticky 48px, 3-column grid, rgba(0,0,0,.88) backdrop-blur
- 카드: dark `#272729` / light `#fff`, border 없음, radius 8px
- 버튼: border-radius 980px
- 섹션 교대: light `#fff ↔ #f5f5f7` / dark `#000 ↔ #111`

## 다크/라이트모드 규칙
- index.html: `body.light-mode` 클래스 (기본=다크)
- 나머지 페이지: `body.dark-mode` 클래스 (기본=라이트)
- 토글: localStorage `lumi_dark_mode` (1=dark, 0=light), FAB 버튼 우하단
- 다크 카드: `#272729`, 다크 교대 섹션: `#000 ↔ #111`

## 금지 사항
- Inter / Roboto / Arial 사용 금지
- 보라 그라디언트 금지
- 뻔한 AI 레이아웃 금지
- 모바일 퍼스트 (clamp() + auto-fit 그리드)

## 커밋 전 필수 QA (하나라도 빠지면 커밋 금지)
- 라이트모드 + 다크모드 양쪽에서 텍스트·버튼 색상 대비 확인
- nav 버튼(로그인/회원가입/로그아웃/대시보드) 존재 + 보임 + 클릭 동작 확인
- 수정한 페이지뿐 아니라 index.html과 주요 서브페이지(guide/settings/subscribe/support/privacy/terms/ig-guide) 크로스체크
- 기존 기능(폼, 링크, JS 이벤트) 깨지지 않았는지 확인
- 모바일(768px 이하) 레이아웃 깨짐 확인
