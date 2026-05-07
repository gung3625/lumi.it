// 30일 유예 회원 탈퇴 요청
// POST /api/account-delete
// 헤더: Authorization: Bearer <jwt> (Supabase JWT or seller-jwt)
// 응답: { ok: true, deletionScheduledAt: '<ISO>' }
//
// 동작:
//   1) JWT 검증 → seller 행 식별 (Supabase JWT 우선, seller-jwt fallback)
//   2) sellers UPDATE: deletion_requested_at = now(),
//                      deletion_scheduled_at = now() + interval '30 days',
//                      deletion_cancelled_at = NULL,
//                      deletion_reminder_sent_at = NULL
//   3) Resend 로 한국어 안내 메일 (30일 유예 + 복구 방법)
//
// 클라이언트 측에서는 응답 후 logout 처리 + index.html 로 redirect.
// 30일 내 다시 로그인하면 auth-guard 가 배너로 복구 옵션 노출.

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const GRACE_DAYS = 30;

function buildDeletionEmailHtml({ ownerName, scheduledIso }) {
  const safeName = (ownerName || '사장님').toString().slice(0, 40);
  const scheduledKr = new Date(scheduledIso).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Pretendard','Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:#C8507A;padding:28px;text-align:center;">
    <span style="font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.5px;">lumi</span>
  </td></tr>
  <tr><td style="padding:36px 32px;">
    <h1 style="margin:0 0 16px;font-size:20px;color:#191F28;line-height:1.4;">회원 탈퇴 요청을 받았어요</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#4E5968;line-height:1.7;">${safeName}, 탈퇴 요청을 정상적으로 접수했어요. 모든 데이터는 <b>${GRACE_DAYS}일 유예기간</b> 후에 영구 삭제됩니다.</p>
    <div style="margin:0 0 24px;padding:16px 20px;background:#FFF5F8;border-radius:12px;">
      <p style="margin:0 0 4px;font-size:13px;color:#888;">자동 삭제 예정 시각</p>
      <p style="margin:0;font-size:16px;font-weight:700;color:#C8507A;">${scheduledKr}</p>
    </div>
    <h2 style="margin:0 0 12px;font-size:16px;color:#191F28;">탈퇴를 취소하려면?</h2>
    <p style="margin:0 0 20px;font-size:14px;color:#4E5968;line-height:1.7;">${GRACE_DAYS}일 안에 다시 로그인해주세요. 로그인하면 화면 상단에 표시되는 <b>복구하기</b> 버튼을 눌러 즉시 되돌릴 수 있어요.</p>
    <a href="https://lumi.it.kr/" style="display:inline-block;padding:12px 24px;background:#C8507A;color:#fff;text-decoration:none;border-radius:980px;font-size:14px;font-weight:600;">루미 다시 방문하기</a>
    <p style="margin:24px 0 0;font-size:12px;color:#999;line-height:1.6;">유예기간 만료 후에는 매장 정보·캡션 히스토리·SNS 연동 토큰 등 모든 데이터가 영구 삭제되며 복구가 불가능합니다. 본 메일에 회신하거나 lumi@lumi.it.kr 로 문의해 주세요.</p>
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #eee;font-size:11px;color:#999;line-height:1.6;">
    <p style="margin:0;">발신: 루미(lumi) | 사업자등록번호: 404-09-66416 | 문의: lumi@lumi.it.kr</p>
  </td></tr>
</table>
</body></html>`;
}

async function sendDeletionEmail({ to, ownerName, scheduledIso }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return { skipped: true };
  try {
    const html = buildDeletionEmailHtml({ ownerName, scheduledIso });
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: 'lumi <noreply@lumi.it.kr>',
        to: [to],
        subject: '[lumi] 회원 탈퇴 요청을 접수했어요 (30일 유예)',
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[account-delete] Resend 실패:', res.status, text.slice(0, 200));
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error('[account-delete] Resend 예외:', e.message);
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
    console.error('[account-delete] admin client 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  // 1) Supabase JWT 우선 (OAuth 사용자)
  let sellerQuery = null;
  try {
    const { data: supaAuthData } = await admin.auth.getUser(token);
    if (supaAuthData && supaAuthData.user && supaAuthData.user.email) {
      sellerQuery = { field: 'email', value: supaAuthData.user.email };
    }
  } catch (_) { /* fallthrough */ }

  // 2) seller-jwt fallback
  if (!sellerQuery) {
    const { payload, error: authErr } = verifySellerToken(token);
    if (authErr || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 만료되었습니다. 다시 로그인해주세요.' }) };
    }
    sellerQuery = { field: 'id', value: payload.seller_id };
  }

  // 현재 행 조회 (이름·이메일 + 이미 요청 중인지 확인)
  const { data: seller, error: selErr } = await admin
    .from('sellers')
    .select('id, owner_name, email, deletion_requested_at, deletion_cancelled_at')
    .eq(sellerQuery.field, sellerQuery.value)
    .maybeSingle();

  if (selErr) {
    console.error('[account-delete] seller select 오류:', selErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '회원 정보 조회에 실패했습니다.' }) };
  }
  if (!seller) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '회원을 찾을 수 없습니다.' }) };
  }

  const now = new Date();
  const scheduled = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);

  const { error: updErr } = await admin
    .from('sellers')
    .update({
      deletion_requested_at: now.toISOString(),
      deletion_scheduled_at: scheduled.toISOString(),
      deletion_cancelled_at: null,
      deletion_reminder_sent_at: null,
    })
    .eq('id', seller.id);

  if (updErr) {
    console.error('[account-delete] update 오류:', updErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '탈퇴 요청 처리에 실패했습니다.' }) };
  }

  console.log(`[account-delete] seller=${seller.id.slice(0, 8)} scheduled=${scheduled.toISOString()}`);

  // 안내 메일 (실패해도 응답에는 영향 없음)
  if (seller.email) {
    await sendDeletionEmail({
      to: seller.email,
      ownerName: seller.owner_name,
      scheduledIso: scheduled.toISOString(),
    });
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      success: true,
      deletionScheduledAt: scheduled.toISOString(),
      graceDays: GRACE_DAYS,
    }),
  };
};
