const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, token } = body;
  if (!email || !token) {
    return { statusCode: 400, body: JSON.stringify({ error: '필수 정보가 없습니다.' }) };
  }

  const LUMI_SECRET = process.env.LUMI_SECRET;
  const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET;

  try {
    const store = getStore('users');
    let raw;
    try { raw = await store.get('user:' + email); } catch { raw = null; }
    if (!raw) {
      return { statusCode: 404, body: JSON.stringify({ error: '회원 정보를 찾을 수 없습니다.' }) };
    }

    const user = JSON.parse(raw);

    // 토큰 검증 (token:xxx 키로 저장된 토큰 조회)
    let tokenData;
    try { tokenData = await store.get('token:' + token); } catch { tokenData = null; }
    if (!tokenData) {
      return { statusCode: 401, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
    }
    const parsed = JSON.parse(tokenData);
    if (parsed.email !== email) {
      return { statusCode: 401, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
    }

    // 이미 취소된 경우
    if (!user.plan || user.plan === 'none' || user.plan === 'trial') {
      return { statusCode: 400, body: JSON.stringify({ error: '활성 구독이 없습니다.' }) };
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
    return { statusCode: 500, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) };
  }
};
