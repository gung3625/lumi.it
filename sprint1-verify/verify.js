#!/usr/bin/env node
// Sprint 1 — 10개 검증 게이트 자동 테스트
// 사용: node scripts/sprint1-verify.js [base-url]
// 기본 base = http://localhost:8889 (netlify dev)
// 결과: /tmp/sprint1-verify-result.json + 콘솔 출력

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || process.env.SPRINT1_BASE || 'http://localhost:8889';

function request(method, urlStr, body, headers) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + (url.search || ''),
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }, headers || {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      timeout: 15000,
    };
    const req = http.request(opts, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks); } catch (_) { /* */ }
        resolve({ status: res.statusCode, headers: res.headers, body: chunks, json: parsed });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, body: '', json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', body: '', json: null }); });
    if (data) req.write(data);
    req.end();
  });
}

const gates = [];
function gate(name, pass, detail) {
  gates.push({ name, pass: Boolean(pass), detail });
  const tag = pass ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
  console.log(`${tag} ${name} — ${detail || ''}`);
}

(async function run() {
  console.log(`\n=== Sprint 1 검증 게이트 (base=${BASE}) ===\n`);

  // ===== Gate 1: /signup 페이지 =====
  const r1 = await request('GET', `${BASE}/signup`);
  const html1 = r1.body || '';
  const hasStep1 = /STEP 1/.test(html1) && /data-step="1"/.test(html1);
  const hasStep5 = /data-step="5"/.test(html1);
  gate('1. /signup 페이지 200 + 5단계 마크업', r1.status === 200 && hasStep1 && hasStep5,
       `status=${r1.status} step1=${hasStep1} step5=${hasStep5}`);

  // ===== Gate 2: 사업자 인증 =====
  const r2 = await request('POST', `${BASE}/api/business-verify`, {
    businessNumber: '123-45-67890',
    ownerName: '테스트사장',
    birthDate: '1990-01-01',
    phone: '010-1234-5678',
  });
  // 123-45-67890 = 1234567890 → 체크섬은 0이 맞아야 정상. 다른 유효 번호로 테스트:
  // 실제 유효 사업자번호 예시: 220-81-62517 (한국전력)
  const r2b = await request('POST', `${BASE}/api/business-verify`, {
    businessNumber: '220-81-62517',
    ownerName: '테스트사장',
    birthDate: '1990-01-01',
    phone: '010-1234-5678',
  });
  const verify200 = r2b.status === 200 && r2b.json && r2b.json.success === true && r2b.json.verified === true;
  gate('2. POST /api/business-verify (220-81-62517) → 200 + verified=true',
       verify200, `status=${r2b.status} method=${r2b.json?.method}`);

  // ===== Gate 3: 셀러 가입 + JWT =====
  const r3 = await request('POST', `${BASE}/api/signup-create-seller`, {
    businessNumber: '220-81-62517',
    ownerName: '테스트사장',
    phone: '01012345678',
    birthDate: '1990-01-01',
    storeName: '테스트매장',
    email: null,
    marketingConsent: false,
    privacyConsent: true,
    termsConsent: true,
    signupStep: 1,
  });
  const created = r3.status === 200 && r3.json && r3.json.success === true && r3.json.token && r3.json.seller?.id;
  gate('3. POST /api/signup-create-seller → 200 + JWT + sellerId',
       created, `status=${r3.status} hasToken=${Boolean(r3.json?.token)} mock=${Boolean(r3.json?.mock)}`);
  const TOKEN = r3.json?.token;

  // ===== Gate 4: /api/me =====
  const r4 = await request('GET', `${BASE}/api/me`, null, { Authorization: `Bearer ${TOKEN || ''}` });
  const meOk = r4.status === 200 && r4.json && r4.json.success === true && r4.json.seller?.id;
  gate('4. GET /api/me (Bearer 토큰) → 200 + 셀러 정보',
       meOk, `status=${r4.status} hasSeller=${Boolean(r4.json?.seller)}`);

  // ===== Gate 5: 쿠팡 연결 모킹 OK =====
  const r5 = await request('POST', `${BASE}/api/connect-coupang`, {
    vendorId: 'TEST_OK',
    accessKey: '0123456789abcdef',
    secretKey: '0123456789abcdef',
  }, { Authorization: `Bearer ${TOKEN || ''}` });
  const cpOk = r5.status === 200 && r5.json?.success === true && r5.json?.verified === true;
  gate('5. POST /api/connect-coupang (TEST_OK) → 200 + verified=true',
       cpOk, `status=${r5.status} verified=${r5.json?.verified}`);

  // ===== Gate 6: 쿠팡 401 시뮬레이션 (에러 번역 카드) =====
  const r6 = await request('POST', `${BASE}/api/connect-coupang`, {
    vendorId: 'TEST_401',
    accessKey: '0123456789abcdef',
    secretKey: '0123456789abcdef',
  }, { Authorization: `Bearer ${TOKEN || ''}` });
  const errCard = r6.json?.error;
  const has401Card = r6.status === 200 && r6.json?.success === false
    && errCard && typeof errCard === 'object'
    && errCard.title && errCard.cause && errCard.action && errCard.deepLink && errCard.statusCode === 401;
  gate('6. 쿠팡 TEST_401 → 친화 에러 카드 (title/cause/action/deepLink/statusCode)',
       has401Card, `httpStatus=${r6.status} title="${errCard?.title || 'X'}" deepLink=${errCard?.deepLink || 'X'}`);

  // ===== Gate 7: 쿠팡 403 권한 부족 =====
  const r7 = await request('POST', `${BASE}/api/connect-coupang`, {
    vendorId: 'TEST_403',
    accessKey: '0123456789abcdef',
    secretKey: '0123456789abcdef',
  }, { Authorization: `Bearer ${TOKEN || ''}` });
  const err403 = r7.json?.error;
  const has403Card = r7.status === 200 && r7.json?.success === false
    && err403 && err403.statusCode === 403 && err403.deepLink === 'coupang.permission_check';
  gate('7. 쿠팡 TEST_403 → 권한 가이드 deepLink=coupang.permission_check',
       has403Card, `title="${err403?.title || 'X'}" estimatedTime=${err403?.estimatedTime || 'X'}`);

  // ===== Gate 8: HMAC 한글 단위 테스트 =====
  const { spawnSync } = require('child_process');
  const testFile = path.resolve(__dirname, '..', 'netlify', 'functions', '_shared', '__tests__', 'coupang-signature.test.js');
  const hmacRun = spawnSync('node', [testFile], { encoding: 'utf8' });
  const hmacOut = (hmacRun.stdout || '') + (hmacRun.stderr || '');
  const hmacPass = hmacRun.status === 0 && /전부 통과/.test(hmacOut);
  const passMatch = hmacOut.match(/(\d+) PASS,\s*(\d+) FAIL/);
  gate('8. HMAC 한글 단위 테스트 (13건)',
       hmacPass, passMatch ? `${passMatch[1]} PASS / ${passMatch[2]} FAIL` : 'no result');

  // ===== Gate 9: Permission Check =====
  const r9 = await request('POST', `${BASE}/api/market-permission-check`, {
    market: 'coupang',
  }, { Authorization: `Bearer ${TOKEN || ''}` });
  const permOk = r9.status === 200 && r9.json?.success === true && typeof r9.json.scopeOk === 'boolean';
  gate('9. POST /api/market-permission-check → 200 + scopeOk',
       permOk, `status=${r9.status} scopeOk=${r9.json?.scopeOk}`);

  // ===== Gate 10: Deep Link / Market Guides =====
  const r10 = await request('GET', `${BASE}/api/market-guides?market=coupang`);
  const guides = r10.json?.guides || [];
  const hasGuides = r10.status === 200 && r10.json?.success === true && guides.length >= 2
    && guides.every((g) => g.market === 'coupang' && g.external_url && g.title);
  gate('10. GET /api/market-guides?market=coupang → 200 + 가이드 ≥2건',
       hasGuides, `status=${r10.status} count=${guides.length} fallback=${Boolean(r10.json?.fallback)}`);

  // ===== Bonus: 네이버 TEST_OK =====
  const rN = await request('POST', `${BASE}/api/connect-naver`, {
    applicationId: 'TEST_OK',
    applicationSecret: '0123456789abcdef',
  }, { Authorization: `Bearer ${TOKEN || ''}` });
  const nOk = rN.status === 200 && rN.json?.success === true && rN.json?.verified === true;
  gate('11. (bonus) 네이버 TEST_OK → 200 verified=true', nOk, `status=${rN.status} verified=${rN.json?.verified}`);

  // ===== Bonus: 말투 학습 저장 =====
  const rT = await request('POST', `${BASE}/api/signup-tone-samples`, {
    greeting: '안녕하세요! 청춘마켓 김민서입니다.',
    closing: '오늘도 좋은 하루 되세요!',
    skipped: false,
  }, { Authorization: `Bearer ${TOKEN || ''}` });
  const tOk = rT.status === 200 && rT.json?.success === true && rT.json?.stored >= 2;
  gate('12. (bonus) /api/signup-tone-samples → 200 stored≥2',
       tOk, `status=${rT.status} stored=${rT.json?.stored}`);

  // ===== 결과 =====
  const passCount = gates.filter((g) => g.pass).length;
  const failCount = gates.length - passCount;
  console.log(`\n=== 결과 ${passCount}/${gates.length} PASS, ${failCount} FAIL ===`);

  const out = {
    base: BASE,
    timestamp: new Date().toISOString(),
    pass: passCount,
    fail: failCount,
    total: gates.length,
    gates,
  };
  fs.writeFileSync('/tmp/sprint1-verify-result.json', JSON.stringify(out, null, 2));
  console.log('결과 저장: /tmp/sprint1-verify-result.json');

  process.exit(failCount > 0 ? 1 : 0);
})();
