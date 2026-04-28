#!/usr/bin/env node
// Sprint 1.5 — Puppeteer 시연 (모바일 + PC 위자드 흐름)
// 사용: node sprint1.5-verify/puppeteer.js [http://localhost:8891]
// 의존: puppeteer (이미 sprint2 환경에 설치되어 있음)

const path = require('path');
const fs = require('fs');

let puppeteer;
try { puppeteer = require('puppeteer'); }
catch (e) {
  console.error('[skip] puppeteer 모듈 없음. Sprint 1·2와 동일 환경에서 실행하세요.');
  process.exit(0);
}

const BASE = process.argv[2] || 'http://localhost:8891';
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '.tmp-verify-1.5');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

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
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  for (const viewport of [
    { name: 'mobile', width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    { name: 'desktop', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  ]) {
    console.log(`\n=== ${viewport.name.toUpperCase()} ${viewport.width}x${viewport.height} ===`);

    // 격리된 incognito 컨텍스트 (이전 viewport의 localStorage·cookie 영향 없음)
    const incognito = await browser.createIncognitoBrowserContext
      ? await browser.createIncognitoBrowserContext()
      : (await browser.createBrowserContext ? await browser.createBrowserContext() : browser);
    const page = await incognito.newPage();
    await page.setViewport(viewport);
    await page.setUserAgent(viewport.isMobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15');

    // ============ Step 1: /signup 200 + STEP1 표시 ============
    await step(`${viewport.name}: /signup 200 + STEP1 표시`, async () => {
      const res = await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle0', timeout: 8000 });
      if (res.status() !== 200) throw new Error('status ' + res.status());
      // STEP1 마크업 존재 확인 (가시성 대신 존재 여부 — 토큰 잔존 시 다른 단계 표시 가능성 회피)
      await page.waitForSelector('[data-step="1"]', { timeout: 5000 });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint1.5-${viewport.name}-01-step1.png`) });
    });

    // ============ Step 2: 가입(모킹) → 토큰 발급 후 STEP2 강제 진입 ============
    await step(`${viewport.name}: 모킹 가입 → STEP2 진입`, async () => {
      // SIGNUP_MOCK=true 환경에서 signup-create-seller 호출 → JWT 받기
      const tokenJson = await page.evaluate(async (base) => {
        const res = await fetch(base + '/api/signup-create-seller', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
          }),
        });
        return res.json();
      }, BASE);
      if (!tokenJson || !tokenJson.success || !tokenJson.token) {
        throw new Error('mock 가입 실패: ' + JSON.stringify(tokenJson).slice(0, 200));
      }
      // onboarding.js의 state.token에 주입 — localStorage 사용
      await page.evaluate((tk) => { localStorage.setItem('lumi_token', tk); }, tokenJson.token);
      // 페이지 새로고침으로 토큰 복원 + STEP2로 이동 (showStep 호출은 IIFE 내부라 직접 못 침)
      await page.reload({ waitUntil: 'networkidle0' });
      // STEP2로 점프: state.token 주입 후 클릭 핸들러 무시하고 단순 표시
      await page.evaluate(() => {
        document.querySelectorAll('[data-step]').forEach((el) => {
          el.style.display = (el.getAttribute('data-step') === '2') ? 'block' : 'none';
        });
        const done = document.querySelector('[data-done]');
        if (done) done.style.display = 'none';
      });
      await page.waitForSelector('[data-step="2"]', { visible: true });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint1.5-${viewport.name}-02-step2.png`) });
    });

    // ============ Step 3: 쿠팡 카드 클릭 → 미세 위자드 표시 ============
    await step(`${viewport.name}: 쿠팡 카드 클릭 → 미세 5단계 위자드 표시`, async () => {
      await page.click('[data-market="coupang"]');
      await page.waitForSelector('[data-micro-wizard="coupang"]', { visible: true });
      // 진행 바 5단계 점이 모두 보이는지
      const stepCount = await page.$$eval('[data-micro-wizard="coupang"] [data-mp-step]', (els) => els.length);
      if (stepCount !== 5) throw new Error('진행 바 단계 수: ' + stepCount);
      // 첫 패널 표시
      const pane1Visible = await page.$eval('[data-micro-wizard="coupang"] [data-mp-pane="1"]',
        (el) => el.style.display !== 'none');
      if (!pane1Visible) throw new Error('단계 1 패널 미표시');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint1.5-${viewport.name}-03-coupang-step1.png`) });
    });

    // ============ Step 4: 미세 단계 1 → 2 (Deep Link 클릭) ============
    await step(`${viewport.name}: 단계 1 → 2 (Deep Link 새 탭, 단계 진행)`, async () => {
      // window.open을 stub해서 새 탭 안 열고 호출만 캡처
      await page.evaluate(() => {
        window._lastDeepLink = null;
        const origOpen = window.open;
        window.open = function (url) {
          window._lastDeepLink = url;
          return null;
        };
      });
      await page.click('[data-action="mp-coupang-go"]');
      // 단계 2로 이동 대기
      await page.waitForFunction(
        () => document.querySelector('[data-micro-wizard="coupang"]')?.getAttribute('data-micro-step') === '2',
        { timeout: 3000 }
      );
      const link = await page.evaluate(() => window._lastDeepLink);
      if (!link || !/wing\.coupang\.com/.test(link)) throw new Error('Deep Link URL 미호출: ' + link);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint1.5-${viewport.name}-04-coupang-step2.png`) });
    });

    // ============ Step 5: 단계 2 → 3 (입력 단계) ============
    await step(`${viewport.name}: 단계 2 → 3 (입력 단계 진입)`, async () => {
      await page.click('[data-action="mp-coupang-input"]');
      await page.waitForFunction(
        () => document.querySelector('[data-micro-wizard="coupang"]')?.getAttribute('data-micro-step') === '3',
        { timeout: 3000 }
      );
      // 입력 필드 가시성 확인
      const inputs = await page.$$eval('[data-micro-wizard="coupang"] [data-clipboard-target]', (els) => els.length);
      if (inputs !== 3) throw new Error('clipboard-target 입력칸 수: ' + inputs);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint1.5-${viewport.name}-05-coupang-step3.png`) });
    });

    // ============ Step 6: 단계 3 → 4 → 5 (검증 흐름 + 마스코트 표정 변경) ============
    await step(`${viewport.name}: 키 입력 → 검증 → 완료 (마스코트 wink)`, async () => {
      // TEST_OK 모킹 패턴으로 입력
      await page.type('[data-input="coupangVendor"]', 'TEST_OK');
      await page.type('[data-input="coupangAccess"]', '0123456789abcdef');
      await page.type('[data-input="coupangSecret"]', '0123456789abcdef');
      await page.click('[data-action="connect-coupang"]');
      // 단계 4 (검증) 거쳐 단계 5 (완료)로 도달
      await page.waitForFunction(
        () => document.querySelector('[data-micro-wizard="coupang"]')?.getAttribute('data-micro-step') === '5',
        { timeout: 6000 }
      );
      // 마스코트가 wink 이미지인지 확인
      const mascotSrc = await page.$eval('[data-micro-wizard="coupang"] [data-mp-mascot]',
        (el) => el.getAttribute('src'));
      if (!/logo-cloud/.test(mascotSrc)) throw new Error('완료 단계 마스코트가 logo-cloud 아님: ' + mascotSrc);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint1.5-${viewport.name}-06-coupang-step5.png`) });
    });

    // ============ Step 7: 네이버 카드 동일 흐름 ============
    await step(`${viewport.name}: 네이버 미세 위자드 진입 + 5단계 마크업`, async () => {
      await page.click('[data-market="naver"]');
      await page.waitForSelector('[data-micro-wizard="naver"]', { visible: true });
      const stepCount = await page.$$eval('[data-micro-wizard="naver"] [data-mp-step]', (els) => els.length);
      if (stepCount !== 5) throw new Error('네이버 진행 바 단계 수: ' + stepCount);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `sprint1.5-${viewport.name}-07-naver-step1.png`) });
    });

    await page.close();
    if (incognito && incognito !== browser && incognito.close) {
      try { await incognito.close(); } catch (_) {}
    }
  }

  await browser.close();

  console.log(`\n=== Sprint 1.5 Puppeteer: ${pass}/${pass + fail} PASS ===`);
  console.log(`스크린샷: ${SCREENSHOT_DIR}`);

  const out = '/tmp/sprint1.5-puppeteer-result.json';
  fs.writeFileSync(out, JSON.stringify({ pass, fail, results }, null, 2));
  console.log(`결과 JSON: ${out}\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('puppeteer 실행 오류:', e);
  process.exit(1);
});
