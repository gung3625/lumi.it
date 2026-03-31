# 디자인 시스템 + 스킬 가이드

## CSS 변수 (index.html 기준)
```css
--pink: #FF6B9D  --pink-soft: #FFD6E7  --pink-pale: #FFF0F6
--g900: #191F28  --g700: #333D4B  --g500: #6B7684
--g200: #E8ECF0  --g100: #F2F4F6  --r-xl: 32px  --r-full: 999px
```

## 디자인 원칙 (frontend-design 스킬)
- 코딩 전 톤 결정: 미니멀/맥시멀/레트로/럭셔리 중 하나 선택
- 차별화 포인트 1개 반드시 정의
- **금지**: Inter/Roboto/Arial, 보라 그라디언트, 뻔한 AI 레이아웃
- **필수**: CSS 변수 일관성, 스크롤 트리거 애니메이션, 비대칭 레이아웃

## UI 프로토타입 (web-artifacts-builder 스킬)
React 18 + TypeScript + Tailwind + shadcn/ui
1. `scripts/init-artifact.sh <name>` 실행
2. 컴포넌트 개발
3. `scripts/bundle-artifact.sh` 로 단일 HTML 번들링

## 파일 읽기 (file-reading 스킬)
| 확장자 | 도구 |
|--------|------|
| .json/.log | jq |
| .csv | pandas nrows |
| .txt/.md | wc -c 후 head/cat |
| binary | file 명령 먼저 |
