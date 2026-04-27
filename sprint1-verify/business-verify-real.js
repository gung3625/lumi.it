#!/usr/bin/env node
// Sprint 1 — 국세청 공공 API 실호출 통합 테스트 (게이트 11)
// 사용:
//   node sprint1-verify/business-verify-real.js
//   LUMI_BIZ_START_DATE=YYYYMMDD node sprint1-verify/business-verify-real.js
// 환경변수: PUBLIC_DATA_API_KEY 필수
//
// 검증 단계:
//  Stage A — /status 엔드포인트 200 + b_stt_cd 파싱 (NTS 도달성)
//  Stage B — /validate 엔드포인트 200 + valid 코드 파싱 (NTS 도달성)
//  Stage C — handler 통합 (전체 플로우 + 에러 매핑)
//  Stage D — 진위 일치 (LUMI_BIZ_START_DATE 환경변수 제공 시만)
//
// 결과: /tmp/sprint1-business-verify-real.log

const fs = require('fs');
const path = require('path');

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
process.env.BUSINESS_VERIFY_MOCK = 'false';

const LOG_FILE = '/tmp/sprint1-business-verify-real.log';

function maskBiz(num) {
  const d = String(num || '').replace(/\D/g, '');
  if (d.length !== 10) return '***';
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-***${d.slice(8)}`;
}
function maskName(n) {
  if (!n) return '***';
  if (n.length <= 1) return '*';
  return `${n[0]}${'*'.repeat(n.length - 1)}`;
}
function log(line) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  console.log(line);
}

(async function run() {
  fs.writeFileSync(LOG_FILE, '');

  const KEY = process.env.PUBLIC_DATA_API_KEY;
  if (!KEY) {
    log('[FAIL] PUBLIC_DATA_API_KEY 미설정 — Netlify env 또는 .env 추가');
    process.exit(2);
  }
  log(`[start] PUBLIC_DATA_API_KEY length=${KEY.length}`);

  const ntsPath = path.join(__dirname, '..', 'netlify', 'functions', '_shared', 'nts-business-client.js');
  const handlerPath = path.join(__dirname, '..', 'netlify', 'functions', 'business-verify.js');
  delete require.cache[ntsPath];
  delete require.cache[handlerPath];
  const { fetchBusinessStatus, validateBusinessIdentity } = require(ntsPath);
  const { handler } = require(handlerPath);

  // 김현(루미) — 메모리 project_lumi_business_info.md
  const BIZ = {
    businessNumber: '404-09-66416',
    digits: '4040966416',
    ownerName: '김현',
    storeName: '루미',
    startDateOverride: process.env.LUMI_BIZ_START_DATE || null,
  };

  const stages = [];

  // ========================================================================
  // Stage A — /status 엔드포인트 도달성
  // ========================================================================
  try {
    const sRes = await fetchBusinessStatus({ businessNumber: BIZ.digits, serviceKey: KEY });
    const ok = sRes.ok === true && sRes.httpStatus === 200 && /^[0-9]{2}$/.test(String(sRes.statusCode || ''));
    stages.push({ name: 'A. /status 엔드포인트 200 + b_stt_cd 파싱', pass: ok, detail: `httpStatus=${sRes.httpStatus} b_stt_cd=${sRes.statusCode} b_stt=${sRes.raw?.b_stt}` });
    log(`[A] /status biz=${maskBiz(BIZ.digits)} → http=${sRes.httpStatus} stt=${sRes.statusCode} (${sRes.raw?.b_stt})`);
    if (!ok) throw new Error('status_unreachable');
  } catch (e) {
    stages.push({ name: 'A. /status 엔드포인트 200 + b_stt_cd 파싱', pass: false, detail: e.message });
    log(`[A][FAIL] ${e.message}`);
  }

  // ========================================================================
  // Stage B — /validate 엔드포인트 도달성 (의도적 mismatch로 호출 가능 확인)
  // ========================================================================
  try {
    const vRes = await validateBusinessIdentity({
      businessNumber: BIZ.digits, ownerName: BIZ.ownerName, startDate: '20240101', serviceKey: KEY,
    });
    const ok = vRes.ok === true && vRes.httpStatus === 200 && (vRes.valid === '01' || vRes.valid === '02');
    stages.push({ name: 'B. /validate 엔드포인트 200 + valid 코드 파싱', pass: ok, detail: `httpStatus=${vRes.httpStatus} valid=${vRes.valid} valid_msg=${vRes.raw?.valid_msg || ''}` });
    log(`[B] /validate biz=${maskBiz(BIZ.digits)} owner=${maskName(BIZ.ownerName)} startDate=20240101 → http=${vRes.httpStatus} valid=${vRes.valid}`);
    if (!ok) throw new Error('validate_unreachable');
  } catch (e) {
    stages.push({ name: 'B. /validate 엔드포인트 200 + valid 코드 파싱', pass: false, detail: e.message });
    log(`[B][FAIL] ${e.message}`);
  }

  // ========================================================================
  // Stage C — handler 통합 (전체 플로우 + 에러 매핑)
  // 실제 진위 불일치 또는 일치 모두 통과로 간주 (handler 자체가 정상 응답하면 OK)
  // ========================================================================
  try {
    const event = {
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({
        businessNumber: BIZ.businessNumber,
        ownerName: BIZ.ownerName,
        startDate: BIZ.startDateOverride || '20240101',
        businessName: BIZ.storeName,
        phone: '010-6424-6284',
      }),
    };
    const res = await handler(event, {});
    const json = JSON.parse(res.body);
    // 200 (일치) 또는 409 (mismatch 친화 카드) 둘 다 handler 정상 동작
    const okShape = (
      (res.statusCode === 200 && json.success === true && json.method === 'nts_public') ||
      (res.statusCode === 409 && json.error?.title && json.error?.deepLink)
    );
    stages.push({ name: 'C. handler 통합 (status + validate + 에러 매핑)', pass: okShape, detail: `httpStatus=${res.statusCode} method=${json.method || 'n/a'} errorKey=${json.error?.deepLink || 'n/a'}` });
    log(`[C] handler → http=${res.statusCode} ${json.method ? 'method=' + json.method : 'errorTitle=' + (json.error?.title || 'n/a')}`);
  } catch (e) {
    stages.push({ name: 'C. handler 통합 (status + validate + 에러 매핑)', pass: false, detail: e.message });
    log(`[C][FAIL] ${e.message}`);
  }

  // ========================================================================
  // Stage D — 진위 일치 검증 (LUMI_BIZ_START_DATE 제공 시만)
  // ========================================================================
  if (BIZ.startDateOverride) {
    try {
      const vRes = await validateBusinessIdentity({
        businessNumber: BIZ.digits, ownerName: BIZ.ownerName,
        startDate: BIZ.startDateOverride, serviceKey: KEY,
      });
      const matched = vRes.ok && vRes.valid === '01';
      stages.push({ name: 'D. 진위 일치 (제공된 LUMI_BIZ_START_DATE 사용)', pass: matched, detail: `valid=${vRes.valid} valid_msg=${vRes.raw?.valid_msg || ''}` });
      log(`[D] 진위 일치 — start_dt=${BIZ.startDateOverride} → valid=${vRes.valid}`);
    } catch (e) {
      stages.push({ name: 'D. 진위 일치 (제공된 LUMI_BIZ_START_DATE 사용)', pass: false, detail: e.message });
    }
  } else {
    stages.push({ name: 'D. 진위 일치 (스킵 — LUMI_BIZ_START_DATE 미제공)', pass: null, detail: 'export LUMI_BIZ_START_DATE=YYYYMMDD 후 재실행' });
    log('[D] 스킵 — 정확한 개업일 환경변수 필요. LUMI_BIZ_START_DATE=YYYYMMDD 후 재실행하면 진위 일치 검증.');
  }

  // ========================================================================
  // 결과
  // ========================================================================
  const required = stages.filter((s) => s.pass !== null);
  const failed = required.filter((s) => !s.pass);
  log(`\n=== 결과 ===`);
  required.forEach((s) => log(`${s.pass ? '[PASS]' : '[FAIL]'} ${s.name} — ${s.detail}`));
  stages.filter((s) => s.pass === null).forEach((s) => log(`[SKIP] ${s.name} — ${s.detail}`));

  log(`\n게이트 11 = NTS API 도달성 + handler 통합 (Stage A+B+C 필수)`);
  if (failed.length === 0) {
    log(`[PASS] 게이트 11: 국세청 공공 API 실연동 검증 ${required.length}/${required.length}`);
    if (BIZ.startDateOverride && stages.find((s) => s.name.startsWith('D.'))?.pass) {
      log(`[PASS] 진위 일치까지 완전 통과 (start_dt=${BIZ.startDateOverride})`);
    }
    process.exit(0);
  }
  log(`[FAIL] ${failed.length} stage failed`);
  process.exit(1);
})();
