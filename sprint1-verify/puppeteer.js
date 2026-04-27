#!/usr/bin/env node
// Sprint 1 — 클라이언트 플로우 시각 검증 (Puppeteer)
// 사용: node scripts/sprint1-puppeteer.js [base-url]
// 결과: .tmp-verify/sprint1-*.png + .tmp-verify/sprint1-puppeteer-result.json
//
// 시나리오:
// 1. /signup 접속 → Step 1 입력 → submit → Step 2
// 2. Step 2 쿠팡 폼 → TEST_OK → 녹색 체크
// 3. Step 3 → 4 → 5 → 동의 → 완료 화면
// 4. 다크/라이트 토글 작동 검증
// 5. 모바일 (375x812) + PC (1280x800) 캡처

const path = require('path');
const fs = require('fs');

const PUPPETEER_PATH = path.resolve('/Users/kimhyun/lumi.it/node_modules/puppeteer');
const puppeteer = require(PUPPETEER_PATH);

const BASE = process.argv[2] || 'http://localhost:8889';
const OUT_DIR = path.resolve(__dirname, '..', '.tmp-verify');
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function step(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail });
  const tag = pass ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
  console.log(`${tag} ${name} — ${detail || ''}`);
}

(async () => {
  console.log(`\n=== Sprint 1 Puppeteer 시각 검증 (base=${BASE}) ===\n`);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (e) {
    console.error('puppeteer launch 실패:', e.message);
    process.exit(2);
  }

  // ===== 모바일 시나리오 =====
  for (const viewport of [
    { name: 'mobile', width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    { name: 'desktop', width: 1280, height: 800, deviceScaleFactor: 1 },
  ]) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.setUserAgent('Mozilla/5.0 (Sprint1Verifier)');

    // localStorage 초기화
    await page.evaluateOnNewDocument(() => {
      try { localStorage.clear(); } catch (_) {}
    });

    // === STEP 1 진입 ===
    let nav;
    try {
      nav = await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      step(`${viewport.name} /signup 접속`, false, e.message);
      await page.close();
      continue;
    }
    step(`${viewport.name} /signup 접속`, nav && nav.ok(), `status=${nav?.status()}`);

    // 다크/라이트 토글
    const beforeDark = await page.evaluate(() => document.body.classList.contains('dark-mode'));
    await page.click('[data-theme-toggle]').catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const afterDark = await page.evaluate(() => document.body.classList.contains('dark-mode'));
    step(`${viewport.name} 다크모드 토글`, beforeDark !== afterDark, `before=${beforeDark} after=${afterDark}`);

    // 라이트 모드로 캡처 (사용자 검증 시 명확)
    if (afterDark) {
      await page.click('[data-theme-toggle]').catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
    }

    await page.screenshot({ path: path.join(OUT_DIR, `sprint1-${viewport.name}-step1.png`), fullPage: true });

    // STEP 1 입력
    await page.type('[data-input="businessNumber"]', '220-81-62517');
    await page.type('[data-input="ownerName"]', '테스트사장');
    await page.type('[data-input="birthDate"]', '1990-01-01');
    await page.type('[data-input="phone"]', '010-1234-5678');
    await page.type('[data-input="storeName"]', '테스트매장');
    await page.screenshot({ path: path.join(OUT_DIR, `sprint1-${viewport.name}-step1-filled.png`), fullPage: true });

    // submit step 1
    await Promise.all([
      page.click('[data-action="step1-submit"]'),
      page.waitForFunction(() => {
        const s2 = document.querySelector('[data-step="2"]');
        return s2 && getComputedStyle(s2).display !== 'none';
      }, { timeout: 8000 }).catch(() => null),
    ]);
    const onStep2 = await page.evaluate(() => {
      const s2 = document.querySelector('[data-step="2"]');
      return s2 && getComputedStyle(s2).display !== 'none';
    });
    step(`${viewport.name} Step 1 submit → Step 2 진입`, onStep2);
    await page.screenshot({ path: path.join(OUT_DIR, `sprint1-${viewport.name}-step2.png`), fullPage: true });

    // === STEP 2: 쿠팡 카드 클릭 → TEST_OK 입력 → 검증 ===
    if (onStep2) {
      await page.click('[data-market="coupang"]').catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      await page.type('[data-input="coupangVendor"]', 'TEST_OK');
      await page.type('[data-input="coupangAccess"]', '0123456789abcdef');
      await page.type('[data-input="coupangSecret"]', '0123456789abcdef');
      await page.click('[data-action="connect-coupang"]');
      // 검증 결과 대기 (toast 또는 connected 클래스)
      await page.waitForFunction(() => {
        const card = document.querySelector('[data-market="coupang"]');
        return card && card.classList.contains('connected');
      }, { timeout: 8000 }).catch(() => null);
      const coupangConnected = await page.evaluate(() => {
        const card = document.querySelector('[data-market="coupang"]');
        return card && card.classList.contains('connected');
      });
      step(`${viewport.name} 쿠팡 TEST_OK 연결 (녹색 체크)`, coupangConnected);
      await page.screenshot({ path: path.join(OUT_DIR, `sprint1-${viewport.name}-step2-coupang-ok.png`), fullPage: true });
    }

    // Step 2 → Step 3
    await page.click('[data-action="step2-next"]').catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    const onStep3 = await page.evaluate(() => {
      const s3 = document.querySelector('[data-step="3"]');
      return s3 && getComputedStyle(s3).display !== 'none';
    });
    step(`${viewport.name} Step 2 → Step 3`, onStep3);

    // Step 3 채우고 → Step 4
    if (onStep3) {
      await page.type('[data-input="toneGreeting"]', '안녕하세요! 청춘마켓 김민서입니다.');
      await page.type('[data-input="toneClosing"]', '오늘도 좋은 하루 되세요!');
      await page.click('[data-action="step3-next"]');
      await new Promise((r) => setTimeout(r, 500));
    }

    const onStep4 = await page.evaluate(() => {
      const s4 = document.querySelector('[data-step="4"]');
      return s4 && getComputedStyle(s4).display !== 'none';
    });
    step(`${viewport.name} Step 3 → Step 4`, onStep4);

    // Step 4 → Step 5
    if (onStep4) {
      await page.click('[data-action="step4-next"]').catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }

    const onStep5 = await page.evaluate(() => {
      const s5 = document.querySelector('[data-step="5"]');
      return s5 && getComputedStyle(s5).display !== 'none';
    });
    step(`${viewport.name} Step 4 → Step 5`, onStep5);
    await page.screenshot({ path: path.join(OUT_DIR, `sprint1-${viewport.name}-step5.png`), fullPage: true });

    // Step 5 동의 + submit
    if (onStep5) {
      await page.click('[data-consent="all"]').catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      await page.click('[data-action="step5-submit"]');
      await page.waitForFunction(() => {
        const done = document.querySelector('[data-done]');
        return done && getComputedStyle(done).display !== 'none';
      }, { timeout: 10000 }).catch(() => null);
    }

    const onDone = await page.evaluate(() => {
      const done = document.querySelector('[data-done]');
      return done && getComputedStyle(done).display !== 'none';
    });
    step(`${viewport.name} Step 5 → 완료 화면`, onDone);
    await page.screenshot({ path: path.join(OUT_DIR, `sprint1-${viewport.name}-done.png`), fullPage: true });

    await page.close();
  }

  await browser.close();

  // 결과 저장
  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.length - passCount;
  console.log(`\n=== Puppeteer 결과 ${passCount}/${results.length} PASS, ${failCount} FAIL ===`);
  fs.writeFileSync(path.join(OUT_DIR, 'sprint1-puppeteer-result.json'),
    JSON.stringify({ base: BASE, timestamp: new Date().toISOString(), pass: passCount, fail: failCount, total: results.length, results }, null, 2));
  console.log(`스크린샷·결과: ${OUT_DIR}`);
  process.exit(failCount > 0 ? 1 : 0);
})();
