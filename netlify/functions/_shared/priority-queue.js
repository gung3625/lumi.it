// 우선순위 큐 — Sprint 3 보강 (사용자 명시 2026-04-28)
// 메인 화면 = 목록 X, 우선순위 카드 (메모리 proactive_ux_paradigm 시나리오 강화)
//
// 카드 종류:
// - 🚨 송장 입력 필요 (status=paid AND tracking_number IS NULL)
// - ⏰ 배송 대기 → 추적 (status=shipping)
// - 📥 CS 답변 대기 (cs_threads.status='pending')
// - 📦 반품 처리 대기 (status='returned' AND stock_restored=FALSE)
// - 📈 가격 조정 추천 (별도 룰)
//
// 정상은 숨김. 처리할 일만 카드로.

/**
 * 우선순위 큐 카드 빌드 (Supabase admin 사용)
 * @param {Object} admin
 * @param {string} sellerId
 * @returns {Promise<{ ok: boolean, cards: Array, totals: Object, error?: string }>}
 */
async function buildPriorityCards(admin, sellerId) {
  if (!admin || !sellerId) {
    return { ok: false, cards: [], totals: {}, error: 'admin/sellerId required' };
  }

  const cards = [];
  const totals = { pending_shipping: 0, pending_cs: 0, pending_return: 0, in_transit: 0, total_tasks: 0 };

  try {
    // 1. 송장 입력 필요
    const shipping = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('seller_id', sellerId)
      .eq('status', 'paid')
      .is('tracking_number', null);
    if (shipping.count > 0) {
      totals.pending_shipping = shipping.count;
      cards.push({
        id: 'pending_shipping',
        type: 'shipping',
        priority: 100,
        icon: 'package',
        title: '송장 입력 필요',
        count: shipping.count,
        message: `${shipping.count}건이 송장을 기다려요`,
        cta: '입력하러 가기',
        href: '/orders?filter=pending_shipping',
        ai_hint: shipping.count >= 5 ? '5건 이상이면 PC에서 일괄 입력이 빨라요.' : '카드 우 스와이프 = 1탭 입력',
      });
    }

    // 2. CS 답변 대기
    const cs = await admin
      .from('cs_threads')
      .select('id', { count: 'exact', head: true })
      .eq('seller_id', sellerId)
      .eq('status', 'pending');
    if (cs.count > 0) {
      totals.pending_cs = cs.count;
      cards.push({
        id: 'pending_cs',
        type: 'cs',
        priority: 90,
        icon: 'message-circle',
        title: 'CS 답변 대기',
        count: cs.count,
        message: `${cs.count}건의 문의가 답변을 기다려요`,
        cta: '답변하기',
        href: '/cs-inbox',
        ai_hint: 'AI 답변이 준비돼 있어요. 1탭으로 보내세요.',
      });
    }

    // 3. 반품 처리 대기
    const ret = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('seller_id', sellerId)
      .eq('status', 'returned')
      .eq('stock_restored', false);
    if (ret.count > 0) {
      totals.pending_return = ret.count;
      cards.push({
        id: 'pending_return',
        type: 'return',
        priority: 80,
        icon: 'rotate-ccw',
        title: '반품 처리 대기',
        count: ret.count,
        message: `${ret.count}건의 반품을 자동 처리할까요?`,
        cta: '자동 처리',
        href: '/orders?filter=pending_return',
        ai_hint: '재고 자동 가산까지 일괄로 진행돼요.',
        action: 'process-returns',
      });
    }

    // 4. 배송 진행 (정보 카드)
    const inTransit = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('seller_id', sellerId)
      .eq('status', 'shipping');
    if (inTransit.count > 0) {
      totals.in_transit = inTransit.count;
      cards.push({
        id: 'in_transit',
        type: 'tracking',
        priority: 30,
        icon: 'truck',
        title: '배송 진행 중',
        count: inTransit.count,
        message: `${inTransit.count}건이 고객에게 가고 있어요`,
        cta: '추적 보기',
        href: '/orders?filter=in_transit',
      });
    }
  } catch (e) {
    return { ok: false, cards: [], totals: {}, error: e.message };
  }

  totals.total_tasks = totals.pending_shipping + totals.pending_cs + totals.pending_return;

  // 우선순위 정렬 (priority desc)
  cards.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  return { ok: true, cards, totals };
}

/**
 * 모킹 카드 빌더 (admin 없을 때)
 */
function buildMockPriorityCards() {
  return {
    ok: true,
    cards: [
      {
        id: 'pending_shipping',
        type: 'shipping',
        priority: 100,
        icon: 'package',
        title: '송장 입력 필요',
        count: 5,
        message: '5건이 송장을 기다려요',
        cta: '입력하러 가기',
        href: '/orders?filter=pending_shipping',
        ai_hint: '카드 우 스와이프 = 1탭 입력',
      },
      {
        id: 'pending_cs',
        type: 'cs',
        priority: 90,
        icon: 'message-circle',
        title: 'CS 답변 대기',
        count: 3,
        message: '3건의 문의가 답변을 기다려요',
        cta: '답변하기',
        href: '/cs-inbox',
        ai_hint: 'AI 답변이 준비돼 있어요. 1탭으로 보내세요.',
      },
      {
        id: 'pending_return',
        type: 'return',
        priority: 80,
        icon: 'rotate-ccw',
        title: '반품 처리 대기',
        count: 1,
        message: '1건의 반품을 자동 처리할까요?',
        cta: '자동 처리',
        href: '/orders?filter=pending_return',
        ai_hint: '재고 자동 가산까지 일괄로 진행돼요.',
        action: 'process-returns',
      },
    ],
    totals: { pending_shipping: 5, pending_cs: 3, pending_return: 1, in_transit: 0, total_tasks: 9 },
  };
}

module.exports = {
  buildPriorityCards,
  buildMockPriorityCards,
};
