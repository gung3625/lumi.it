#!/usr/bin/env node
// Sprint 3 — netlify dev 대체 미니 서버
// Sprint 2 패턴 그대로 + Sprint 3 라우트 12종 + tasks/orders/cs-inbox/order-detail 정적

const fs = require('fs');
const path = require('path');
const http = require('http');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq < 0) return;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  });
}
loadEnv(path.resolve(__dirname, '..', '.env'));

// Sprint 3 모킹 기본
process.env.SIGNUP_MOCK = process.env.SIGNUP_MOCK || 'true';
process.env.AI_PRODUCT_ANALYZE_MOCK = process.env.AI_PRODUCT_ANALYZE_MOCK || 'true';
process.env.COUPANG_VERIFY_MOCK = process.env.COUPANG_VERIFY_MOCK || 'true';
process.env.NAVER_VERIFY_MOCK = process.env.NAVER_VERIFY_MOCK || 'true';
process.env.SHIPMENT_TRACK_MOCK = process.env.SHIPMENT_TRACK_MOCK || 'true';
process.env.CS_SUGGEST_MOCK = process.env.CS_SUGGEST_MOCK || 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sprint3_local_test_secret_32chars_minimum_required';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'sprint3_cron_secret_min_16';

const FUNCTIONS_DIR = path.resolve(__dirname, '..', 'netlify', 'functions');
const STATIC_ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || process.env.PORT || '8891', 10);

const API_ROUTES = {
  // Sprint 1·2 일부 재사용
  '/api/me': 'me',
  '/api/upload-product-image': 'upload-product-image',
  '/api/analyze-product-image': 'analyze-product-image',
  '/api/register-product': 'register-product',
  '/api/get-product': 'get-product',
  // Sprint 3 신규
  '/api/sync-orders': 'sync-orders',
  '/api/orders': 'orders',
  '/api/submit-tracking': 'submit-tracking',
  '/api/cs-suggest-reply': 'cs-suggest-reply',
  '/api/cs-send-reply': 'cs-send-reply',
  '/api/cs-threads': 'cs-threads',
  '/api/sync-cs-threads': 'sync-cs-threads',
  '/api/process-return': 'process-return',
  '/api/kill-switch': 'kill-switch',
  '/api/track-shipment': 'track-shipment',
  '/api/priority-queue': 'priority-queue',
  '/api/list-couriers': 'list-couriers',
};

const MULTIPART_ROUTES = new Set(['/api/upload-product-image']);

const PAGE_ROUTES = {
  '/tasks': '/tasks.html',
  '/orders': '/orders.html',
  '/order-detail': '/order-detail.html',
  '/cs-inbox': '/cs-inbox.html',
  '/register-product': '/register-product.html',
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
  delete require.cache[filePath];
  let mod;
  try { mod = require(filePath); } catch (e) {
    return { statusCode: 500, headers: {}, body: JSON.stringify({ error: 'load_error', detail: e.message }) };
  }
  if (!mod.handler) return { statusCode: 500, headers: {}, body: JSON.stringify({ error: 'handler missing' }) };

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
  if (!filePath.startsWith(STATIC_ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); res.end('not found: ' + p); return; }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Lumi-Secret',
    });
    res.end();
    return;
  }

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

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Sprint 3 mini server: http://localhost:${PORT}`);
  console.log(`MOCK: SIGNUP=${process.env.SIGNUP_MOCK} COUPANG=${process.env.COUPANG_VERIFY_MOCK} NAVER=${process.env.NAVER_VERIFY_MOCK} SHIPMENT=${process.env.SHIPMENT_TRACK_MOCK} CS=${process.env.CS_SUGGEST_MOCK}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
