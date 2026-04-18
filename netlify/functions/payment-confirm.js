// 결제 완료 검증 - 포트원 v2 서버사이드 검증
const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': 'https://lumi.it.kr', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 인증: Bearer 토큰 Blobs 검증
  const authHeader = event.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!bearerToken) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  {
    const userStore = getStore({ name: 'users', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    let tokenRaw = null;
    let tokenBlobError = false;
    const RETRY_DELAYS = [200, 400, 800, 1600, 3200];
    for (let i = 0; i < RETRY_DELAYS.length; i++) {
      tokenBlobError = false;
      try { tokenRaw = await userStore.get('token:' + bearerToken); }
      catch(e) { tokenBlobError = true; console.error('[payment-confirm] token blob fetch error (attempt ' + (i+1) + '):', e.message); }
      if (tokenRaw) break;
      if (!tokenBlobError) break;
      if (i < RETRY_DELAYS.length - 1) await new Promise(r => setTimeout(r, RETRY_DELAYS[i]));
    }
    if (!tokenRaw) {
      if (tokenBlobError) {
        console.warn('[payment-confirm] token blob error after 5 retries, bearer prefix:', bearerToken.substring(0, 8));
        return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: '일시적 서버 오류입니다. 잠시 후 다시 시도해주세요.' }) };
      }
      console.warn('[payment-confirm] token not found, bearer prefix:', bearerToken.substring(0, 8));
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
    }
    const tokenData = JSON.parse(tokenRaw);
    if (tokenData.expiresAt && Date.now() > tokenData.expiresAt) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '세션이 만료됐습니다.' }) };
    }
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { paymentId, orderId } = body;
  if (!paymentId || !orderId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '결제 정보가 없습니다.' }) };
  }

  const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET;
  if (!PORTONE_API_SECRET) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '결제 설정 오류입니다.' }) };
  }

  try {
    const store = getStore({ name: 'orders', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });

    // 주문 정보 조회
    let raw;
    try { raw = await store.get('order:' + orderId); } catch { raw = null; }
    if (!raw) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '주문을 찾을 수 없습니다.' }) };
    }

    const order = JSON.parse(raw);
    if (order.status === 'paid') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: '이미 처리된 결제입니다.' }) };
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
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '결제 검증에 실패했습니다.' }) };
    }

    const payment = await portoneRes.json();

    // 금액 검증
    if (payment.amount.total !== order.amount) {
      console.error('금액 불일치:', payment.amount.total, order.amount);
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '결제 금액이 일치하지 않습니다.' }) };
    }

    // 결제 상태 확인
    if (payment.status !== 'PAID') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '결제가 완료되지 않았습니다.' }) };
    }

    // 주문 상태 업데이트
    order.status = 'paid';
    order.paymentId = paymentId;
    order.paidAt = new Date().toISOString();
    await store.set('order:' + orderId, JSON.stringify(order));

    // 회원 플랜 업데이트
    const userStore = getStore({ name: 'users', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    let userRaw;
    try { userRaw = await userStore.get('user:' + order.email); } catch(e) { console.error('[payment-confirm] user blob fetch error:', e.message); userRaw = null; }

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
      const now = new Date();
      user.postCountMonth = now.getFullYear() + '-' + (now.getMonth() + 1);
      await userStore.set('user:' + order.email, JSON.stringify(user));
    }

    // 결제 완료 이메일 발송
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      if (order.email && process.env.RESEND_API_KEY) {
        const planNames = { standard: '월간', standard_3m: '3개월', standard_yearly: '연간' };
        const planLabel = planNames[order.planType] || '스탠다드';
        await resend.emails.send({
          from: 'lumi <no-reply@lumi.it.kr>',
          to: order.email,
          subject: `[lumi] 스탠다드 ${planLabel} 결제가 완료됐어요!`,
          html: `<div style="font-family:Pretendard,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <h2 style="color:#E8628A;margin-bottom:16px;">결제 완료 🎉</h2>
            <p style="color:#333D4B;line-height:1.8;">
              스탠다드 ${planLabel} 플랜 결제가 정상 처리됐어요.<br>
              결제 금액: <strong>${order.amount.toLocaleString()}원</strong><br>
              지금 바로 대시보드에서 사진을 올려보세요!
            </p>
            <a href="https://lumi.it.kr/dashboard" style="display:inline-block;margin-top:20px;padding:12px 28px;background:#E8628A;color:#fff;border-radius:12px;text-decoration:none;font-weight:700;">대시보드 바로가기</a>
          </div>`
        });
      }
    } catch (emailErr) {
      console.error('결제 완료 이메일 발송 실패:', emailErr.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        message: '결제가 완료됐어요!',
        plan: order.planType
      })
    };

  } catch (err) {
    console.error('payment-confirm error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '결제 처리 중 오류가 발생했습니다.' }) };
  }
};
