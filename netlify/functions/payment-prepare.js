// 결제 준비 - 포트원 v2 + 토스페이먼츠
// 프론트에서 결제 시작 전 호출 → 결제 금액 검증용 orderId 생성
const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { planType } = body;
  if (!planType) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '필수 정보가 없습니다.' }) };
  }

  // Authorization 헤더에서 토큰 → 이메일 역조회
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
  }
  const userStore = getStore({ name: 'users', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
  let tokenData;
  try { tokenData = await userStore.get('token:' + token); } catch { tokenData = null; }
  if (!tokenData) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
  }
  const { email } = JSON.parse(tokenData);
  if (!email) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
  }

  // 사용자 정보 조회 (결제창에 이름/이메일 전달용)
  let userName = '고객';
  try {
    const userRaw = await userStore.get('user:' + email);
    if (userRaw) { const u = JSON.parse(userRaw); userName = u.name || u.storeName || '고객'; }
  } catch {}


  // 플랜별 금액
  const PLANS = {
    basic:    { amount: 19000, name: 'lumi 베이직',   durationDays: 31 },
    standard: { amount: 29000, name: 'lumi 스탠다드', durationDays: 31 },
    pro:      { amount: 39000, name: 'lumi 프로',     durationDays: 31 }
  };

  const plan = PLANS[planType];
  if (!plan) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 플랜입니다.' }) };
  }

  // 고유 주문 ID 생성
  const orderId = 'lumi_' + Date.now() + '_' + require('crypto').randomBytes(12).toString('hex');

  try {
    // 주문 정보 Blobs에 저장 (결제 검증용)
    const store = getStore({ name: 'orders', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    await store.set('order:' + orderId, JSON.stringify({
      orderId,
      email,
      planType,
      amount: plan.amount,
      orderName: plan.name,
      durationDays: plan.durationDays,
      status: 'pending',
      createdAt: new Date().toISOString()
    }));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        orderId,
        amount: plan.amount,
        orderName: plan.name,
        email,
        name: userName
      })
    };
  } catch (err) {
    console.error('payment-prepare error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '주문 생성에 실패했습니다.' }) };
  }
};
