# 기술 스택 + 환경변수

## 환경변수
```
NETLIFY_TOKEN, NETLIFY_SITE_ID (28d60e0e-6aa4-4b45-b117-0bcc3c4268fc)
LUMI_SECRET (lumi2026secret)
RESEND_API_KEY
NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
MAKE_WEBHOOK_URL
PORTONE_STORE_ID, PORTONE_CHANNEL_KEY, PORTONE_API_SECRET
META_APP_SECRET, META_APP_ID (1233639725586126), META_WEBHOOK_VERIFY_TOKEN
SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_CHANNEL_ID (lumi_it)
OPENAI_API_KEY
```

## Blobs 사용 시 반드시 명시
```js
const store = getStore({
  name: 'store-name',
  consistency: 'strong',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_TOKEN,
});
```

## 자주 하는 실수
1. Blobs에 siteID/token 빠뜨리기 → 502 에러
2. netlify.toml에 /api/* 리다이렉트 없음 → 404
3. submitForm() JS만 바꾸고 실제 API 미연결 → 데이터 저장 안 됨
4. 파일 전체 재작성 → 기존 기능 날아감
5. 가상 후기에 "스탠다드 플랜 사용 중" → 베타 단계와 모순

## MCP 서버 개발 (mcp-builder)
권장 스택: TypeScript + Streamable HTTP
lumi 우선 적용: solapi_send_alimtalk, portone_payment_check, meta_instagram_post
참조: https://modelcontextprotocol.io/sitemap.xml
