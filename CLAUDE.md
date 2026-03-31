# lumi — Claude Code 핵심 지시서

## ⚡ 절대 규칙
1. 파일 수정 전 원본 반드시 읽기
2. str_replace/edit_block으로 최소 범위만 수정 (전체 재작성 금지)
3. 김현님 승인 없이 실제 파일 수정 금지
4. 추측·거짓말 금지 — 팩트만 보고
5. 작업 완료 후 반드시 배포
6. CLAUDE.md는 200줄 이하로 유지. 길어지면 @참조로 분리

## 🔍 자기 검증 규칙 (작업 완료 후 반드시 확인)
- [ ] 파일 줄 수 변경 전후 확인했나?
- [ ] API 엔드포인트 실제 응답 확인했나?
- [ ] Netlify Blobs에 siteID + token 명시했나?
- [ ] netlify.toml에 /api/* 리다이렉트 있나?
- [ ] 배포 후 실제 URL 접속 확인했나?

## 🏪 서비스 핵심 (@docs/service.md 참조)
- **lumi** (lumi.it.kr) — 소상공인 인스타 자동화, 월 ₩49,000
- 사진 1장 → 캡션·해시태그·날씨·트렌드·예약게시 자동
- 타겟: 40~50대 소상공인 (카페·뷰티·식당)
- 대표: 김현 | 010-6424-6284 | gung3625@gmail.com

## 📖 도메인 용어 정의
- **테스터**: 정식 출시 전 무료 사용자 (선착순 20명)
- **스탠다드**: 유일한 유료 플랜 (월 ₩49,000)
- **lumi 팀**: 3개 AI 역할 (분석가/작가/트렌드)
- **에이전트 팀**: Claude Code Task 툴로 병렬 실행하는 4개 서브에이전트
- **배포**: git push + netlify deploy 동시 실행

## 🤖 에이전트 파이프라인
분석·개선·검토 요청 시 **항상 Task 툴로 4개 병렬 실행**:
```
Task 1 [아이디어]: 개선 아이디어 + 근거
Task 2 [검토]: UX·전환율 문제점 분석
Task 3 [트렌드]: 최신 SaaS 디자인 방향
Task 4 [QA]: 실제 작동 확인 + 버그·개선점
```
→ 취합 후 김현님 보고 → 1차 승인 → 시범(파일수정금지) → 최종 승인 → 구현+배포

## 🛠 기술 스택 (@docs/stack.md 참조)
- Netlify Functions + Blobs | Make.com | OpenAI GPT-4o mini
- PortOne v2 | Solapi 알림톡 | Meta Instagram API
- Site ID: `28d60e0e-6aa4-4b45-b117-0bcc3c4268fc`
- GitHub: `gung3625/lumi.it`

## 🚀 배포 명령어
```bash
cd /Users/kimhyun/lumi.it && git add -A && git commit -m "msg" && git push origin main && npx -y netlify-cli deploy --prod --site 28d60e0e-6aa4-4b45-b117-0bcc3c4268fc
```

## 📋 남은 작업
- [ ] index.html + beta.html 디자인 전면 개편
- [ ] index.html How 섹션 인터랙티브 UI 교체
- [ ] 포트원 KG이니시스 가맹점 신청
- [ ] 솔라피 알림톡 4개 추가 템플릿
- [ ] 스레드 자동화 (메타 심사 후)
- [ ] 테스터 20명 모집

## 📚 상세 문서 참조
- @docs/stack.md — 기술 스택 + 환경변수 전체
- @docs/design.md — 디자인 시스템 + 스킬 가이드
- @docs/service.md — 서비스 현황 + 파일 구조
