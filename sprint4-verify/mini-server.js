#!/usr/bin/env node
// Sprint 4 — netlify dev 대체 미니 서버
// Sprint 3 패턴 + Sprint 4 라우트 7종 + dashboard/trends 정적
// Supabase는 in-memory mock으로 주입 (sprint4-verify/mock-supabase.js)

const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');

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

// Sprint 4 모킹 기본
process.env.SIGNUP_MOCK = process.env.SIGNUP_MOCK || 'true';
process.env.COUPANG_VERIFY_MOCK = process.env.COUPANG_VERIFY_MOCK || 'true';
process.env.NAVER_VERIFY_MOCK = process.env.NAVER_VERIFY_MOCK || 'true';
process.env.SHIPMENT_TRACK_MOCK = process.env.SHIPMENT_TRACK_MOCK || 'true';
process.env.CS_SUGGEST_MOCK = process.env.CS_SUGGEST_MOCK || 'true';
process.env.TREND_RECO_MOCK = process.env.TREND_RECO_MOCK || 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sprint4_local_test_secret_32chars_minimum_required';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'sprint4_cron_secret_min_16';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:9999';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-service-role-key';

// supabase-admin을 mock으로 가로채기 (require hook)
const mockSupabase = require(path.resolve(__dirname, 'mock-supabase'));
const SHARED_SUPABASE_PATH = path.resolve(__dirname, '..', 'netlify', 'functions', '_shared', 'supabase-admin.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const resolved = originalResolve.call(this, request, parent, ...rest);
  if (resolved === SHARED_SUPABASE_PATH) {
    return path.resolve(__dirname, 'mock-supabase.js');
  }
  return resolved;
};

const FUNCTIONS_DIR = path.resolve(__dirname, '..', 'netlify', 'functions');
const STATIC_ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || process.env.PORT || '8892', 10);

const API_ROUTES = {
  // Sprint 3 핵심 (kill-switch는 Sprint 4 대시보드도 호출)
  '/api/priority-queue': 'priority-queue',
  '/api/kill-switch': 'kill-switch',
  // Sprint 4 신규
  '/api/trend-recommendations': 'trend-recommendations',
  '/api/profit-summary': 'profit-summary',
  '/api/live-events': 'live-events',
  '/api/sync-status': 'sync-status',
  '/api/dismiss-trend': 'dismiss-trend',
  '/api/cost-settings': 'cost-settings',
  '/api/dashboard-summary': 'dashboard-summary',
};

const PAGE_ROUTES = {
  '/dashboard': '/dashboard.html',
  '/tasks': '/tasks.html',
  '/orders': '/orders.html',
  '/cs-inbox': '/cs-inbox.html',
  '/trends': '/trends.html',
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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

async function invokeHandler(funcName, req, body) {
  const filePath = path.join(FUNCTIONS_DIR, funcName + '.js');
  if (!fs.existsSync(filePath)) {
    return { statusCode: 404, headers: {}, body: JSON.stringify({ error: `function ${funcName} not found` }) };
  }
  delete require.cache[filePath];
  let mod;
  try { mod = require(filePath); } catch (e) {
    return { statusCode: 500, headers: {}, body: JSON.stringify({ error: 'load_error', detail: e.message, stack: e.stack }) };
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
    rawQuery: url.searchParams.toString(),
  };

  try {
    const out = await mod.handler(event, {});
    return out || { statusCode: 200, headers: {}, body: '' };
  } catch (e) {
    console.error(`[${funcName}] handler error:`, e);
    return { statusCode: 500, headers: {}, body: JSON.stringify({ error: 'handler_throw', detail: e.message, stack: e.stack }) };
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let p = url.pathname;
  if (PAGE_ROUTES[p]) p = PAGE_ROUTES[p];
  if (p === '/' || p === '') p = '/dashboard.html';
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

  // Reset endpoint (테스트용)
  if (pathname === '/__reset' && req.method === 'POST') {
    mockSupabase.reset();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Mock data reset' }));
    return;
  }

  // 디버그 (테스트용)
  if (pathname === '/__debug' && req.method === 'GET') {
    const tables = {};
    mockSupabase._tables.forEach((rows, name) => { tables[name] = rows.length; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tables }, null, 2));
    return;
  }

  if (API_ROUTES[pathname]) {
    const body = await readBody(req);
    const out = await invokeHandler(API_ROUTES[pathname], req, body);
    const headers = Object.assign({}, out.headers || {});
    res.writeHead(out.statusCode || 200, headers);
    res.end(out.body || '');
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Sprint 4 mini server: http://localhost:${PORT}`);
  console.log(`Mock Supabase: in-memory (reset POST /__reset)`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
