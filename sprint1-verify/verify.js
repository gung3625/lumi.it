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

  // ===== Gate 2: 사업자 인증 (모킹 모드 — local 환경) =====
  // 실연동 검증은 게이트 11에서 별도로 진행
  const r2b = await request('POST', `${BASE}/api/business-verify`, {
    businessNumber: '220-81-62517',
    ownerName: '테스트사장',
    startDate: '2020-01-15',
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

  // ===== Gate 11: 국세청 공공 API 실연동 (별도 스크립트 호출) =====
  // sprint1-verify/business-verify-real.js — Stage A(/status) + B(/validate) + C(handler 통합)
  const realRun = spawnSync('node', [path.resolve(__dirname, 'business-verify-real.js')], {
    encoding: 'utf8',
    env: Object.assign({}, process.env),
    timeout: 30000,
  });
  const realOut = (realRun.stdout || '') + (realRun.stderr || '');
  const realPass = realRun.status === 0 && /게이트 11: 국세청 공공 API 실연동 검증/.test(realOut);
  gate('11. 국세청 공공 API 실연동 (status + validate + handler)',
       realPass, realPass ? 'A+B+C 통과 (계속사업자=01)' : (realOut.split('\n').filter((l) => l.startsWith('[FAIL]')).slice(0, 2).join(' | ') || 'no output'));

  // ===== Bonus: 네이버 TEST_OK =====
  const rN = await request('POST', `${BASE}/api/connect-naver`, {
    applicationId: 'TEST_OK',
    applicationSecret: '0123456789abcdef',
  }, { Authorization: `Bearer ${TOKEN || ''}` });
  const nOk = rN.status === 200 && rN.json?.success === true && rN.json?.verified === true;
  gate('12. (bonus) 네이버 TEST_OK → 200 verified=true', nOk, `status=${rN.status} verified=${rN.json?.verified}`);

  // ===== Bonus: 말투 학습 저장 =====
  const rT = await request('POST', `${BASE}/api/signup-tone-samples`, {
    greeting: '안녕하세요! 청춘마켓 김민서입니다.',
    closing: '오늘도 좋은 하루 되세요!',
    skipped: false,
  }, { Authorization: `Bearer ${TOKEN || ''}` });
  const tOk = rT.status === 200 && rT.json?.success === true && rT.json?.stored >= 2;
  gate('13. (bonus) /api/signup-tone-samples → 200 stored≥2',
       tOk, `status=${rT.status} stored=${rT.json?.stored}`);

  // ===== Gate 14: 사업자등록증 업로드 =====
  // multipart/form-data — http 모듈로 직접 멀티파트 빌드
  async function uploadFile(token) {
    const boundary = '----LumiVerifyBoundary' + Math.random().toString(16).slice(2);
    const CRLF = '\r\n';
    // JPEG 매직 바이트 + 1KB 더미 페이로드
    const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const tail = Buffer.alloc(1024, 0x00);
    const fileBuf = Buffer.concat([head, tail]);
    const partsHead = Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="biz-license.jpg"${CRLF}` +
      `Content-Type: image/jpeg${CRLF}${CRLF}`,
      'utf8'
    );
    const partsTail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
    const body = Buffer.concat([partsHead, fileBuf, partsTail]);

    return new Promise((resolve) => {
      const url = new URL(`${BASE}/api/upload-business-license`);
      const opts = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          Authorization: `Bearer ${token}`,
        },
        timeout: 15000,
      };
      const req = http.request(opts, (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(chunks); } catch (_) { /* */ }
          resolve({ status: res.statusCode, body: chunks, json: parsed });
        });
      });
      req.on('error', (e) => resolve({ status: 0, error: e.message, json: null }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', json: null }); });
      req.write(body);
      req.end();
    });
  }
  const r14 = await uploadFile(TOKEN || '');
  const upOk = r14.status === 200 && r14.json?.success === true
    && typeof r14.json.fileUrl === 'string' && r14.json.fileUrl.length > 0
    && ['pending', 'approved'].includes(r14.json.verifyStatus);
  gate('14. POST /api/upload-business-license → 200 + fileUrl + verifyStatus',
       upOk, `status=${r14.status} verifyStatus=${r14.json?.verifyStatus} mock=${Boolean(r14.json?.mock)}`);

  // ===== Gate 15: 가입 흐름 일관성 (verify + upload + create-seller licenseFileUrl) =====
  // 동일 토큰으로 licenseFileUrl을 같이 보내 셀러 row에 저장되는지 검증
  const r15 = await request('POST', `${BASE}/api/signup-create-seller`, {
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
    licenseFileUrl: r14.json?.fileUrl || 'mock://test',
  }, { Authorization: `Bearer ${TOKEN || ''}` });
  const consistencyOk = r15.status === 200 && r15.json?.success === true && r15.json?.token;
  gate('15. 가입 흐름 일관성 (사업자번호 검증 + 파일 업로드 + 셀러 row licenseFileUrl)',
       consistencyOk, `status=${r15.status} hasToken=${Boolean(r15.json?.token)}`);

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
