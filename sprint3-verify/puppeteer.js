#!/usr/bin/env node
// Sprint 3 — Puppeteer 시연 (모바일 + PC, tasks·orders·cs-inbox)
// 사용: node sprint3-verify/puppeteer.js [http://localhost:8891]

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const BASE = process.argv[2] || 'http://localhost:8891';
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'sprint3_local_test_secret_32chars_minimum_required';
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
    await page.evaluateOnNewDocument((tk) => { localStorage.setItem('lumi_seller_token', tk); }, token);

    // 1. tasks 화면 우선순위 카드
    await step(`${viewport.name}/tasks 우선순위 카드 표시`, async () => {
      await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle0', timeout: 15000 });
      await page.waitForSelector('.priority-card', { timeout: 8000 });
      const count = await page.$$eval('.priority-card', (els) => els.length);
      if (count < 3) throw new Error(`expected >= 3 cards, got ${count}`);
      const aiMsg = await page.$eval('[data-bind="ai_message"]', (el) => el.textContent);
      if (!aiMsg.includes('처리할 일')) throw new Error(`ai_message missing: "${aiMsg}"`);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint3-${viewport.name}-01-tasks.png`), fullPage: true });
    });

    // 2. orders 화면 카드/테이블
    await step(`${viewport.name}/orders ${viewport.isMobile ? '카드' : '테이블'} 표시`, async () => {
      await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle0', timeout: 15000 });
      if (viewport.isMobile) {
        await page.waitForSelector('.order-card', { timeout: 8000 });
        const cards = await page.$$eval('.order-card', (els) => els.length);
        if (cards === 0) throw new Error('no order cards');
      } else {
        await page.waitForSelector('#ordersTableBody tr[data-order-id]', { timeout: 8000 });
        const rows = await page.$$eval('#ordersTableBody tr[data-order-id]', (els) => els.length);
        if (rows === 0) throw new Error('no table rows');
      }
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint3-${viewport.name}-02-orders.png`), fullPage: true });
    });

    // 3. orders 필터 chips 클릭 → URL 갱신 X but 카드 갱신
    await step(`${viewport.name}/orders 필터 chips`, async () => {
      const chip = await page.$('.chip[data-filter="pending_shipping"]');
      if (!chip) throw new Error('chip not found');
      await chip.click();
      await new Promise((r) => setTimeout(r, 600));
      const active = await page.$eval('.chip.chip--active', (el) => el.dataset.filter);
      if (active !== 'pending_shipping') throw new Error(`active filter = ${active}`);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint3-${viewport.name}-03-filter.png`), fullPage: true });
    });

    // 4. cs-inbox 화면 카드 + AI 답변
    await step(`${viewport.name}/cs-inbox AI 답변 카드`, async () => {
      await page.goto(`${BASE}/cs-inbox`, { waitUntil: 'networkidle0', timeout: 15000 });
      if (viewport.isMobile) {
        await page.waitForSelector('.cs-card', { timeout: 8000 });
        const aiSuggestion = await page.$('.cs-card__ai-suggestion');
        if (!aiSuggestion) throw new Error('AI suggestion not visible (mobile)');
      } else {
        await page.waitForSelector('#csList li', { timeout: 8000 });
        const items = await page.$$eval('#csList li', (els) => els.length);
        if (items === 0) throw new Error('no cs list items');
      }
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint3-${viewport.name}-04-cs-inbox.png`), fullPage: true });
    });

    // 5. Kill switch 모달 (모바일 위주)
    if (viewport.isMobile) {
      await step(`${viewport.name}/kill switch 모달`, async () => {
        await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle0', timeout: 15000 });
        await page.waitForSelector('#killSwitchBtn', { timeout: 6000 });
        // DOMContentLoaded 이후 이벤트 바인딩 보장 (mini-server 환경에서는 거의 즉시지만 안전 여유)
        await new Promise((r) => setTimeout(r, 300));
        await page.evaluate(() => document.getElementById('killSwitchBtn').click());
        await page.waitForFunction(() => {
          const m = document.getElementById('killModal');
          return m && !m.hidden;
        }, { timeout: 5000 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint3-${viewport.name}-05-kill.png`), fullPage: true });
      });
    } else {
      // PC = order-detail 1건 진입 화면 (직접 URL 접근)
      await step(`${viewport.name}/order-detail 진입`, async () => {
        await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle0', timeout: 15000 });
        // 첫 주문 ID 가져오기
        const orderId = await page.$$eval('#ordersTableBody tr[data-order-id]', (els) => els[0]?.dataset.orderId || null);
        if (!orderId) throw new Error('no order rows in table');
        await page.goto(`${BASE}/order-detail?id=${encodeURIComponent(orderId)}`, { waitUntil: 'networkidle0', timeout: 10000 });
        await page.waitForSelector('#orderSummary h2', { timeout: 8000 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint3-${viewport.name}-05-detail.png`), fullPage: true });
      });
    }

    await page.close();
  }

  await browser.close();

  console.log(`\n=== Sprint 3 Puppeteer ===`);
  console.log(`결과: ${pass}/${pass + fail} PASS`);
  fs.writeFileSync('/tmp/sprint3-puppeteer-result.json', JSON.stringify({ pass, fail, results }, null, 2));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('puppeteer.js error:', e);
  process.exit(2);
});
