---
globs: "*.html"
---
# HTML 파일 작업 규칙

- 수정 전 원본 파일 반드시 읽기
- str_replace/edit_block 최소 범위만 수정 (전체 재작성 금지)
- CSS 변수 사용: --pink(#FF6B9D), --g900(#191F28), --r-xl(32px)
- 디자인: Inter/Roboto/보라 그라디언트 금지. lumi 브랜드 컬러 유지
- 모바일 퍼스트 (clamp() + auto-fit 그리드)
- 수정 후 반드시 배포 실행
