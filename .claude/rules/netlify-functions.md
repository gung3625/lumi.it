---
globs: "netlify/functions/*.js"
---
# Netlify Functions 작업 규칙

- Blobs 사용 시 반드시 siteID + token 명시:
  ```js
  const store = getStore({
    name: 'store-name', consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
  ```
- 새 Function 만들면 netlify.toml에 /api/* 리다이렉트 확인
- 모든 handler는 try/catch + 적절한 statusCode 반환
- CORS 헤더 반드시 포함 (Access-Control-Allow-Origin: *)
- 배포 후 실제 엔드포인트 curl로 응답 확인
