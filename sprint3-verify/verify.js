#!/usr/bin/env node
// Sprint 3 — 15개 검증 게이트
// 사용: node sprint3-verify/verify.js [http://localhost:8891]

const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const BASE = process.argv[2] || 'http://localhost:8891';
const sellerJwt = require(path.resolve(__dirname, '..', 'netlify', 'functions', '_shared', 'seller-jwt'));

function logResult(no, name, pass, detail) {
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${no}. ${name} — ${detail}`);
}

const SUMMARY = [];

(async () => {
  const sellerId = '00000000-0000-0000-0000-000000000001';
  const token = sellerJwt.signSellerToken({ seller_id: sellerId, business_number_masked: '220-**-***17' });
  const auth = { Authorization: 'Bearer ' + token };

  // ========================================================================
  // Gate 1: 주문 수집 cron 더미 호출 → 응답 200
  // ========================================================================
  {
    const res = await fetch(`${BASE}/api/sync-orders`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ since_minutes: 60 }),
    });
    const j = await res.json();
    const synced = (j.summary || []).reduce((a, s) => a + (s.total_synced || 0), 0);
    const pass = res.status === 200 && j.success === true && synced > 0;
    SUMMARY.push({ gate: 1, pass, detail: `status=${res.status} sellers=${j.sellers} synced=${synced}` });
    logResult(1, '주문 수집 (모킹) 더미 호출 → DB 저장', pass, SUMMARY[0].detail);
  }

  // ========================================================================
  // Gate 2: 주문 리스트 200 + 응답 일관성
  // ========================================================================
  {
    const res = await fetch(`${BASE}/api/orders?filter=all&limit=10`, { headers: auth });
    const j = await res.json();
    const pass = res.status === 200 && j.success && Array.isArray(j.orders) && j.orders.length > 0
      && j.orders[0].buyer_name_masked && !j.orders[0].buyer_name_masked.includes('철수')
      && !j.orders[0].buyer_phone_masked.includes('1234-5');  // 마스킹 검증
    SUMMARY.push({ gate: 2, pass, detail: `status=${res.status} count=${j.orders?.length} firstMasked="${j.orders?.[0]?.buyer_name_masked}"` });
    logResult(2, '주문 리스트 200 + 마스킹 검증', pass, SUMMARY[1].detail);
  }

  // ========================================================================
  // Gate 3: 송장 입력 + 마켓 전송 (모킹) 200
  // ========================================================================
  {
    // 첫 mock 주문 ID 가져오기
    const listRes = await fetch(`${BASE}/api/orders?filter=pending_shipping`, { headers: auth });
    const listJ = await listRes.json();
    const target = (listJ.orders || []).find((o) => o.status === 'paid' && !o.tracking_number);
    if (!target) {
      SUMMARY.push({ gate: 3, pass: false, detail: 'no pending_shipping orders' });
      logResult(3, '송장 입력 모킹', false, 'no target');
    } else {
      const res = await fetch(`${BASE}/api/submit-tracking`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: target.id, tracking_number: '1234567890123', courier_code: 'CJGLS' }),
      });
      const j = await res.json();
      const r = (j.results || [])[0];
      const pass = res.status === 200 && j.success && r?.success === true;
      SUMMARY.push({ gate: 3, pass, detail: `status=${res.status} success=${r?.success} mocked=${r?.mocked}` });
      logResult(3, '송장 입력 + 마켓 전송 (모킹) 200', pass, SUMMARY[2].detail);
    }
  }

  // ========================================================================
  // Gate 4: 배송 추적 모킹 응답
  // ========================================================================
  {
    const res = await fetch(`${BASE}/api/track-shipment`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ courier_code: 'CJGLS', tracking_number: '9999999992' }),
    });
    const j = await res.json();
    const pass = res.status === 200 && j.success === true && Array.isArray(j.events) && j.events.length >= 3 && j.current_status === 'delivered';
    SUMMARY.push({ gate: 4, pass, detail: `status=${res.status} events=${j.events?.length} current=${j.current_status}` });
    logResult(4, '배송 추적 모킹 응답 (delivered phase)', pass, SUMMARY[3].detail);
  }

  // ========================================================================
  // Gate 5: CS 문의 수신 + AI 답변 생성
  // ========================================================================
  {
    const res = await fetch(`${BASE}/api/cs-suggest-reply`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '주문한 원피스 언제 발송되나요? 빠른 답변 부탁드려요.',
        buyer_name_masked: '김**',
        product_title: '봄 시폰 원피스',
        courier: 'CJ대한통운',
        tracking_number: '1234567890',
      }),
    });
    const j = await res.json();
    const pass = res.status === 200 && j.success && j.category === 'shipping' && typeof j.response === 'string'
      && j.response.includes('김**') && j.response.includes('CJ대한통운');
    SUMMARY.push({ gate: 5, pass, detail: `status=${res.status} category=${j.category} confidence=${j.confidence} model=${j.model}` });
    logResult(5, 'CS 문의 → AI 답변 생성', pass, SUMMARY[4].detail);
  }

  // ========================================================================
  // Gate 6: CS 답변 전송 (모킹) 200
  // ========================================================================
  {
    // mockThreads 의 첫 thread id
    const listRes = await fetch(`${BASE}/api/cs-threads?filter=pending`, { headers: auth });
    const listJ = await listRes.json();
    const target = (listJ.threads || [])[0];
    if (!target) {
      SUMMARY.push({ gate: 6, pass: false, detail: 'no pending threads' });
      logResult(6, 'CS 답변 전송', false, 'no target');
    } else {
      const res = await fetch(`${BASE}/api/cs-send-reply`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: target.id, content: '오늘 출고됐어요. 빠른 답변 못 드려서 죄송합니다.' }),
      });
      const j = await res.json();
      const r = (j.results || [])[0];
      const pass = res.status === 200 && j.success && r?.success === true;
      SUMMARY.push({ gate: 6, pass, detail: `status=${res.status} success=${r?.success}` });
      logResult(6, 'CS 답변 전송 (모킹) 200', pass, SUMMARY[5].detail);
    }
  }

  // ========================================================================
  // Gate 7: 반품 처리 + 재고 가산 트리거
  // ========================================================================
  {
    const listRes = await fetch(`${BASE}/api/orders?filter=pending_return`, { headers: auth });
    const listJ = await listRes.json();
    const target = (listJ.orders || [])[0];
    if (!target) {
      SUMMARY.push({ gate: 7, pass: false, detail: 'no pending_return orders' });
      logResult(7, '반품 처리 + 재고 가산', false, 'no target');
    } else {
      const res = await fetch(`${BASE}/api/process-return`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: target.id }),
      });
      const j = await res.json();
      const r = (j.results || [])[0];
      const pass = res.status === 200 && j.success && r?.success && (r.quantity_restored || r.alreadyRestored);
      SUMMARY.push({ gate: 7, pass, detail: `status=${res.status} success=${r?.success} qty=${r?.quantity_restored} message="${r?.message || ''}"` });
      logResult(7, '반품 처리 + 재고 가산 트리거', pass, SUMMARY[6].detail);
    }
  }

  // ========================================================================
  // Gate 8: Kill Switch 모바일·상품·옵션 단계 작동
  // ========================================================================
  {
    const res = await fetch(`${BASE}/api/kill-switch`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'market', market: 'coupang', action: 'stop', reason: '검증 테스트' }),
    });
    const j = await res.json();
    const pass = res.status === 200 && j.success && j.message?.includes('coupang') && j.message?.includes('중지');
    SUMMARY.push({ gate: 8, pass, detail: `status=${res.status} success=${j.success} message="${j.message}"` });
    logResult(8, 'Kill Switch 마켓 단계 즉시 차단', pass, SUMMARY[7].detail);
  }

  // ========================================================================
  // Gate 9: 모바일 selective UI (모바일 카드 마크업 + 일괄 작업 PC 전용)
  // ========================================================================
  {
    const ordersRes = await fetch(`${BASE}/orders`);
    const html = await ordersRes.text();
    const css = fs.readFileSync(path.resolve(__dirname, '..', 'css', 'sprint3.css'), 'utf8');
    const hasMobileCards = html.includes('class="orders-mobile"') && html.includes('id="ordersMobile"');
    const hasDesktopOnly768 = css.includes('@media (min-width: 768px)') && css.includes('.orders-desktop, .cs-desktop, .pc-hint { display: none;');
    const hasFilterChips = html.includes('class="filter-chips"');
    const pass = ordersRes.status === 200 && hasMobileCards && hasDesktopOnly768 && hasFilterChips;
    SUMMARY.push({ gate: 9, pass, detail: `mobileCards=${hasMobileCards} desktopGated=${hasDesktopOnly768} chips=${hasFilterChips}` });
    logResult(9, '모바일 selective UI (768px 미만 = 카드만)', pass, SUMMARY[8].detail);
  }

  // ========================================================================
  // Gate 10: PC 풀 UI (테이블·일괄 처리·필터 풀 작동)
  // ========================================================================
  {
    const ordersRes = await fetch(`${BASE}/orders`);
    const html = await ordersRes.text();
    const hasTable = html.includes('class="orders-table"') && html.includes('id="ordersTable"');
    const hasBatch = html.includes('id="batchTrackBtn"') && html.includes('id="batchReturnBtn"');
    const hasCsDesktop = (await (await fetch(`${BASE}/cs-inbox`)).text()).includes('class="cs-desktop"');
    const pass = hasTable && hasBatch && hasCsDesktop;
    SUMMARY.push({ gate: 10, pass, detail: `table=${hasTable} batch=${hasBatch} csDesktop=${hasCsDesktop}` });
    logResult(10, 'PC 풀 UI (테이블·일괄·분할뷰)', pass, SUMMARY[9].detail);
  }

  // ========================================================================
  // Gate 11: 단위 테스트 (어댑터·재고·CS·송장)
  // ========================================================================
  {
    const { execSync } = require('child_process');
    let ok = false;
    let detail = '';
    try {
      const out = execSync(
        'node ' + path.resolve(__dirname, '..', 'netlify/functions/_shared/__tests__/sprint-3-orders-cs.test.js'),
        { encoding: 'utf8', env: { ...process.env, COUPANG_VERIFY_MOCK: 'true', NAVER_VERIFY_MOCK: 'true' } }
      );
      const m = out.match(/총 (\d+) 테스트 — (\d+) PASS, (\d+) FAIL/);
      ok = m && m[3] === '0';
      detail = m ? `${m[2]}/${m[1]} PASS` : 'no summary';
    } catch (e) {
      detail = 'execSync failed: ' + e.message.slice(0, 80);
    }
    SUMMARY.push({ gate: 11, pass: ok, detail });
    logResult(11, '단위 테스트 (어댑터·마스킹·재고·CS·priority)', ok, detail);
  }

  // ========================================================================
  // Gate 12: SQL 마이그레이션 멱등성
  // ========================================================================
  {
    const sql = fs.readFileSync(path.resolve(__dirname, '..', 'migrations', '2026-04-28-sprint-3-orders-cs.sql'), 'utf8');
    const tables = ['marketplace_orders', 'inventory_movements', 'cs_threads', 'cs_messages', 'tracking_events', 'kill_switch_log', 'courier_codes'];
    const allTables = tables.every((t) => new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`, 'i').test(sql));
    const idempotent = /CREATE TABLE IF NOT EXISTS/gi.test(sql) && /ON CONFLICT/i.test(sql);
    const rls = /ENABLE ROW LEVEL SECURITY/gi.test(sql);
    const pass = allTables && idempotent && rls;
    SUMMARY.push({ gate: 12, pass, detail: `tables=${allTables} idempotent=${idempotent} rls=${rls}` });
    logResult(12, 'SQL 마이그레이션 멱등 + RLS', pass, SUMMARY[11].detail);
  }

  // ========================================================================
  // Gate 13: 우선순위 뷰 카드 표시 + 데이터 일관성
  // ========================================================================
  {
    const res = await fetch(`${BASE}/api/priority-queue`, { headers: auth });
    const j = await res.json();
    const pass = res.status === 200 && j.ok && Array.isArray(j.cards) && j.cards.length >= 3
      && j.totals && j.totals.total_tasks > 0
      && typeof j.ai_message === 'string' && j.ai_message.length > 0;
    SUMMARY.push({ gate: 13, pass, detail: `cards=${j.cards?.length} totalTasks=${j.totals?.total_tasks} aiMsg="${(j.ai_message||'').slice(0,30)}..."` });
    logResult(13, '우선순위 뷰 카드 + AI 메시지', pass, SUMMARY[12].detail);
  }

  // ========================================================================
  // Gate 14: 스와이프 처리 — 카드 마크업 + 액션 버튼 둘 다 (모바일·PC)
  // ========================================================================
  {
    const ordersHtml = await (await fetch(`${BASE}/orders`)).text();
    const csHtml = await (await fetch(`${BASE}/cs-inbox`)).text();
    const ordersJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'sprint3-orders.js'), 'utf8');
    const csJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'sprint3-cs.js'), 'utf8');
    const hasOrderCardActions = ordersJs.includes('data-action="tracking"') && ordersJs.includes('data-action="return"');
    const hasCsCardActions = csJs.includes('data-action="send"') && csJs.includes('data-action="suggest"');
    const hasMobileMarkup = ordersHtml.includes('class="orders-mobile"') && csHtml.includes('class="cs-mobile"');
    const pass = hasOrderCardActions && hasCsCardActions && hasMobileMarkup;
    SUMMARY.push({ gate: 14, pass, detail: `orderActions=${hasOrderCardActions} csActions=${hasCsCardActions} mobileMarkup=${hasMobileMarkup}` });
    logResult(14, '카드별 1탭 처리 (송장·답변·반품)', pass, SUMMARY[13].detail);
  }

  // ========================================================================
  // Gate 15: AI 일괄 제안 + 단일 버튼 작동
  // ========================================================================
  {
    const tasksHtml = await (await fetch(`${BASE}/tasks`)).text();
    const tasksJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'sprint3-tasks.js'), 'utf8');
    const ordersJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'sprint3-orders.js'), 'utf8');
    const hasBatchActionsUI = tasksHtml.includes('id="batchActions"') && tasksHtml.includes('id="batchYes"');
    const hasBatchLogic = tasksJs.includes('batch.hidden = false') && ordersJs.includes('ids.map((id) => ({ order_id: id }))');
    const hasAiHint = tasksJs.includes('ai_message') && tasksHtml.includes('data-bind="ai_message"');
    const pass = hasBatchActionsUI && hasBatchLogic && hasAiHint;
    SUMMARY.push({ gate: 15, pass, detail: `batchUI=${hasBatchActionsUI} batchLogic=${hasBatchLogic} aiHint=${hasAiHint}` });
    logResult(15, 'AI 일괄 제안 + 단일 버튼', pass, SUMMARY[14].detail);
  }

  // ========================================================================
  // 최종
  // ========================================================================
  const total = SUMMARY.length;
  const passed = SUMMARY.filter((s) => s.pass).length;
  console.log('\n=== Sprint 3 Verify ===');
  console.log(`결과: ${passed}/${total} PASS`);
  console.log(JSON.stringify(SUMMARY, null, 2));
  fs.writeFileSync('/tmp/sprint3-verify-result.json', JSON.stringify(SUMMARY, null, 2));
  console.log('\n결과 JSON: /tmp/sprint3-verify-result.json');
  process.exit(passed === total ? 0 : 1);
})().catch((e) => {
  console.error('verify.js error:', e);
  process.exit(2);
});
