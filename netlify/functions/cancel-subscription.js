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

  const { email, token } = body;
  if (!email || !token) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '필수 정보가 없습니다.' }) };
  }

  const LUMI_SECRET = process.env.LUMI_SECRET;
  const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET;

  try {
    const store = getStore({ name: 'users', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    let raw;
    try { raw = await store.get('user:' + email); } catch { raw = null; }
    if (!raw) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '회원 정보를 찾을 수 없습니다.' }) };
    }

    const user = JSON.parse(raw);

    // 토큰 검증 (token:xxx 키로 저장된 토큰 조회)
    let tokenData;
    try {
      tokenData = await store.get('token:' + token);
      if (tokenData) {
        const td = JSON.parse(tokenData);
        if (td.expiresAt && new Date(td.expiresAt) < new Date()) { tokenData = null; }
      }
    } catch { tokenData = null; }
    if (!tokenData) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
    }
    const parsed = JSON.parse(tokenData);
    if (parsed.email !== email) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
    }

    // 이미 취소된 경우
    if (!user.plan || user.plan === 'none' || user.plan === 'trial') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '활성 구독이 없습니다.' }) };
    }

    // 레거시 빌링키 정리 (일시불 전환 후에도 기존 사용자를 위해 유지)
    // 포트원 빌링키 삭제 (있는 경우)
    if (user.billingKey && PORTONE_API_SECRET) {
      try {
        await fetch(`https://api.portone.io/billing-keys/${user.billingKey}`, {
          method: 'DELETE',
          headers: {
            'Authorization': 'PortOne ' + PORTONE_API_SECRET,
            'Content-Type': 'application/json'
          }
        });
      } catch(e) {
        console.error('빌링키 삭제 오류:', e.message);
      }
    }

    // 회원 플랜 취소 처리
    user.planCancelledAt = new Date().toISOString();
    user.billingKey = null;
    // 현재 결제 기간 끝까지는 이용 가능 (planExpireAt 유지)
    // 다음 달부터 갱신 안 됨
    user.autoRenew = false;

    await store.set('user:' + email, JSON.stringify(user));

    // 이탈 방지 이메일 발송
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (RESEND_API_KEY) {
      try {
        const userName = user.name || user.storeName || '사장님';
        const expireDate = user.planExpireAt ? new Date(user.planExpireAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }) : '만료일';
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_API_KEY },
          body: JSON.stringify({
            from: 'lumi <no-reply@lumi.it.kr>',
            to: [email],
            subject: `(광고) ${userName}님, 정말 떠나시는 건가요?`,
            html: `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f9f9f9;font-family:-apple-system,sans-serif;"><div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);"><div style="background:#C8507A;padding:32px 40px;text-align:center;"><img src="https://lumi.it.kr/assets/logo.png" alt="lumi" style="height:48px;"></div><div style="padding:40px;"><h2 style="margin:0 0 12px;color:#111;font-size:22px;font-weight:800;">${userName}님, 아쉬워요</h2><p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.7;">구독 취소가 완료됐어요.<br><strong>${expireDate}</strong>까지는 모든 기능을 계속 쓸 수 있어요.</p><div style="background:#fff0f6;border-radius:12px;padding:20px 24px;margin-bottom:28px;"><p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#C8507A;">혹시 이런 이유였나요?</p><p style="margin:0;font-size:14px;color:#555;line-height:1.7;">• 캡션 퀄리티가 기대에 못 미쳤다면 → 말투 학습 피드백을 남겨주세요<br>• 가격이 부담이었다면 → 베이직 플랜 (월 1.9만원)도 있어요<br>• 사용법을 잘 모르겠다면 → 1:1 도움 드릴게요</p></div><div style="text-align:center;"><a href="https://lumi.it.kr/support" style="display:inline-block;background:#C8507A;color:#fff;text-decoration:none;padding:14px 36px;border-radius:99px;font-size:15px;font-weight:700;">피드백 남기기</a></div><p style="margin:28px 0 0;font-size:13px;color:#aaa;text-align:center;">마음이 바뀌시면 언제든 다시 구독할 수 있어요.</p></div></div></body></html>`
          })
        });
      } catch(e) { console.log('이탈 방지 이메일 실패:', e.message); }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: '구독이 취소됐어요. ' + (user.planExpireAt ? new Date(user.planExpireAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }) : '만료일') + '까지는 계속 이용 가능해요.'
      })
    };

  } catch (err) {
    console.error('cancel-subscription error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) };
  }
};
