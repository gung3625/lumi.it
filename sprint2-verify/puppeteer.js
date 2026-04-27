#!/usr/bin/env node
// Sprint 2 — Puppeteer 시연 (모바일 + PC 첫 등록 흐름)
// 사용: node sprint2-verify/puppeteer.js [http://localhost:8890]

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const BASE = process.argv[2] || 'http://localhost:8890';
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '.tmp-verify');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const sellerJwt = require(path.resolve(__dirname, '..', 'netlify', 'functions', '_shared', 'seller-jwt'));

let pass = 0;
let fail = 0;
const results = [];

async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    results.push({ name, status: 'PASS' });
    console.log(`[PASS] ${name}`);
  } catch (e) {
    fail += 1;
    results.push({ name, status: 'FAIL', error: e.message });
    console.error(`[FAIL] ${name}: ${e.message}`);
  }
}

(async () => {
  // 환경변수 보장 (verify와 동일 시크릿)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'sprint2_local_test_secret_32chars_minimum_required';

  const token = sellerJwt.signSellerToken({
    seller_id: '00000000-0000-0000-0000-000000000001',
    business_number_masked: '220-**-***17',
  });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  for (const viewport of [
    { name: 'mobile', width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    { name: 'desktop', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  ]) {
    console.log(`\n=== ${viewport.name.toUpperCase()} ${viewport.width}x${viewport.height} ===`);

    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.setUserAgent(viewport.isMobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15');

    // 토큰 사전 주입
    await page.evaluateOnNewDocument((tk) => {
      try { localStorage.setItem('lumi_seller_token', tk); } catch (_) {}
    }, token);

    // ============ Step 1: 페이지 로드 ============
    await step(`${viewport.name}: /register-product 200 + 화면1 표시`, async () => {
      const res = await page.goto(`${BASE}/register-product`, { waitUntil: 'networkidle0', timeout: 8000 });
      if (res.status() !== 200) throw new Error('status ' + res.status());
      await page.waitForSelector('[data-screen="upload"]', { visible: true });
      const title = await page.$eval('[data-screen="upload"] .rp-title', (el) => el.textContent.trim());
      if (!title.includes('사진 한 장')) throw new Error('타이틀 카피 누락: ' + title);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint2-${viewport.name}-01-upload.png`) });
    });

    // ============ Step 2: 사진 업로드 (input[type=file]) ============
    await step(`${viewport.name}: 사진 업로드 후 미리보기 표시`, async () => {
      const fileInput = await page.$('#photo-input');
      const fakeJpeg = path.join(SCREENSHOT_DIR, '.fake-product.jpg');
      // 1x1 px JPEG bytes
      const jpegBytes = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
        0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
        0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
        0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
        0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
        0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
        0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
        0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
        0x37, 0xff, 0xd9,
      ]);
      fs.writeFileSync(fakeJpeg, jpegBytes);
      await fileInput.uploadFile(fakeJpeg);
      await page.waitForSelector('[data-upload-preview]', { visible: true, timeout: 3000 });
      await page.waitForFunction(() => !document.querySelector('[data-action="upload-and-analyze"]').disabled, { timeout: 3000 });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint2-${viewport.name}-02-photo-selected.png`) });
    });

    // ============ Step 3: AI 분석 → 검수 화면 ============
    await step(`${viewport.name}: AI 분석 호출 → 화면2 표시`, async () => {
      await page.click('[data-action="upload-and-analyze"]');
      await page.waitForSelector('[data-screen="review"]', { visible: true, timeout: 8000 });
      const titleText = await page.$eval('[data-bind="title"]', (el) => el.textContent.trim());
      if (!titleText || titleText === '—') throw new Error('상품명 바인딩 실패: "' + titleText + '"');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint2-${viewport.name}-03-review-card1.png`) });
    });

    // ============ Step 4: 카드 5장 차례로 승인 ============
    await step(`${viewport.name}: 카드 5장 모두 승인 → 화면3 진입`, async () => {
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => {
          const visibleCards = Array.from(document.querySelectorAll('[data-rcard]'))
            .filter((c) => c.style.display !== 'none');
          if (visibleCards.length === 0) return;
          // 가장 위 카드 (z-index 큰 카드)에서 approve 클릭
          const top = visibleCards.sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0];
          const yes = top.querySelector('[data-card-action="approve"]');
          if (yes) yes.click();
        });
        await new Promise((r) => setTimeout(r, 420));
      }
      await page.waitForSelector('[data-screen="distribute"]', { visible: true, timeout: 4000 });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint2-${viewport.name}-04-distribute.png`) });
    });

    // ============ Step 5: 마켓 토글 + 전송 → 직링크 ============
    await step(`${viewport.name}: 마켓 토글 → 전송 → 직링크 카드`, async () => {
      // me API 응답이 mock 환경에서 connectedMarkets 비어있으므로 강제 활성화
      await page.evaluate(() => {
        const el = window.__rp;
        if (!el) return;
        el.state.connectedMarkets.add('coupang');
        el.state.connectedMarkets.add('naver');
        ['coupang', 'naver'].forEach((m) => {
          const row = document.querySelector(`[data-market="${m}"]`);
          const status = document.querySelector(`[data-market-status="${m}"]`);
          const toggle = document.querySelector(`[data-market-toggle="${m}"]`);
          row.classList.remove('rp-market-disabled');
          status.textContent = '연결됨 (테스트)';
          status.dataset.state = 'connected';
          toggle.disabled = false;
          toggle.checked = true;
          el.state.selectedMarkets.add(m);
        });
        document.querySelector('[data-action="distribute"]').disabled = false;
      });
      await page.click('[data-action="distribute"]');
      await page.waitForSelector('[data-results]', { visible: true, timeout: 6000 });
      const links = await page.$$eval('[data-results-list] a', (as) => as.map((a) => a.getAttribute('href')));
      if (links.length < 1) throw new Error('직링크 0개 — 모킹 응답 누락');
      if (!links.some((l) => l && l.includes('coupang.com/vp/products/'))) throw new Error('쿠팡 직링크 누락');
      if (!links.some((l) => l && l.includes('smartstore.naver.com'))) throw new Error('네이버 직링크 누락');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint2-${viewport.name}-05-results.png`) });
    });

    await page.close();
  }

  await browser.close();

  console.log(`\n=== Sprint 2 Puppeteer ===`);
  console.log(`총 ${pass + fail} 단계 — ${pass} PASS, ${fail} FAIL`);
  fs.writeFileSync('/tmp/sprint2-puppeteer-result.json', JSON.stringify(results, null, 2));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('puppeteer.js error:', e);
  process.exit(2);
});
