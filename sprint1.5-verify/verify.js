#!/usr/bin/env node
// Sprint 1.5 — 8개 검증 게이트
// 사용: node sprint1.5-verify/verify.js [http://localhost:8891]

const path = require('path');
const fs = require('fs');
const http = require('http');

const BASE = process.argv[2] || 'http://localhost:8891';

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
      timeout: 10000,
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

const SUMMARY = [];
function gate(no, name, pass, detail) {
  SUMMARY.push({ no, name, pass: Boolean(pass), detail });
  const tag = pass ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
  console.log(`${tag} ${no}. ${name} — ${detail || ''}`);
}

(async () => {
  console.log(`\n=== Sprint 1.5 검증 게이트 (base=${BASE}) ===\n`);

  // ===== Gate 1: market_guide_links 마이그레이션 SQL 형식 검증 =====
  // SQL 파일 멱등성 + estimated_seconds 컬럼 추가 + 시드 7개 이상
  {
    const sqlPath = path.resolve(__dirname, '..', 'migrations', '2026-04-28-sprint-1.5-guide-links.sql');
    const sql = fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf8') : '';
    const hasAlter = /ADD COLUMN IF NOT EXISTS estimated_seconds/i.test(sql);
    const hasInsert = /INSERT INTO market_guide_links/i.test(sql);
    const hasUpsert = /ON CONFLICT \(market, step_key\) DO UPDATE/i.test(sql);
    const hasIdempotent = hasAlter && hasUpsert;
    const stepKeys = Array.from(sql.matchAll(/'(api_key_issue|permission_check|app_register|oauth_authorize|scope_setup|wizard_start)'/g)).length;
    const pass = sql.length > 0 && hasAlter && hasInsert && hasUpsert && hasIdempotent && stepKeys >= 7;
    gate(1, 'market_guide_links 마이그레이션 멱등 + estimated_seconds + 시드 7+',
         pass, `alter=${hasAlter} insert=${hasInsert} upsert=${hasUpsert} stepKeys=${stepKeys}`);
  }

  // ===== Gate 2: /api/market-guides 응답 일관성 (fallback 포함) =====
  {
    const r = await request('GET', `${BASE}/api/market-guides?market=coupang`);
    const ok = r.status === 200 && r.json?.success === true && Array.isArray(r.json.guides) && r.json.guides.length > 0;
    const allCoupang = ok && r.json.guides.every((g) => g.market === 'coupang');
    const hasUrl = ok && r.json.guides.every((g) => g.external_url && g.title);
    gate(2, '/api/market-guides 응답 일관성',
         ok && allCoupang && hasUrl,
         `status=${r.status} guides=${r.json?.guides?.length} allCoupang=${allCoupang} hasUrl=${hasUrl}`);
  }

  // ===== Gate 3: Deep Link 외부 URL 형식 (HTTPS + 화이트리스트) =====
  {
    const r = await request('GET', `${BASE}/api/market-guides`);
    const guides = r.json?.guides || [];
    const allowedHosts = ['wing.coupang.com', 'apicenter.commerce.naver.com'];
    const validUrls = guides.every((g) => {
      try {
        const u = new URL(g.external_url);
        return u.protocol === 'https:' && allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
      } catch { return false; }
    });
    gate(3, 'Deep Link external_url HTTPS + 화이트리스트',
         validUrls && guides.length > 0,
         `guides=${guides.length} allHttps=${validUrls}`);
  }

  // ===== Gate 4: ClipboardDetector 컴포넌트 정적 자원 200 =====
  {
    const r = await request('GET', `${BASE}/js/components/ClipboardDetector.js`);
    const body = r.body || '';
    const hasDetector = body.includes('ClipboardDetector');
    const hasReadText = body.includes('readText');             // navigator.clipboard.readText 또는 nav.clipboard.readText 모두 매치
    const hasMask = body.includes('maskValue');
    const hasPatterns = body.includes('PATTERNS');
    const hasCreate = body.includes('createDetector') || body.includes('create:');
    const pass = r.status === 200 && hasDetector && hasReadText && hasMask && hasPatterns && hasCreate;
    gate(4, 'ClipboardDetector.js 정적 서빙 + 핵심 함수 포함',
         pass,
         `status=${r.status} detector=${hasDetector} readText=${hasReadText} mask=${hasMask} patterns=${hasPatterns} create=${hasCreate}`);
  }

  // ===== Gate 5: signup.html 미세 5단계 위자드 마크업 =====
  {
    const r = await request('GET', `${BASE}/signup`);
    const html = r.body || '';
    const hasMicroWizard = /data-micro-wizard="coupang"/.test(html) && /data-micro-wizard="naver"/.test(html);
    const has5Steps = /data-mp-step="1"/.test(html) && /data-mp-step="5"/.test(html);
    const hasPanes = ['1', '2', '3', '4', '5'].every((n) => html.includes(`data-mp-pane="${n}"`));
    const hasMascotSlot = /data-mp-mascot/.test(html);
    const hasClipPopup = /data-clipboard-popup/.test(html);
    const hasClipScript = /\/js\/components\/ClipboardDetector\.js/.test(html);
    const pass = r.status === 200 && hasMicroWizard && has5Steps && hasPanes && hasMascotSlot && hasClipPopup && hasClipScript;
    gate(5, '미세 5단계 위자드 + 마스코트 + Clipboard popup 마크업',
         pass,
         `wizard=${hasMicroWizard} 5steps=${has5Steps} panes5=${hasPanes} mascot=${hasMascotSlot} popup=${hasClipPopup} script=${hasClipScript}`);
  }

  // ===== Gate 6: CSS 미세 위자드 + 팝업 클래스 =====
  {
    const r = await request('GET', `${BASE}/css/onboarding.css`);
    const css = r.body || '';
    const hasMicroProgress = /\.micro-progress/.test(css);
    const hasMicroMascot = /\.micro-mascot/.test(css);
    const hasMicroValidate = /\.micro-validate/.test(css);
    const hasClipPopup = /\.clipboard-popup/.test(css);
    const hasClipFlash = /clipboard-filled/.test(css);
    const pass = r.status === 200 && hasMicroProgress && hasMicroMascot && hasMicroValidate && hasClipPopup && hasClipFlash;
    gate(6, 'CSS 미세 위자드 + popup + 자동입력 시각피드백',
         pass,
         `progress=${hasMicroProgress} mascot=${hasMicroMascot} validate=${hasMicroValidate} popup=${hasClipPopup} flash=${hasClipFlash}`);
  }

  // ===== Gate 7: onboarding.js 단계별 마스코트 + Smart Clipboard 통합 =====
  {
    const r = await request('GET', `${BASE}/js/onboarding.js`);
    const js = r.body || '';
    const hasMicroState = /microState/.test(js) && /setMicroStep/.test(js);
    const hasMascotMap = /MICRO_MASCOT/.test(js)
      && /lumi-curious/.test(js)
      && /lumi-character/.test(js)
      && /lumi-surprised-2/.test(js)
      && /lumi-wink/.test(js);
    const hasClipboardIntegration = /ClipboardDetector/.test(js)
      && /startClipboardDetector/.test(js)
      && /showClipboardPopup/.test(js);
    const hasProgressive = /setValidatePhase/.test(js);
    const pass = r.status === 200 && hasMicroState && hasMascotMap && hasClipboardIntegration && hasProgressive;
    gate(7, 'onboarding.js 미세 위자드 상태 머신 + 마스코트 5종 + Clipboard 통합',
         pass,
         `state=${hasMicroState} mascot5=${hasMascotMap} clipboard=${hasClipboardIntegration} validate=${hasProgressive}`);
  }

  // ===== Gate 8: 단위 테스트 (28개) 통합 실행 =====
  {
    const cp = require('child_process');
    let okCount = 0;
    let totalCount = 0;
    let failCount = 0;
    try {
      const out = cp.execSync(
        `node ${path.resolve(__dirname, '..', 'netlify', 'functions', '_shared', '__tests__', 'sprint-1.5-clipboard.test.js')}`,
        { encoding: 'utf8', cwd: path.resolve(__dirname, '..') }
      );
      const m = out.match(/(\d+)\s+PASS\s+\/\s+(\d+)\s+FAIL/);
      if (m) {
        okCount = Number(m[1]);
        failCount = Number(m[2]);
        totalCount = okCount + failCount;
      }
    } catch (e) {
      const stdout = e.stdout?.toString() || '';
      const m = stdout.match(/(\d+)\s+PASS\s+\/\s+(\d+)\s+FAIL/);
      if (m) {
        okCount = Number(m[1]);
        failCount = Number(m[2]);
        totalCount = okCount + failCount;
      }
    }
    gate(8, '단위 테스트 통합 실행 (28개)',
         totalCount >= 28 && failCount === 0,
         `${okCount}/${totalCount} PASS, fail=${failCount}`);
  }

  // ===== 결과 저장 =====
  const result = {
    base: BASE,
    timestamp: new Date().toISOString(),
    pass: SUMMARY.filter((s) => s.pass).length,
    fail: SUMMARY.filter((s) => !s.pass).length,
    gates: SUMMARY,
  };
  const out = '/tmp/sprint1.5-verify-result.json';
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\n=== Sprint 1.5: ${result.pass}/${SUMMARY.length} PASS ===`);
  console.log(`결과 JSON: ${out}\n`);

  process.exit(result.fail > 0 ? 1 : 0);
})();
