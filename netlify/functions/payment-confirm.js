// 결제 완료 검증 - PortOne v2 서버사이드 검증
// orderId 로 public.orders 조회 → PortOne API 검증 → public.users.plan 업데이트
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': 'https://lumi.it.kr',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Supabase Bearer 토큰 검증
  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    console.warn('[payment-confirm] 토큰 검증 실패');
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
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

  const admin = getAdminClient();

  try {
    // 주문 조회 (portone_payment_id = 클라이언트가 생성한 orderId)
    const { data: order, error: orderErr } = await admin
      .from('orders')
      .select('*')
      .eq('portone_payment_id', orderId)
      .single();

    if (orderErr || !order) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '주문을 찾을 수 없습니다.' }) };
    }

    // 본인 주문인지 확인
    if (order.user_id !== user.id) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '권한이 없습니다.' }) };
    }

    if (order.status === 'paid') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: '이미 처리된 결제입니다.' }) };
    }

    const paidAt = new Date().toISOString();

    // 0원 베타 플랜 — PortOne 결제 없이 바로 활성화
    // (향후 유료 정식 출시 시: amount > 0 분기에서 PortOne 검증 재개)
    if (order.amount !== 0) {
      // PortOne v2 결제 조회 API 검증
      const portoneRes = await fetch(`https://api.portone.io/payments/${paymentId}`, {
        headers: {
          'Authorization': 'PortOne ' + PORTONE_API_SECRET,
          'Content-Type': 'application/json',
        },
      });

      if (!portoneRes.ok) {
        console.error('[payment-confirm] PortOne 조회 실패 status:', portoneRes.status);
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '결제 검증에 실패했습니다.' }) };
      }

      const payment = await portoneRes.json();

      // 금액 검증
      if (payment.amount?.total !== order.amount) {
        console.error('[payment-confirm] 금액 불일치');
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '결제 금액이 일치하지 않습니다.' }) };
      }

      // 결제 상태 확인
      if (payment.status !== 'PAID') {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '결제가 완료되지 않았습니다.' }) };
      }
    }

    // 주문 상태 업데이트
    const existingRaw = (order.raw && typeof order.raw === 'object') ? order.raw : {};
    const { error: updateOrderErr } = await admin
      .from('orders')
      .update({
        status: 'paid',
        raw: { ...existingRaw, paidAt, paymentId },
      })
      .eq('portone_payment_id', orderId);

    if (updateOrderErr) {
      console.error('[payment-confirm] orders update 오류:', updateOrderErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '결제 처리 중 오류가 발생했습니다.' }) };
    }

    // 회원 플랜 업데이트 (service role 로 RLS 우회)
    const { data: userRow, error: userFetchErr } = await admin
      .from('users')
      .select('email, name, store_name, trial_start')
      .eq('id', user.id)
      .single();

    if (userFetchErr) {
      console.error('[payment-confirm] users fetch 오류:', userFetchErr.message);
    }

    const userUpdate = {
      plan: order.plan,
      auto_renew: true,
    };
    // trial_start 가 아직 없으면 이번 결제 시점을 기준으로 설정
    if (!userRow?.trial_start) {
      userUpdate.trial_start = paidAt;
    }

    const { error: userUpdateErr } = await admin
      .from('users')
      .update(userUpdate)
      .eq('id', user.id);

    if (userUpdateErr) {
      console.error('[payment-confirm] users update 오류:', userUpdateErr.message);
    }

    // 결제 완료 이메일 발송
    try {
      const { Resend } = require('resend');
      if (userRow?.email && process.env.RESEND_API_KEY) {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const planNameMap = { standard: '스탠다드', pro: '프로', business: '비즈니스' };
        const planLabel = planNameMap[order.plan] || order.plan;
        await resend.emails.send({
          from: 'lumi <no-reply@lumi.it.kr>',
          to: userRow.email,
          subject: `[lumi] ${planLabel} 플랜 결제가 완료됐어요!`,
          html: `<div style="font-family:Pretendard,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <h2 style="color:#C8507A;margin-bottom:16px;">결제 완료</h2>
            <p style="color:#333D4B;line-height:1.8;">
              ${planLabel} 플랜 결제가 정상 처리됐어요.<br>
              결제 금액: <strong>${order.amount.toLocaleString()}원</strong><br>
              지금 바로 대시보드에서 사진을 올려보세요!
            </p>
            <a href="https://lumi.it.kr/dashboard" style="display:inline-block;margin-top:20px;padding:12px 28px;background:#C8507A;color:#fff;border-radius:980px;text-decoration:none;font-weight:700;">대시보드 바로가기</a>
          </div>`,
        });
      }
    } catch (emailErr) {
      console.error('[payment-confirm] 이메일 발송 실패:', emailErr.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        message: '결제가 완료됐어요!',
        plan: order.plan,
      }),
    };

  } catch (err) {
    console.error('[payment-confirm] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '결제 처리 중 오류가 발생했습니다.' }) };
  }
};
