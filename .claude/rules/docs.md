---
globs: "docs/*.md, CLAUDE.md"
---
# 문서 관리 규칙

- CLAUDE.md는 200줄 이하 유지
- 200줄 초과 시 .claude/rules/ 또는 docs/ 로 분리
- 새 규칙 추가 시: AI가 실수한 직후 바로 한 줄 추가
- 모호한 표현 금지 ("깔끔하게" 대신 "str_replace만 사용")
- 도메인 용어는 CLAUDE.md 상단 정의 섹션에 추가
