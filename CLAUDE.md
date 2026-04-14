# lumi — Claude Code 핵심 지시서

## ⚡ 절대 규칙
1. **모든 작업 시작 전 관련 파일을 반드시 전부 읽어라.** 일부만 읽고 충분하다고 판단하여 작업 시작하지 마라. 수정할 파일, 참조할 파일, 관련 파일 전부 읽은 뒤에 작업을 시작한다.
2. str_replace/edit_block 최소 범위만 수정 (전체 재작성 금지)
3. 김현님 승인 없이 실제 파일 수정 금지
4. 추측·거짓말 금지 — 팩트만 보고. 확인 안 된 것을 "가능하다/될 수도 있다"고 말하지 않는다.
5. 작업 완료 후 반드시 배포
6. 코딩/파일수정 시작 전 구현 계획 먼저 보고 → 승인 후 진행
7. 작업 완료 시 변경 파일·배포 URL·다음 단계를 요약 보고

## 📖 도메인 용어
- **테스터**: 정식 출시 전 무료 사용자 (선착순 20명)
- **베이직**: 월 ₩19,000 (캡션 주 3개, 해시태그, 바로 게시)
- **스탠다드**: 월 ₩29,000 (무제한 캡션, 예약 게시, 말투 학습)
- **프로**: 월 ₩39,000 (캘린더, 트렌드, 최적 시간 게시)

## 🏗️ 아키텍처
- **Layer 1 — Rules** (.claude/rules/): 항상 자동 적용. 파일 열면 강제 로드
- **Layer 2 — Skills** (.claude/skills/): 도메인 지식. 에이전트·커맨드가 참조
- **Layer 3 — Agents** (.claude/agents/): 전문 서브에이전트. 역할·도구 제한
- **Layer 4 — Hooks** (.claude/hooks/): 이벤트 트리거 자동화

## 🚀 배포
```bash
cd /Users/kimhyun/lumi.it && git add -A && git commit -m "msg" && git push origin main && npx -y netlify-cli deploy --prod --site 28d60e0e-6aa4-4b45-b117-0bcc3c4268fc
```

## 📚 상세 문서
- DESIGN.md — AI용 디자인 시스템 (벤토 그리드, 잘림 방지 CSS 규칙)
- docs/stack.md — 기술스택·환경변수·자주하는실수
- docs/design.md — 디자인시스템·스킬가이드
- docs/service.md — 서비스현황·파일구조
