---
globs: "netlify/functions/*.js"
---
# Netlify Functions 작업 규칙

- Blobs는 Functions 런타임 자동 컨텍스트 사용 — **siteID/token 명시 금지** (PAT rate limit 유발):
  ```js
  const store = getStore({ name: 'store-name', consistency: 'strong' });
  ```
  (외부 스크립트/CLI에서 접근할 때만 siteID+token 필요)
- 새 Function 만들면 netlify.toml에 /api/* 리다이렉트 확인
- 모든 handler는 try/catch + 적절한 statusCode 반환
- CORS 헤더 반드시 포함 (Access-Control-Allow-Origin: *)
- 배포 후 실제 엔드포인트 curl로 응답 확인
