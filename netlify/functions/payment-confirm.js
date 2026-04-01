// 결제 완료 검증 - 포트원 v2 서버사이드 검증
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { paymentId, orderId } = body;
  if (!paymentId || !orderId) {
    return { statusCode: 400, body: JSON.stringify({ error: '결제 정보가 없습니다.' }) };
  }

  const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET;
  if (!PORTONE_API_SECRET) {
    return { statusCode: 500, body: JSON.stringify({ error: '결제 설정 오류입니다.' }) };
  }

  try {
    const store = getStore('orders');

    // 주문 정보 조회
    let raw;
    try { raw = await store.get('order:' + orderId); } catch { raw = null; }
    if (!raw) {
      return { statusCode: 404, body: JSON.stringify({ error: '주문을 찾을 수 없습니다.' }) };
    }

    const order = JSON.parse(raw);
    if (order.status === 'paid') {
      return { statusCode: 200, body: JSON.stringify({ success: true, message: '이미 처리된 결제입니다.' }) };
    }

    // 포트원 v2 결제 조회 API로 검증
    const portoneRes = await fetch(`https://api.portone.io/payments/${paymentId}`, {
      headers: {
        'Authorization': 'PortOne ' + PORTONE_API_SECRET,
        'Content-Type': 'application/json'
      }
    });

    if (!portoneRes.ok) {
      console.error('포트원 결제 조회 실패:', portoneRes.status);
      return { statusCode: 400, body: JSON.stringify({ error: '결제 검증에 실패했습니다.' }) };
    }

    const payment = await portoneRes.json();

    // 금액 검증
    if (payment.amount.total !== order.amount) {
      console.error('금액 불일치:', payment.amount.total, order.amount);
      return { statusCode: 400, body: JSON.stringify({ error: '결제 금액이 일치하지 않습니다.' }) };
    }

    // 결제 상태 확인
    if (payment.status !== 'PAID') {
      return { statusCode: 400, body: JSON.stringify({ error: '결제가 완료되지 않았습니다.' }) };
    }

    // 주문 상태 업데이트
    order.status = 'paid';
    order.paymentId = paymentId;
    order.paidAt = new Date().toISOString();
    await store.set('order:' + orderId, JSON.stringify(order));

    // 회원 플랜 업데이트
    const userStore = getStore('users');
    let userRaw;
    try { userRaw = await userStore.get('user:' + order.email); } catch { userRaw = null; }

    if (userRaw) {
      const user = JSON.parse(userRaw);
      // plan은 standard로 통일
      user.plan = 'standard';
      user.billingCycle = order.planType === 'standard_yearly' ? 'yearly' : order.planType === 'standard_3m' ? 'quarterly' : 'monthly';
      user.planStartAt = new Date().toISOString();
      // 기존 기간이 남아있으면 합산
      const baseDate = (user.planExpireAt && new Date(user.planExpireAt) > new Date()) ? new Date(user.planExpireAt) : new Date();
      const durationDays = order.durationDays || 31;
      user.planExpireAt = new Date(baseDate.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
      user.lastPaymentId = paymentId;
      user.lastOrderId = orderId;
      user.postCountMonth = new Date().toISOString().slice(0, 7);
      await userStore.set('user:' + order.email, JSON.stringify(user));
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: '결제가 완료됐어요!',
        plan: order.planType
      })
    };

  } catch (err) {
    console.error('payment-confirm error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: '결제 처리 중 오류가 발생했습니다.' }) };
  }
};
