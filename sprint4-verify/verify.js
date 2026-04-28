#!/usr/bin/env node
// Sprint 4 verify — 16 게이트
// 사용: JWT_SECRET=... node sprint4-verify/verify.js http://localhost:8892

const http = require('http');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://localhost:8892';

// JWT 발급 헬퍼 — _shared/seller-jwt.js 직접 사용
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sprint4_local_test_secret_32chars_minimum_required';
const { signSellerToken } = require(path.resolve(__dirname, '..', 'netlify', 'functions', '_shared', 'seller-jwt'));
const TOKEN = signSellerToken({ seller_id: 'seller-test-001', business_number_masked: '123-**-*****' });

function request(method, urlPath, body, extraHeaders) {
  return new Promise((resolve) => {
    const url = new URL(BASE + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
      ...(extraHeaders || {}),
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', e => resolve({ status: 0, body: null, raw: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

const results = [];
function gate(num, name, passed, detail) {
  results.push({ num, name, passed, detail });
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${num}. ${status} — ${name}${detail ? ` (${detail})` : ''}`);
}

(async () => {
  // 데이터 리셋
  await request('POST', '/__reset');

  // ─── 게이트 1: trend-recommendations 응답 + 카드 ≥ 1 ───
  {
    const r = await request('GET', '/api/trend-recommendations?limit=5');
    const ok = r.status === 200 && r.body?.ok && Array.isArray(r.body.cards) && r.body.cards.length >= 1;
    gate(1, '트렌드 추천 카드 ≥ 1 (시장 중심 피벗 메인)', ok, ok ? `cards=${r.body.cards.length}, top=${r.body.cards[0]?.keyword}` : `status=${r.status}`);
  }

  // ─── 게이트 2: 카드에 register_href 자동 주입 (1탭 등록) ───
  {
    const r = await request('GET', '/api/trend-recommendations?limit=3');
    const card = r.body?.cards?.[0];
    const hasHref = card && card.register_href && card.register_href.includes('/register-product?from=trend');
    gate(2, '트렌드 카드 1탭 등록 직링크 (register_href)', !!hasHref, hasHref ? `href=${card.register_href.slice(0, 60)}...` : '없음');
  }

  // ─── 게이트 3: 시즌 이벤트 보강 (어버이날) ───
  {
    const r = await request('GET', '/api/trend-recommendations?limit=10&minScore=10');
    const seasonCard = r.body?.cards?.find(c => c.season_event);
    gate(3, '시즌 이벤트 카드 자동 보강', !!seasonCard, seasonCard ? `${seasonCard.season_event}: ${seasonCard.keyword}` : '없음');
  }

  // ─── 게이트 4: profit-summary 통장 남는 돈 계산 ───
  {
    const r = await request('GET', '/api/profit-summary?period=week');
    const ok = r.status === 200 && r.body?.ok && typeof r.body.totals?.netProfit === 'number';
    gate(4, 'Profit Card 통장 남는 돈 계산', ok, ok ? `net=₩${r.body.totals.netProfit.toLocaleString('ko-KR')}, gross=₩${r.body.totals.grossRevenue.toLocaleString('ko-KR')}` : `status=${r.status}`);
  }

  // ─── 게이트 5: profit breakdown (마켓수수료/광고/포장/송장/결제/부가세) ───
  {
    const r = await request('GET', '/api/profit-summary?period=week');
    const b = r.body?.breakdown;
    const hasAll = b && ['gross_revenue', 'market_fees', 'ad_spend', 'packaging_cost', 'shipping_cost', 'payment_fees', 'vat', 'net_profit'].every(k => k in b);
    gate(5, 'Profit 분해 6요소 (수수료·광고·포장·송장·결제·부가세)', hasAll, hasAll ? Object.keys(b).join(',') : 'missing');
  }

  // ─── 게이트 6: profit 시계열 series (PC 차트) ───
  {
    const r = await request('GET', '/api/profit-summary?period=week&series=true');
    const hasSeries = r.body?.series && Array.isArray(r.body.series) && r.body.series.length >= 7;
    gate(6, 'Profit 7일+ 시계열 (PC 차트용)', hasSeries, hasSeries ? `days=${r.body.series.length}` : `series=${r.body?.series}`);
  }

  // ─── 게이트 7: cost-settings GET default ───
  {
    const r = await request('GET', '/api/cost-settings');
    const ok = r.status === 200 && r.body?.settings?.packaging_cost_per_unit === 500;
    gate(7, '비용 설정 default 응답', ok, ok ? `packaging=500, shipping=3000, payment_fee=3.30` : `status=${r.status}`);
  }

  // ─── 게이트 8: cost-settings POST upsert ───
  {
    const r = await request('POST', '/api/cost-settings', {
      packaging_cost_per_unit: 800,
      shipping_cost_per_unit: 3500,
      ad_spend_ratio: 7.5,
      payment_fee_ratio: 3.30,
    });
    const ok = r.status === 200 && r.body?.ok && r.body.settings?.packaging_cost_per_unit === 800;
    gate(8, '비용 설정 upsert + 변경 반영', ok, ok ? `packaging=800, ad=7.5%` : `status=${r.status}`);
  }

  // ─── 게이트 9: live-events GET (빈 피드도 OK) ───
  {
    const r = await request('GET', '/api/live-events?limit=10');
    const ok = r.status === 200 && r.body?.ok && Array.isArray(r.body.events);
    gate(9, '실시간 이벤트 피드 응답', ok, ok ? `events=${r.body.events.length}` : `status=${r.status}`);
  }

  // ─── 게이트 10: live-events POST publish ───
  {
    const r = await request('POST', '/api/live-events', {
      action: 'publish',
      event_type: 'new_order',
      metadata: { market: 'coupang', product_title: '봄 시폰 원피스', market_order_id: 'TEST-001' },
    });
    const ok = r.status === 200 && r.body?.ok && r.body.event?.event_type === 'new_order';
    gate(10, '실시간 이벤트 발행 (Realtime channel insert)', ok, ok ? `id=${r.body.event.id?.slice(0, 8)}, sev=${r.body.event.severity}` : `status=${r.status}`);
  }

  // ─── 게이트 11: live-events 발행 후 GET 1건 이상 ───
  {
    const r = await request('GET', '/api/live-events');
    const ok = r.status === 200 && r.body?.events?.length >= 1;
    gate(11, '발행된 이벤트 GET 조회', ok, ok ? `count=${r.body.events.length}, top=${r.body.events[0]?.title}` : `events=0`);
  }

  // ─── 게이트 12: sync-status 마켓 헬스 카드 ≥ 1 ───
  {
    const r = await request('GET', '/api/sync-status');
    const ok = r.status === 200 && r.body?.ok && Array.isArray(r.body.cards) && r.body.cards.length >= 1;
    gate(12, '마켓 동기화 헬스 카드', ok, ok ? `cards=${r.body.cards.length}, headline="${r.body.headline}"` : `status=${r.status}`);
  }

  // ─── 게이트 13: dismiss-trend 거절 학습 ───
  {
    const r = await request('POST', '/api/dismiss-trend', { keyword: '오마카세', category: 'food', reason: 'wrong_category' });
    const ok = r.status === 200 && r.body?.ok;
    gate(13, '트렌드 거절 학습 (선제 제안 6번 원칙)', ok, ok ? `count=${r.body.dismissed_count}` : `status=${r.status}`);
  }

  // ─── 게이트 14: dashboard-summary 5개 카드 통합 ───
  {
    const r = await request('GET', '/api/dashboard-summary');
    const c = r.body?.cards;
    const hasAll = c && c.trend && c.priority && c.profit && c.sync && c.live;
    gate(14, '대시보드 5카드 통합 응답 (트렌드 1번)', !!hasAll, hasAll ? `trend.cards=${c.trend.cards.length}, priority.cards=${c.priority.cards.length}, profit.amount=${c.profit?.net_profit}` : 'missing');
  }

  // ─── 게이트 15: 시장 중심 피벗 — 트렌드가 cards 객체 1번 키 ───
  {
    const r = await request('GET', '/api/dashboard-summary');
    const keys = r.body?.cards ? Object.keys(r.body.cards) : [];
    const isTrendFirst = keys[0] === 'trend';
    gate(15, '시장 중심 피벗 검증 (cards 첫 키 = trend)', isTrendFirst, `keys=${keys.join(',')}`);
  }

  // ─── 게이트 16: Kill Switch (Sprint 3 통합) 작동 ───
  {
    const r = await request('POST', '/api/kill-switch', {
      scope: 'market', market: 'coupang', action: 'stop', reason: 'verify gate 16',
    });
    const ok = r.status === 200 && r.body?.success;
    gate(16, 'Kill Switch 마켓 중지 (Sprint 3 통합 + 대시보드 호출)', ok, ok ? r.body.message : `status=${r.status} body=${JSON.stringify(r.body).slice(0, 100)}`);
  }

  // ─── 결과 ───
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${passed}/${total} GATE${passed === total ? ' — ALL PASS' : ''}`);
  console.log('═'.repeat(70));

  // JSON 결과 파일
  fs.writeFileSync('/tmp/sprint4-verify-result.json', JSON.stringify({
    base: BASE, total, passed, failed: total - passed,
    gates: results,
    at: new Date().toISOString(),
  }, null, 2));
  console.log('Result: /tmp/sprint4-verify-result.json');

  process.exit(passed === total ? 0 : 1);
})();
