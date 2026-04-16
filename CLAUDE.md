# lumi — Claude Code 핵심 지시서

## ⚡ 절대 규칙
1. 작업 전 관련 파일을 반드시 전부 읽기
2. str_replace/edit_block 최소 범위만 수정 (전체 재작성 금지)
3. 추측·거짓말 금지 — 팩트만 보고
4. 사용자 메시지를 끝까지 전부 읽고 답변 — 대충 읽고 넘기기 금지
4. 작업 완료 시 변경 파일·배포 URL·다음 단계를 요약 보고
5. 모바일/데스크톱 양쪽 점검 후 배포 (여백, 잘림, 높이 자체 확인)

## 🤖 OMC 작업 방식
- 메인은 사용자와 **대화/보고만** — 코드 수정·분석·점검은 에이전트에 위임
- 에이전트 하나 = 작업 하나 (몰아주기 금지)
- 에이전트에게 코드 작업 위임 시 `isolation: "worktree"` 필수 사용
- autopilot/ralph 모드에서는 승인 없이 자율 진행, 완료 후 보고
- 일반 모드에서는 구현 계획 보고 → 승인 후 진행
- 스스로 판단하고 결과만 보고 (하나하나 묻지 않기)
- GStack: QA 테스트(/qa), 디자인 리뷰(/design-review), 브라우저 테스트(/browse), 보안 감사(/cso) 시 사용
- OMC: 에이전트 오케스트레이션, 자동화 워크플로우(autopilot/ralph/team) 시 사용
- 에이전트 격리: `.worktrees/` 디렉토리에 git worktree 생성 (Superpowers worktree 스킬 사용)
- `isolation: "worktree"` 내장 파라미터 사용 금지 — home-dir 레포에 워크트리를 만들어 격리 실패

## 📖 도메인 용어
- **스탠다드**: 월 ₩29,000 (무제한 캡션, 예약 게시, 말투 학습)
- **프로**: 월 ₩39,000 (캘린더, 트렌드, 최적 시간 게시, 링크인바이오)
- 베이직(₩19,000)은 **폐지됨** — 코드에 남아있어도 무시
- 비즈니스: **미구현**
- 서비스 상태: 베타, 고객 없음, Meta 심사 중, 1주일 무료체험 후 구독
- 데모/웰컴 캡션: **폐지됨**

## 🔧 기술 스택
- Vanilla JS + React 18 UMD + react-grid-layout (벤토 그리드 대시보드)
- Netlify Functions + Netlify Blobs
- OpenAI GPT-4o (이미지 분석) + GPT-5.4 (캡션 생성) via Responses API
- OpenAI Moderation API (캡션 안전성 필터링)
- 말투 자동학습 (게시=like, 재생성=dislike, 20개 롤링 윈도우)

## 📸 캡션 플로우
- 사진 업로드 1회 → 캡션 1개 생성
- 마음에 안 들면 1회당 최대 3번 재생성
- relayMode로 캡션 확인 후 게시

## 🚀 배포
```bash
cd /Users/kimhyun/lumi.it && git add -A && git commit -m "msg" && git push origin main && npx -y netlify-cli deploy --prod --site 28d60e0e-6aa4-4b45-b117-0bcc3c4268fc --dir .
```
