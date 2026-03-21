// 결제 준비 - 포트원 v2 + 토스페이먼츠
// 프론트에서 결제 시작 전 호출 → 결제 금액 검증용 orderId 생성
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, planType } = body;
  if (!email || !planType) {
    return { statusCode: 400, body: JSON.stringify({ error: '필수 정보가 없습니다.' }) };
  }

  // 플랜별 금액
  const PLANS = {
    standard: { amount: 39000, name: 'lumi 스탠다드 플랜' }
  };

  const plan = PLANS[planType];
  if (!plan) {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 플랜입니다.' }) };
  }

  // 고유 주문 ID 생성
  const orderId = 'lumi_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

  try {
    // 주문 정보 Blobs에 저장 (결제 검증용)
    const store = getStore('orders');
    await store.set('order:' + orderId, JSON.stringify({
      orderId,
      email,
      planType,
      amount: plan.amount,
      orderName: plan.name,
      status: 'pending',
      createdAt: new Date().toISOString()
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        orderId,
        amount: plan.amount,
        orderName: plan.name
      })
    };
  } catch (err) {
    console.error('payment-prepare error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: '주문 생성에 실패했습니다.' }) };
  }
};
