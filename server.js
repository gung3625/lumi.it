'use strict';
// lumi 자체 서버 (Netlify 탈출용). Netlify Functions 핸들러를 Express 로 어댑팅해 그대로 구동.
// 정적파일 서빙 + /api/<함수명> 자동 마운트. Caddy 가 앞에서 80/443 → 이 포트로 프록시.
//   PORT(기본 8080) 에서 listen. .env 있으면 자동 로드(dotenv).
try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FUNCTIONS_DIR = path.join(ROOT, 'netlify', 'functions');
const PORT = process.env.PORT || 8080;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // Caddy 뒤 → x-forwarded-* 신뢰

// 원시 본문 캡처 (함수들이 event.body 를 직접 파싱)
app.use((req, res, next) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { req.rawBodyBuf = Buffer.concat(chunks); next(); });
  req.on('error', () => { req.rawBodyBuf = Buffer.alloc(0); next(); });
});

function buildEvent(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const buf = req.rawBodyBuf || Buffer.alloc(0);
  const isText = !buf.length || /json|text|urlencoded|xml|javascript|graphql/.test(ct);
  return {
    httpMethod: req.method,
    path: req.path,
    rawUrl: req.originalUrl,
    headers: req.headers,
    queryStringParameters: req.query || {},
    body: buf.length ? (isText ? buf.toString('utf8') : buf.toString('base64')) : null,
    isBase64Encoded: buf.length ? !isText : false,
  };
}

function adapt(handler) {
  return async (req, res) => {
    try {
      const result = await handler(buildEvent(req), { clientContext: {} });
      if (!result) return res.status(204).end();
      const headers = result.headers || {};
      for (const k of Object.keys(headers)) { try { res.setHeader(k, headers[k]); } catch (_) {} }
      res.status(result.statusCode || 200);
      if (result.isBase64Encoded && result.body) return res.end(Buffer.from(result.body, 'base64'));
      return res.send(result.body == null ? '' : result.body);
    } catch (e) {
      console.error('[api]', req.method, req.path, e && e.message);
      if (!res.headersSent) res.status(500).json({ error: '서버 오류' });
    }
  };
}

// /api/<함수명> 자동 마운트
let mounted = 0; const failed = [];
for (const f of fs.readdirSync(FUNCTIONS_DIR)) {
  if (!f.endsWith('.js')) continue;
  const name = f.slice(0, -3);
  try {
    const mod = require(path.join(FUNCTIONS_DIR, f));
    if (mod && typeof mod.handler === 'function') { app.all('/api/' + name, adapt(mod.handler)); mounted++; }
  } catch (e) { failed.push(name + ' (' + (e && e.message ? e.message.slice(0, 60) : 'err') + ')'); }
}
console.log('[server] /api 함수 마운트: ' + mounted + '개, 실패 ' + failed.length + '개');
if (failed.length) console.log('[server] 실패:', failed.slice(0, 12).join(' | '));

// 카카오 OAuth — 슬래시 2단 경로(/api/auth/kakao/*)는 위 자동 마운트(/api/<name>)가 못 잡으므로 명시적 등록.
// (원래 Netlify Edge Function 이었으나 GCP self-host 에서 미작동 → Node 로 포팅: netlify/functions/auth-kakao-*.js)
try {
  const kakaoStart = require(path.join(FUNCTIONS_DIR, 'auth-kakao-start.js'));
  const kakaoCallback = require(path.join(FUNCTIONS_DIR, 'auth-kakao-callback.js'));
  if (kakaoStart && typeof kakaoStart.handler === 'function') app.all('/api/auth/kakao/start', adapt(kakaoStart.handler));
  if (kakaoCallback && typeof kakaoCallback.handler === 'function') app.all('/api/auth/kakao/callback', adapt(kakaoCallback.handler));
  console.log('[server] 카카오 OAuth 라우트(/api/auth/kakao/*) 등록 완료');
} catch (e) { console.error('[server] 카카오 OAuth 라우트 등록 실패:', e && e.message); }

// 단축 경로 (netlify.toml 의 핵심 페이지 리다이렉트 — 필요시 추가)
app.get('/gung3625', (req, res) => res.sendFile(path.join(ROOT, 'admin', 'sourcing.html')));

// 정적 파일 + 클린 URL(.html 생략)
app.use(express.static(ROOT, { extensions: ['html'], index: 'index.html' }));
// 최종 폴백 (Express 5: app.get('*') 금지 → app.use 로 미매칭 전부 처리)
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  const p = path.join(ROOT, req.path.replace(/\/+$/, '') + '.html');
  if (p.startsWith(ROOT) && fs.existsSync(p)) return res.sendFile(p);
  const nf = path.join(ROOT, '404.html');
  if (fs.existsSync(nf)) return res.status(404).sendFile(nf);
  res.status(404).send('Not Found');
});

app.listen(PORT, () => console.log('[server] lumi 구동 :' + PORT));
