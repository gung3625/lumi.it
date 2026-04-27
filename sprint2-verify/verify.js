#!/usr/bin/env node
// Sprint 2 — 10개 검증 게이트
// 사용: node sprint2-verify/verify.js [http://localhost:8890]

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BASE = process.argv[2] || 'http://localhost:8890';
const fetch = require('node-fetch');

// JWT 직접 발급 (mini-server와 동일 시크릿 필요)
const sellerJwt = require(path.resolve(__dirname, '..', 'netlify', 'functions', '_shared', 'seller-jwt'));

function logResult(no, name, pass, detail) {
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${no}. ${name} — ${detail}`);
}

const SUMMARY = [];

(async () => {
  // JWT 발급
  const sellerId = '00000000-0000-0000-0000-000000000001';
  const token = sellerJwt.signSellerToken({ seller_id: sellerId, business_number_masked: '220-**-***17' });

  // ============================================================
  // Gate 1: 이미지 업로드 → Storage 200
  // ============================================================
  let imageUrl = null;
  {
    const boundary = '----TEST_BOUNDARY_SPRINT2';
    const fileBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]); // JPEG magic
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from('Content-Disposition: form-data; name="file"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'));
    parts.push(fileBytes);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const res = await fetch(`${BASE}/api/upload-product-image`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });
    const j = await res.json();
    const pass = res.status === 200 && j.success && typeof j.imageUrl === 'string';
    if (pass) imageUrl = j.imageUrl;
    SUMMARY.push({ gate: 1, pass, detail: `status=${res.status} success=${j.success} imageUrl=${(j.imageUrl||'').slice(0,40)}...` });
    logResult(1, '이미지 업로드 → Storage 200', pass, SUMMARY[0].detail);
  }

  // ============================================================
  // Gate 2: AI 분석 → 표준 스키마 응답
  // ============================================================
  let lumiProduct = null;
  {
    const res = await fetch(`${BASE}/api/analyze-product-image`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: imageUrl || 'https://example.com/x.jpg' }),
    });
    const j = await res.json();
    const p = j.product;
    const pass = res.status === 200 && j.success && p && p.title && Array.isArray(p.keywords) && p.image_urls?.length > 0;
    if (pass) lumiProduct = p;
    SUMMARY.push({ gate: 2, pass, detail: `status=${res.status} title="${p?.title}" confidence=${p?.ai_confidence} model=${j.model}` });
    logResult(2, 'AI 분석 → 표준 스키마 응답 (모킹)', pass, SUMMARY[1].detail);
  }

  // ============================================================
  // Gate 3: 검수 카드 5스와이프 UI 마크업 존재
  // ============================================================
  {
    const res = await fetch(`${BASE}/register-product`);
    const html = await res.text();
    const cards = ['title', 'category', 'price', 'options', 'policy'].every((id) => html.includes(`data-card-id="${id}"`));
    const screens = html.includes('data-screen="upload"') && html.includes('data-screen="review"') && html.includes('data-screen="distribute"');
    const swipeJs = fs.existsSync(path.resolve(__dirname, '..', 'js', 'register-product.js'));
    const pass = res.status === 200 && cards && screens && swipeJs;
    SUMMARY.push({ gate: 3, pass, detail: `status=${res.status} cards5=${cards} screens3=${screens} jsFile=${swipeJs}` });
    logResult(3, '검수 카드 5스와이프 UI 작동 (마크업+JS)', pass, SUMMARY[2].detail);
  }

  // ============================================================
  // Gate 4: 쿠팡 어댑터 모킹 등록 → 직링크 응답
  // ============================================================
  let coupangResult = null;
  {
    const product = lumiProduct || mkSampleProduct();
    const res = await fetch(`${BASE}/api/register-product`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product, markets: ['coupang'] }),
    });
    const j = await res.json();
    const reg = (j.registrations || []).find((r) => r.market === 'coupang');
    coupangResult = reg;
    const pass = res.status === 200 && reg && reg.success && reg.direct_link?.includes('coupang.com/vp/products/');
    SUMMARY.push({ gate: 4, pass, detail: `status=${res.status} success=${reg?.success} link=${(reg?.direct_link||'').slice(0,55)}...` });
    logResult(4, '쿠팡 어댑터 모킹 등록 → 직링크 응답', pass, SUMMARY[3].detail);
  }

  // ============================================================
  // Gate 5: 네이버 어댑터 모킹 등록 → 직링크 응답
  // ============================================================
  {
    const product = lumiProduct || mkSampleProduct();
    const res = await fetch(`${BASE}/api/register-product`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product, markets: ['naver'] }),
    });
    const j = await res.json();
    const reg = (j.registrations || []).find((r) => r.market === 'naver');
    const pass = res.status === 200 && reg && reg.success && reg.direct_link?.includes('smartstore.naver.com');
    SUMMARY.push({ gate: 5, pass, detail: `status=${res.status} success=${reg?.success} link=${(reg?.direct_link||'').slice(0,55)}...` });
    logResult(5, '네이버 어댑터 모킹 등록 → 직링크 응답', pass, SUMMARY[4].detail);
  }

  // ============================================================
  // Gate 6: 정책 위반 검사 → 빨간 표시 (analyze-product-image 응답에 policy_warnings)
  // ============================================================
  {
    // 직접 호출 (사전 매칭)
    const policy = require(path.resolve(__dirname, '..', 'netlify', 'functions', '_shared', 'policy-words'));
    const w1 = policy.checkPolicyWords('최고급 100% 정품 의약품');
    const w2 = policy.checkPolicyWords('편안한 후드');
    const pass = w1.length >= 3 && w2.length === 0;
    SUMMARY.push({ gate: 6, pass, detail: `위반텍스트=${w1.length}개 깨끗텍스트=${w2.length}개 첫매칭="${w1[0]?.word}"` });
    logResult(6, '정책 위반 검사 → 사전 매칭', pass, SUMMARY[5].detail);
  }

  // ============================================================
  // Gate 7: Retry 큐 backoff 단계 (DB 의존 X — 순수 함수)
  // ============================================================
  {
    const retry = require(path.resolve(__dirname, '..', 'netlify', 'functions', '_shared', 'retry-engine'));
    const now = new Date('2026-04-28T00:00:00Z');
    const t0 = retry.nextRetryAt(0, now);
    const t4 = retry.nextRetryAt(4, now);
    const ok1m = (t0 - now) === 60_000;
    const ok24h = (t4 - now) === 24 * 60 * 60_000;
    const ok5steps = retry.BACKOFF_INTERVALS_MS.length === 5 && retry.MAX_RETRY_COUNT === 5;
    const pass = ok1m && ok24h && ok5steps;
    SUMMARY.push({ gate: 7, pass, detail: `1m=${ok1m} 24h=${ok24h} 5steps=${ok5steps}` });
    logResult(7, 'Retry 큐 적재 → 1m→5m→30m→2h→24h 5단계', pass, SUMMARY[6].detail);
  }

  // ============================================================
  // Gate 8: 마이그레이션 SQL 멱등성 (idempotent 키워드 + 중복 실행 안전 패턴)
  // ============================================================
  {
    const sql = fs.readFileSync(path.resolve(__dirname, '..', 'migrations', '2026-04-28-sprint-2-products.sql'), 'utf8');
    const tables = ['products', 'product_options', 'product_market_registrations', 'retry_queue', 'policy_words'];
    const allTables = tables.every((t) => new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`, 'i').test(sql));
    const idempotent = /CREATE TABLE IF NOT EXISTS/gi.test(sql) && /ON CONFLICT/i.test(sql);
    const bucket = /storage\.buckets/i.test(sql);
    const pass = allTables && idempotent && bucket;
    SUMMARY.push({ gate: 8, pass, detail: `tables=${allTables} idempotent=${idempotent} bucket=${bucket}` });
    logResult(8, '마이그레이션 SQL 멱등 실행 가능', pass, SUMMARY[7].detail);
  }

  // ============================================================
  // Gate 9: 단위 테스트 (어댑터+HMAC+정책 통합 결과)
  // ============================================================
  {
    const { execSync } = require('child_process');
    let ok = false;
    let detail = '';
    try {
      const out = execSync(
        'node ' + path.resolve(__dirname, '..', 'netlify/functions/_shared/__tests__/sprint-2-adapters.test.js'),
        { encoding: 'utf8' }
      );
      const m = out.match(/총 (\d+) 테스트 — (\d+) PASS, (\d+) FAIL/);
      ok = m && m[3] === '0';
      detail = m ? `${m[2]}/${m[1]} PASS` : 'no summary line';
    } catch (e) {
      detail = 'execSync failed: ' + e.message.slice(0, 80);
    }
    SUMMARY.push({ gate: 9, pass: ok, detail });
    logResult(9, '단위 테스트 (어댑터·schema·정책·throttle·retry)', ok, detail);
  }

  // ============================================================
  // Gate 10: register-product.html 페이지 정상 (모바일·PC 마크업)
  // ============================================================
  {
    const res = await fetch(`${BASE}/register-product`);
    const html = await res.text();
    const hasViewport = html.includes('viewport') && html.includes('width=device-width');
    const hasGradient = fs.readFileSync(path.resolve(__dirname, '..', 'css', 'register-product.css'), 'utf8').includes('--gradient-cta');
    const has768 = fs.readFileSync(path.resolve(__dirname, '..', 'css', 'register-product.css'), 'utf8').includes('@media (min-width: 768px)');
    const pass = res.status === 200 && hasViewport && hasGradient && has768;
    SUMMARY.push({ gate: 10, pass, detail: `status=${res.status} viewport=${hasViewport} gradient=${hasGradient} pcMedia=${has768}` });
    logResult(10, 'register-product.html 모바일+PC 반응형', pass, SUMMARY[9].detail);
  }

  // ============================================================
  // 최종
  // ============================================================
  const total = SUMMARY.length;
  const passed = SUMMARY.filter((s) => s.pass).length;
  console.log('\n=== Sprint 2 Verify ===');
  console.log(`결과: ${passed}/${total} PASS`);
  console.log(JSON.stringify(SUMMARY, null, 2));
  fs.writeFileSync('/tmp/sprint2-verify-result.json', JSON.stringify(SUMMARY, null, 2));
  console.log('\n결과 JSON: /tmp/sprint2-verify-result.json');
  process.exit(passed === total ? 0 : 1);

  // ============================================================
  function mkSampleProduct() {
    return {
      title: '봄 시폰 원피스 베이지',
      category_suggestions: {
        coupang: { tree: ['패션의류', '여성', '원피스'], confidence: 0.92 },
        naver: { tree: ['패션의류', '여성', '원피스'], confidence: 0.88 },
      },
      price_suggested: 39000,
      options: [
        { name: '색상', values: ['베이지', '블랙', '화이트'] },
        { name: '사이즈', values: ['S', 'M', 'L'] },
      ],
      keywords: ['봄', '시폰', '원피스', '여성', '베이지'],
      policy_warnings: [],
      image_urls: ['https://example.com/test.jpg'],
      ai_confidence: 0.91,
    };
  }
})().catch((e) => {
  console.error('verify.js error:', e);
  process.exit(2);
});
