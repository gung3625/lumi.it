// 회원 탈퇴 복구 (30일 유예 내)
// POST /api/account-restore
// 헤더: Authorization: Bearer <jwt>
// 응답: { ok: true }
//
// 동작:
//   1) JWT 검증 → seller 식별
//   2) 현재 deletion_requested_at IS NOT NULL AND deletion_cancelled_at IS NULL 인지 확인
//   3) UPDATE deletion_cancelled_at = now()
//   4) Resend 로 복구 알림 메일

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

function buildRestoreEmailHtml({ ownerName }) {
  const safeName = (ownerName || '사장님').toString().slice(0, 40);
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Pretendard','Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:#C8507A;padding:28px;text-align:center;">
    <span style="font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.5px;">lumi</span>
  </td></tr>
  <tr><td style="padding:36px 32px;">
    <h1 style="margin:0 0 16px;font-size:20px;color:#191F28;line-height:1.4;">계정이 복구되었어요</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#4E5968;line-height:1.7;">${safeName}, 회원 탈퇴를 취소하고 정상적으로 복구했어요. 모든 매장 정보·캡션 히스토리·SNS 연동이 그대로 유지됩니다.</p>
    <a href="https://lumi.it.kr/dashboard" style="display:inline-block;padding:12px 24px;background:#C8507A;color:#fff;text-decoration:none;border-radius:980px;font-size:14px;font-weight:600;">대시보드로 가기</a>
    <p style="margin:24px 0 0;font-size:12px;color:#999;line-height:1.6;">본인이 요청한 작업이 아니라면 즉시 lumi@lumi.it.kr 로 알려주세요.</p>
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #eee;font-size:11px;color:#999;line-height:1.6;">
    <p style="margin:0;">발신: 루미(lumi) | 사업자등록번호: 404-09-66416 | 문의: lumi@lumi.it.kr</p>
  </td></tr>
</table>
</body></html>`;
}

async function sendRestoreEmail({ to, ownerName }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return { skipped: true };
  try {
    const html = buildRestoreEmailHtml({ ownerName });
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: 'lumi <noreply@lumi.it.kr>',
        to: [to],
        subject: '[lumi] 회원 탈퇴를 취소하고 계정을 복구했어요',
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[account-restore] Resend 실패:', res.status, text.slice(0, 200));
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error('[account-restore] Resend 예외:', e.message);
    return { ok: false };
  }
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[account-restore] admin client 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  let sellerQuery = null;
  try {
    const { data: supaAuthData } = await admin.auth.getUser(token);
    if (supaAuthData && supaAuthData.user && supaAuthData.user.email) {
      sellerQuery = { field: 'email', value: supaAuthData.user.email };
    }
  } catch (_) { /* fallthrough */ }

  if (!sellerQuery) {
    const { payload, error: authErr } = verifySellerToken(token);
    if (authErr || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 만료되었습니다. 다시 로그인해주세요.' }) };
    }
    sellerQuery = { field: 'id', value: payload.seller_id };
  }

  const { data: seller, error: selErr } = await admin
    .from('sellers')
    .select('id, owner_name, email, deletion_requested_at, deletion_cancelled_at')
    .eq(sellerQuery.field, sellerQuery.value)
    .maybeSingle();

  if (selErr) {
    console.error('[account-restore] seller select 오류:', selErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '회원 정보 조회에 실패했습니다.' }) };
  }
  if (!seller) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '회원을 찾을 수 없습니다.' }) };
  }
  if (!seller.deletion_requested_at) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '탈퇴 요청 상태가 아닙니다.' }) };
  }

  // 이미 복구된 상태여도 멱등 처리 — 단순 200 반환
  if (seller.deletion_cancelled_at) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, success: true, alreadyRestored: true }) };
  }

  const now = new Date();
  const { error: updErr } = await admin
    .from('sellers')
    .update({ deletion_cancelled_at: now.toISOString() })
    .eq('id', seller.id)
    .not('deletion_requested_at', 'is', null);

  if (updErr) {
    console.error('[account-restore] update 오류:', updErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '복구 처리에 실패했습니다.' }) };
  }

  console.log(`[account-restore] seller=${seller.id.slice(0, 8)} restored`);

  if (seller.email) {
    await sendRestoreEmail({ to: seller.email, ownerName: seller.owner_name });
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, success: true }),
  };
};
