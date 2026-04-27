#!/usr/bin/env node
// Sprint 1 — netlify dev 대체 미니 서버
// Function handler를 직접 require + http 서버로 라우팅. netlify dev 포트 충돌 회피용.
// 사용: node scripts/sprint1-mini-server.js [port]
// 환경변수는 .env 자동 로드 (간단 파서, dotenv 없이)

const fs = require('fs');
const path = require('path');
const http = require('http');

// .env 자동 로드
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const txt = fs.readFileSync(file, 'utf8');
  txt.split('\n').forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq < 0) return;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  });
}
loadEnv(path.resolve(__dirname, '..', '.env'));

const FUNCTIONS_DIR = path.resolve(__dirname, '..', 'netlify', 'functions');
const STATIC_ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || process.env.PORT || '8889', 10);

// /api/* → netlify.toml 명시 라우트 매핑 (force=true)
const API_ROUTES = {
  '/api/business-verify': 'business-verify',
  '/api/signup-create-seller': 'signup-create-seller',
  '/api/signup-tone-samples': 'signup-tone-samples',
  '/api/upload-business-license': 'upload-business-license',
  '/api/me': 'me',
  '/api/connect-coupang': 'connect-coupang',
  '/api/connect-naver': 'connect-naver',
  '/api/market-permission-check': 'market-permission-check',
  '/api/market-guides': 'market-guides',
};

// multipart/form-data를 받아야 하는 엔드포인트 (Buffer 보존)
const MULTIPART_ROUTES = new Set(['/api/upload-business-license']);

// pretty URL 라우트
const PAGE_ROUTES = {
  '/signup': '/signup.html',
  '/onboarding': '/signup.html',
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function readBody(req, asBuffer) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      resolve(asBuffer ? buf : buf.toString('utf8'));
    });
    req.on('error', () => resolve(asBuffer ? Buffer.alloc(0) : ''));
  });
}

async function invokeHandler(funcName, req, body, isBase64Encoded) {
  const filePath = path.join(FUNCTIONS_DIR, funcName + '.js');
  if (!fs.existsSync(filePath)) {
    return { statusCode: 404, headers: {}, body: JSON.stringify({ error: `function ${funcName} not found` }) };
  }
  // 매번 require cache 비워서 코드 변경 즉시 반영
  delete require.cache[filePath];

  let mod;
  try {
    mod = require(filePath);
  } catch (e) {
    return { statusCode: 500, headers: {}, body: JSON.stringify({ error: 'load_error', detail: e.message }) };
  }
  if (!mod.handler || typeof mod.handler !== 'function') {
    return { statusCode: 500, headers: {}, body: JSON.stringify({ error: 'handler missing' }) };
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const queryStringParameters = {};
  url.searchParams.forEach((v, k) => { queryStringParameters[k] = v; });

  const event = {
    httpMethod: req.method,
    headers: Object.assign({}, req.headers),
    queryStringParameters,
    path: url.pathname,
    body: body || null,
    rawUrl: req.url,
    isBase64Encoded: Boolean(isBase64Encoded),
  };

  try {
    const out = await mod.handler(event, {});
    return out || { statusCode: 200, headers: {}, body: '' };
  } catch (e) {
    console.error(`[${funcName}] handler error:`, e);
    return { statusCode: 500, headers: {}, body: JSON.stringify({ error: 'handler_throw', detail: e.message }) };
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let p = url.pathname;
  if (PAGE_ROUTES[p]) p = PAGE_ROUTES[p];
  if (p === '/' || p === '') p = '/index.html';
  const filePath = path.join(STATIC_ROOT, p);
  if (!filePath.startsWith(STATIC_ROOT)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end('not found: ' + p); return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // /api/* 핸들러 호출
  if (API_ROUTES[pathname]) {
    const isMultipart = MULTIPART_ROUTES.has(pathname);
    let body;
    let isBase64 = false;
    if (isMultipart) {
      const buf = await readBody(req, true);
      body = buf.toString('base64');
      isBase64 = true;
    } else {
      body = await readBody(req, false);
    }
    const out = await invokeHandler(API_ROUTES[pathname], req, body, isBase64);
    const headers = Object.assign({}, out.headers || {});
    res.writeHead(out.statusCode || 200, headers);
    res.end(out.body || '');
    return;
  }

  // 정적 + pretty URL
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Sprint 1 mini server: http://localhost:${PORT}`);
  console.log(`SIGNUP_MOCK=${process.env.SIGNUP_MOCK} BUSINESS_VERIFY_MOCK=${process.env.BUSINESS_VERIFY_MOCK} COUPANG_VERIFY_MOCK=${process.env.COUPANG_VERIFY_MOCK} NAVER_VERIFY_MOCK=${process.env.NAVER_VERIFY_MOCK}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
