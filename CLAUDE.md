# lumi — Claude Code 핵심 지시서

## ⚡ 절대 규칙
1. 파일 수정 전 원본 반드시 읽기
2. str_replace/edit_block 최소 범위만 수정 (전체 재작성 금지)
3. 김현님 승인 없이 실제 파일 수정 금지
4. 추측·거짓말 금지 — 팩트만 보고
5. 작업 완료 후 반드시 배포
6. 코딩/파일수정 시작 전 구현 계획 먼저 보고 → 승인 후 진행
7. 작업 완료 시 변경 파일·배포 URL·다음 단계를 요약 보고

## 📖 도메인 용어
- **테스터**: 정식 출시 전 무료 사용자 (선착순 20명)
- **스탠다드**: 유일한 유료 플랜 (월 ₩49,000)
- **에이전트 팀**: Task 툴로 병렬 실행하는 4개 서브에이전트

## 🤖 에이전트 파이프라인
분석·개선·검토 요청 시 **항상 Task 툴로 4개 병렬 실행**:
- Task 1 [아이디어] Task 2 [검토] Task 3 [트렌드] Task 4 [QA]
- 취합 → 김현님 보고 → 승인 → 시범(파일수정금지) → 최종승인 → 구현+배포

## 🚀 배포
```bash
cd /Users/kimhyun/lumi.it && git add -A && git commit -m "msg" && git push origin main && npx -y netlify-cli deploy --prod --site 28d60e0e-6aa4-4b45-b117-0bcc3c4268fc
```

## 📚 상세 문서 (필요 시 참조)
- docs/stack.md — 기술스택·환경변수·자주하는실수
- docs/design.md — 디자인시스템·스킬가이드
- docs/service.md — 서비스현황·파일구조
