# Netlify Functions 규칙

- Blobs는 Function 런타임 자동 컨텍스트 사용 — **siteID/token 넘기지 말 것** (PAT 401/429 유발):
  ```js
  getStore({ name: '...', consistency: 'strong' })
  ```
- 새 Function → netlify.toml /api/* 리다이렉트 확인
- 모든 handler: try/catch + CORS 헤더 + 적절한 statusCode
- 개인정보(이름, 연락처) 로그 출력 절대 금지
- 배포 후 curl로 실제 엔드포인트 응답 확인

## 베타 관련
- beta-apply.js: 신청 저장 + 알림톡(010-6424-6284)
- beta-admin.js: LUMI_SECRET 토큰 인증 필수
- 신청자 수 하드코딩 금지 — 실시간 Blobs 조회
- 20명 마감 시 대기 명단 모드 자동 전환
