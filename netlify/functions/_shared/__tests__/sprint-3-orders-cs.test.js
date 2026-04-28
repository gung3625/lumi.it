// Sprint 3 단위 테스트 — 어댑터·마스킹·재고·CS suggester·우선순위
// 사용: node netlify/functions/_shared/__tests__/sprint-3-orders-cs.test.js
// 외부 의존: node-fetch (이미 사용 중), Supabase 모듈은 모킹

process.env.COUPANG_VERIFY_MOCK = 'true';
process.env.NAVER_VERIFY_MOCK = 'true';
process.env.SHIPMENT_TRACK_MOCK = 'true';
process.env.CS_SUGGEST_MOCK = 'true';

const path = require('path');

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

const privacy = require(path.resolve(__dirname, '..', 'privacy-mask'));
const cs = require(path.resolve(__dirname, '..', 'cs-suggester'));
const courier = require(path.resolve(__dirname, '..', 'courier-codes'));
const tracker = require(path.resolve(__dirname, '..', 'shipment-tracker'));
const inv = require(path.resolve(__dirname, '..', 'inventory-engine'));
const pq = require(path.resolve(__dirname, '..', 'priority-queue'));
const coupangOrders = require(path.resolve(__dirname, '..', 'market-adapters', 'coupang-orders-adapter'));
const naverOrders = require(path.resolve(__dirname, '..', 'market-adapters', 'naver-orders-adapter'));

// =========================================================================
// 1. Privacy 마스킹
// =========================================================================
t('privacy.maskName 한글 1자', () => eq(privacy.maskName('김'), '김'));
t('privacy.maskName 한글 3자', () => eq(privacy.maskName('김철수'), '김**'));
t('privacy.maskName 영문', () => eq(privacy.maskName('Smith'), 'S****'));
t('privacy.maskName 빈값', () => eq(privacy.maskName(''), ''));

t('privacy.maskPhone 010-1234-5678', () => eq(privacy.maskPhone('010-1234-5678'), '010-****-5678'));
t('privacy.maskPhone 01012345678', () => eq(privacy.maskPhone('01012345678'), '010-****-5678'));
t('privacy.maskPhone 0212345678 (10자리)', () => eq(privacy.maskPhone('0212345678'), '021-****-5678'));

t('privacy.maskAddress 서울', () => eq(privacy.maskAddress('서울특별시 강남구 테헤란로 152'), '서울특별시 강남구 ***'));
t('privacy.maskAddress 경기도', () => eq(privacy.maskAddress('경기도 성남시 분당구 판교역로 235'), '경기도 성남시 ***'));

t('privacy.maskBuyerFields 통합', () => {
  const r = privacy.maskBuyerFields({ buyer_name: '김철수', buyer_phone: '01012345678', buyer_address: '서울특별시 강남구 테헤란로' });
  eq(r.buyer_name_masked, '김**');
  eq(r.buyer_phone_masked, '010-****-5678');
  eq(r.buyer_address_masked, '서울특별시 강남구 ***');
});

// =========================================================================
// 2. CS suggester
// =========================================================================
t('cs.classifyCategory 배송', () => eq(cs.classifyCategory('주문한 거 언제 배송돼요?'), 'shipping'));
t('cs.classifyCategory 교환', () => eq(cs.classifyCategory('사이즈 교환 가능한가요?'), 'exchange'));
t('cs.classifyCategory 환불', () => eq(cs.classifyCategory('환불 부탁드립니다'), 'refund'));
t('cs.classifyCategory 기타', () => eq(cs.classifyCategory('안녕하세요'), 'other'));

t('cs.suggestReply 배송 응답', async () => {
  const r = await cs.suggestReply({ message: '언제 발송되나요?', buyer_name_masked: '김**', product_title: '봄 원피스', mock: true });
  eq(r.category, 'shipping');
  ok(r.response.includes('김**'), 'should include buyer name');
  ok(r.response.includes('봄 원피스'), 'should include product');
  ok(r.confidence > 0);
});

t('cs.suggestReply 송장 안내 포함', async () => {
  const r = await cs.suggestReply({ message: '배송 언제?', courier: 'CJ대한통운', tracking_number: '1234567890', mock: true });
  ok(r.response.includes('CJ대한통운'), 'should include courier');
  ok(r.response.includes('1234567890'), 'should include tracking');
});

// =========================================================================
// 3. Courier codes
// =========================================================================
t('courier.listCouriers 6개', () => eq(courier.listCouriers().length, 6));
t('courier.getCourier CJGLS', () => eq(courier.getCourier('CJGLS').display_name, 'CJ대한통운'));
t('courier.isValidCourierCode true', () => eq(courier.isValidCourierCode('LOGEN'), true));
t('courier.isValidCourierCode false', () => eq(courier.isValidCourierCode('XXX'), false));

// =========================================================================
// 4. Shipment tracker (모킹)
// =========================================================================
t('tracker.trackShipment 모킹 phase 0', async () => {
  const r = await tracker.trackShipment({ courier_code: 'CJGLS', tracking_number: '1000000000', mock: true });
  ok(r.ok);
  ok(Array.isArray(r.events));
  eq(r.events.length, 1);   // last digit 0 → 1 event
  eq(r.events[0].status, 'shipping');
});
t('tracker.trackShipment 모킹 phase 1', async () => {
  const r = await tracker.trackShipment({ courier_code: 'CJGLS', tracking_number: '1234567891', mock: true });
  ok(r.ok);
  eq(r.events.length, 3);  // last digit 1 → 3 events
});
t('tracker.trackShipment 모킹 phase 2', async () => {
  const r = await tracker.trackShipment({ courier_code: 'CJGLS', tracking_number: '1234567892', mock: true });
  ok(r.ok);
  eq(r.events.length, 4);  // last digit 2 → 4 events (delivered)
  eq(r.current_status, 'delivered');
});
t('tracker.trackShipment 잘못된 코드', async () => {
  const r = await tracker.trackShipment({ courier_code: 'ZZZ', tracking_number: '12345', mock: true });
  ok(!r.ok);
});
t('tracker.normalizeSmartTrackerResponse', () => {
  const r = tracker.normalizeSmartTrackerResponse({ trackingDetails: [
    { kind: '집화처리', where: '서울', timeString: '2026-04-28T08:00:00' },
    { kind: '배달완료', where: '문 앞', timeString: '2026-04-28T15:00:00' },
  ]});
  eq(r.length, 2);
  eq(r[0].status, 'shipping');
  eq(r[1].status, 'delivered');
});

// =========================================================================
// 5. Inventory engine (admin 모킹)
// =========================================================================
function mockAdmin() {
  const captured = { inserts: [], updates: [] };
  const builder = (table) => ({
    insert: (row) => ({
      select: () => ({
        single: async () => { captured.inserts.push({ table, row }); return { data: { id: 'mv-' + Math.random() }, error: null }; },
      }),
    }),
    update: (changes) => ({
      eq: () => ({ async then(resolve) { captured.updates.push({ table, changes }); resolve({ error: null }); } }),
    }),
  });
  return { from: builder, _captured: captured };
}

t('inventory.recordMovement 정상', async () => {
  const adm = mockAdmin();
  const r = await inv.recordMovement(adm, {
    seller_id: 'sx', product_id: 'p1', market: 'coupang', movement_type: 'sale', quantity_delta: -1, reference_type: 'order', reference_id: 'o1',
  });
  ok(r.ok);
  eq(adm._captured.inserts.length, 1);
});
t('inventory.recordMovement 0 차단', async () => {
  const r = await inv.recordMovement(mockAdmin(), { seller_id: 'sx', movement_type: 'sale', quantity_delta: 0 });
  ok(!r.ok);
});
t('inventory.restoreStockForReturn 가산', async () => {
  // mockAdmin과 호환되는 from(...).update(...).eq(...) 수정 필요
  const captured = { mv: [], upd: [] };
  const adm = {
    from(table) {
      if (table === 'inventory_movements') {
        return {
          insert: (row) => ({ select: () => ({ single: async () => { captured.mv.push(row); return { data: { id: 'mv-1' }, error: null }; } }) }),
        };
      }
      if (table === 'marketplace_orders') {
        return {
          update: (changes) => ({
            eq: async () => { captured.upd.push(changes); return { error: null }; },
          }),
        };
      }
    },
  };
  const r = await inv.restoreStockForReturn(adm, { id: 'o-1', seller_id: 'sx', product_id: 'p1', market: 'coupang', quantity: 2 });
  ok(r.ok);
  eq(r.quantity_delta, 2);
  eq(captured.mv[0].quantity_delta, 2);
  ok(captured.upd[0].stock_restored === true);
});

// =========================================================================
// 6. Coupang orders adapter (모킹)
// =========================================================================
t('coupangOrders.fetchNewOrders 모킹 2건', async () => {
  const r = await coupangOrders.fetchNewOrders({ market_seller_id: 'V_TEST', mock: true });
  ok(r.ok);
  eq(r.orders.length, 2);
  eq(r.orders[0].market, 'coupang');
  ok(r.orders[0].market_order_id.startsWith('CP_MOCK_'));
});
t('coupangOrders.normalizeCoupangOrder 정규화', () => {
  const raw = { orderId: 'O1', orderItems: [{ productId: 'P1', sellerProductName: 'T', shippingCount: 3, salesPrice: 10000 }], receiverName: '김', receiver: { receiverPhone: '010', addr1: '서울', addr2: '강남' } };
  const o = coupangOrders.normalizeCoupangOrder(raw);
  eq(o.market, 'coupang');
  eq(o.market_order_id, 'O1');
  eq(o.quantity, 3);
});
t('coupangOrders.submitTracking 모킹', async () => {
  const r = await coupangOrders.submitTracking({ market_order_id: 'OS1', tracking_number: '12345', courier_code: 'CJGLS', mock: true });
  ok(r.ok);
  ok(r.mocked);
});
t('coupangOrders.submitTracking 검증 실패', async () => {
  const r = await coupangOrders.submitTracking({ market_order_id: '', tracking_number: '', courier_code: '', mock: true });
  ok(!r.ok);
});
t('coupangOrders.killSwitch 모킹 스톱', async () => {
  const r = await coupangOrders.killSwitch({ scope: 'market', action: 'stop', mock: true });
  ok(r.ok);
  eq(r.applied, 1);
});

// =========================================================================
// 7. Naver orders adapter (모킹)
// =========================================================================
t('naverOrders.fetchNewOrders 모킹 1건', async () => {
  const r = await naverOrders.fetchNewOrders({ store_id: 'mystore', mock: true });
  ok(r.ok);
  eq(r.orders.length, 1);
  eq(r.orders[0].market, 'naver');
});
t('naverOrders.submitTracking 모킹', async () => {
  const r = await naverOrders.submitTracking({ market_order_id: 'NV1', tracking_number: '6666', courier_code: 'LOGEN', mock: true });
  ok(r.ok);
});
t('naverOrders.fetchCsThreads 모킹 1건', async () => {
  const r = await naverOrders.fetchCsThreads({ market_seller_id: 'NV_TEST', mock: true });
  ok(r.ok);
  eq(r.threads.length, 1);
});

// =========================================================================
// 8. Priority queue (모킹)
// =========================================================================
t('priorityQueue.buildMockPriorityCards', () => {
  const r = pq.buildMockPriorityCards();
  ok(r.ok);
  ok(r.cards.length >= 3);
  ok(r.totals.total_tasks > 0);
});
t('priorityQueue.cards 정렬 (priority desc)', () => {
  const r = pq.buildMockPriorityCards();
  for (let i = 1; i < r.cards.length; i += 1) {
    ok((r.cards[i - 1].priority || 0) >= (r.cards[i].priority || 0), 'should be descending');
  }
});

// =========================================================================
// 실행
// =========================================================================
(async () => {
  let pass = 0, fail = 0;
  const failures = [];
  for (const test of tests) {
    try {
      await test.fn();
      pass += 1;
      console.log(`[PASS] ${test.name}`);
    } catch (e) {
      fail += 1;
      failures.push({ name: test.name, error: e.message });
      console.log(`[FAIL] ${test.name} — ${e.message}`);
    }
  }
  console.log(`\n총 ${tests.length} 테스트 — ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
