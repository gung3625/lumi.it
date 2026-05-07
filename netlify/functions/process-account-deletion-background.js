// 30일 유예기간 만료 회원 영구 삭제 cron
// schedule: 0 18 * * *  (UTC 18:00 = KST 03:00)
// 동작:
//   1) deletion_scheduled_at <= now() AND deletion_cancelled_at IS NULL 인 row 조회
//   2) 각 row 별로:
//      a) 최종 삭제 알림 이메일 (Resend)
//      b) cascade DELETE — ig_accounts / tiktok_accounts / reservations (seller_id 기준)
//      c) sellers row 의 user_id 또는 email 매핑된 auth.users 삭제 (admin.auth.admin.deleteUser)
//      d) sellers row DELETE
//   3) 한 row 실패해도 다음 row 계속, 마지막에 성공/실패 카운트 로그
//
// 주의: 외부 트리거 (Netlify scheduled background) — LUMI_SECRET 검증 불필요.

const { getAdminClient } = require('./_shared/supabase-admin');

const PROCESS_LIMIT = 100;

function buildFinalEmailHtml({ ownerName }) {
  const safeName = (ownerName || '사장님').toString().slice(0, 40);
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Pretendard','Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:#C8507A;padding:28px;text-align:center;">
    <span style="font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.5px;">lumi</span>
  </td></tr>
  <tr><td style="padding:36px 32px;">
    <h1 style="margin:0 0 16px;font-size:20px;color:#191F28;line-height:1.4;">계정이 영구 삭제되었어요</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#4E5968;line-height:1.7;">${safeName}, 30일 유예기간이 만료되어 회원 정보·매장 데이터·SNS 연동 토큰 등 모든 데이터가 영구 삭제되었습니다.</p>
    <p style="margin:0 0 20px;font-size:14px;color:#4E5968;line-height:1.7;">개인정보보호법 §36에 따라 백업 본도 30일 이내에 파기됩니다. 다시 이용을 원하시면 새 계정으로 가입해 주세요.</p>
    <p style="margin:24px 0 0;font-size:12px;color:#999;line-height:1.6;">이 메일은 자동 발송되었으며, 회신이 필요한 경우 lumi@lumi.it.kr 로 연락해 주세요.</p>
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #eee;font-size:11px;color:#999;line-height:1.6;">
    <p style="margin:0;">발신: 루미(lumi) | 사업자등록번호: 404-09-66416 | 문의: lumi@lumi.it.kr</p>
  </td></tr>
</table>
</body></html>`;
}

async function sendFinalEmail({ to, ownerName }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return { skipped: true };
  try {
    const html = buildFinalEmailHtml({ ownerName });
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: 'lumi <noreply@lumi.it.kr>',
        to: [to],
        subject: '[lumi] 회원 탈퇴 처리가 완료되었습니다',
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[process-account-deletion] Resend 실패:', res.status, text.slice(0, 200));
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error('[process-account-deletion] Resend 예외:', e.message);
    return { ok: false };
  }
}

async function deleteSellerCascade(admin, seller) {
  // ig_accounts, tiktok_accounts, reservations 는 seller_id 컬럼을 가진다 (다른 함수 패턴 일치)
  // 일부 테이블은 존재하지 않을 수 있으므로 각 호출 try/catch
  const tables = ['ig_accounts', 'tiktok_accounts', 'reservations'];
  for (const t of tables) {
    try {
      const { error } = await admin.from(t).delete().eq('seller_id', seller.id);
      if (error) console.warn(`[process-account-deletion] ${t} delete 경고 seller=${seller.id.slice(0, 8)}:`, error.message);
    } catch (e) {
      console.warn(`[process-account-deletion] ${t} delete 예외 seller=${seller.id.slice(0, 8)}:`, e.message);
    }
  }

  // auth.users 삭제 — email 매핑으로 식별 (sellers 에 user_id 컬럼 없음 가정)
  let authUserId = null;
  if (seller.email) {
    try {
      // listUsers 는 admin API 의 페이징이 1000 default. 단순 대조용 — 실제 운영시 emaill 직접 매핑 권장.
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const found = (list && list.users || []).find(u => (u.email || '').toLowerCase() === String(seller.email).toLowerCase());
      if (found) authUserId = found.id;
    } catch (e) {
      console.warn(`[process-account-deletion] auth listUsers 실패 seller=${seller.id.slice(0, 8)}:`, e.message);
    }
  }
  if (authUserId) {
    try {
      const { error } = await admin.auth.admin.deleteUser(authUserId);
      if (error) console.warn(`[process-account-deletion] auth.users delete 경고 ${authUserId}:`, error.message);
    } catch (e) {
      console.warn(`[process-account-deletion] auth.users delete 예외 ${authUserId}:`, e.message);
    }
  }

  // 마지막으로 sellers row 삭제
  const { error: delErr } = await admin.from('sellers').delete().eq('id', seller.id);
  if (delErr) {
    throw new Error(`sellers delete 실패: ${delErr.message}`);
  }
}

exports.handler = async (event) => {
  // Netlify scheduled background: event 객체가 거의 비어있음
  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[process-account-deletion] admin client 초기화 실패:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: '서버 설정 오류' }) };
  }

  const nowIso = new Date().toISOString();

  // 만족 후보 조회 (sellers 에 user_id 컬럼이 없어도 안전 — email 기반 auth 매핑)
  const { data: rows, error: selErr } = await admin
    .from('sellers')
    .select('id, owner_name, email, deletion_scheduled_at')
    .lte('deletion_scheduled_at', nowIso)
    .not('deletion_requested_at', 'is', null)
    .is('deletion_cancelled_at', null)
    .limit(PROCESS_LIMIT);

  if (selErr) {
    console.error('[process-account-deletion] select 실패:', selErr.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'select 실패' }) };
  }

  const list = rows || [];
  console.log(`[process-account-deletion] 처리 대상 ${list.length}건 (now=${nowIso})`);

  let success = 0;
  let failed = 0;

  for (const seller of list) {
    try {
      // 1) 최종 삭제 알림 (실패해도 cascade 진행)
      if (seller.email) {
        await sendFinalEmail({ to: seller.email, ownerName: seller.owner_name });
      }
      // 2) cascade
      await deleteSellerCascade(admin, seller);
      success += 1;
      console.log(`[process-account-deletion] seller=${seller.id.slice(0, 8)} 영구 삭제 완료`);
    } catch (e) {
      failed += 1;
      console.error(`[process-account-deletion] seller=${seller.id.slice(0, 8)} 실패:`, e.message);
      // 다음 row 계속
    }
  }

  console.log(`[process-account-deletion] 완료 success=${success} failed=${failed}`);
  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, processed: list.length, ok: success, failed }),
  };
};
