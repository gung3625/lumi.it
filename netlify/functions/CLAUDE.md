# Netlify Functions 규칙

- Blobs 사용 시 siteID + token 반드시 명시:
  ```js
  getStore({ name:'...', consistency:'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN })
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
