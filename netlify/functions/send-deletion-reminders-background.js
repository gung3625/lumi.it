// 회원 탈퇴 유예기간 reminder cron
// schedule: 0 0 * * *  (UTC 00:00 = KST 09:00)
//
// 두 가지 reminder:
//   - 7일 전: deletion_scheduled_at - now BETWEEN 6일12시 ~ 7일12시
//             AND deletion_reminder_sent_at IS NULL  (한 번만)
//   - 1일 전: deletion_scheduled_at - now BETWEEN 12시 ~ 1일12시
//             (별도 가드 컬럼 없음 — 24h cron 이라 자연스럽게 1번만 발송됨)
//
// 발송 후 deletion_reminder_sent_at = now() 갱신 (7일 reminder 가드).
// 1일 reminder 는 7일 reminder 발송 흔적과 무관하게 윈도우 매칭 시 발송.

const { getAdminClient } = require('./_shared/supabase-admin');

const PROCESS_LIMIT = 200;

function buildReminderHtml({ ownerName, daysLeft, scheduledIso }) {
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
    <h1 style="margin:0 0 16px;font-size:20px;color:#191F28;line-height:1.4;">${daysLeft}일 후 계정이 영구 삭제돼요</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#4E5968;line-height:1.7;">${safeName}, 회원 탈퇴 유예기간이 ${daysLeft}일 남았어요. 이 기간이 지나면 모든 데이터가 영구 삭제되고 복구할 수 없어요.</p>
    <div style="margin:0 0 24px;padding:16px 20px;background:#FFF5F8;border-radius:12px;">
      <p style="margin:0 0 4px;font-size:13px;color:#888;">자동 삭제 예정 시각</p>
      <p style="margin:0;font-size:16px;font-weight:700;color:#C8507A;">${scheduledKr}</p>
    </div>
    <h2 style="margin:0 0 12px;font-size:16px;color:#191F28;">아직 복구할 수 있어요</h2>
    <p style="margin:0 0 20px;font-size:14px;color:#4E5968;line-height:1.7;">루미에 다시 로그인하면 화면 상단의 <b>복구하기</b> 버튼으로 즉시 되돌릴 수 있어요.</p>
    <a href="https://lumi.it.kr/" style="display:inline-block;padding:12px 24px;background:#C8507A;color:#fff;text-decoration:none;border-radius:980px;font-size:14px;font-weight:600;">루미 다시 방문하기</a>
    <p style="margin:24px 0 0;font-size:12px;color:#999;line-height:1.6;">본인이 요청한 작업이 아니라면 즉시 lumi@lumi.it.kr 로 알려주세요.</p>
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #eee;font-size:11px;color:#999;line-height:1.6;">
    <p style="margin:0;">발신: 루미(lumi) | 사업자등록번호: 404-09-66416 | 문의: lumi@lumi.it.kr</p>
  </td></tr>
</table>
</body></html>`;
}

async function sendReminderEmail({ to, ownerName, daysLeft, scheduledIso }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return { skipped: true };
  try {
    const html = buildReminderHtml({ ownerName, daysLeft, scheduledIso });
    const subject = daysLeft === 1
      ? '[lumi] 내일 계정이 영구 삭제됩니다 (마지막 안내)'
      : `[lumi] ${daysLeft}일 후 계정이 영구 삭제됩니다`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: 'lumi <noreply@lumi.it.kr>',
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[send-deletion-reminders] Resend 실패:', res.status, text.slice(0, 200));
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error('[send-deletion-reminders] Resend 예외:', e.message);
    return { ok: false };
  }
}

exports.handler = async () => {
  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[send-deletion-reminders] admin client 초기화 실패:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: '서버 설정 오류' }) };
  }

  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // 7일 reminder 윈도우: now + 6.5d ~ now + 7.5d, reminder 미발송
  const win7Start = new Date(now + 6 * DAY + 12 * HOUR).toISOString();
  const win7End = new Date(now + 7 * DAY + 12 * HOUR).toISOString();
  // 1일 reminder 윈도우: now + 12h ~ now + 1d 12h
  const win1Start = new Date(now + 12 * HOUR).toISOString();
  const win1End = new Date(now + 1 * DAY + 12 * HOUR).toISOString();

  // 후보 select — pending row 만 한 번에 가져와서 두 윈도우 분기
  const { data: rows, error: selErr } = await admin
    .from('sellers')
    .select('id, owner_name, email, deletion_scheduled_at, deletion_reminder_sent_at')
    .not('deletion_requested_at', 'is', null)
    .is('deletion_cancelled_at', null)
    .gte('deletion_scheduled_at', win1Start)  // 이미 만료된 row 제외
    .lte('deletion_scheduled_at', win7End)
    .limit(PROCESS_LIMIT);

  if (selErr) {
    console.error('[send-deletion-reminders] select 실패:', selErr.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'select 실패' }) };
  }

  const list = rows || [];
  let sent7 = 0;
  let sent1 = 0;
  let failed = 0;

  for (const seller of list) {
    try {
      const sched = seller.deletion_scheduled_at ? new Date(seller.deletion_scheduled_at).getTime() : 0;
      if (!sched) continue;
      const isWin7 = sched >= new Date(win7Start).getTime() && sched <= new Date(win7End).getTime() && !seller.deletion_reminder_sent_at;
      const isWin1 = sched >= new Date(win1Start).getTime() && sched <= new Date(win1End).getTime();

      if (!seller.email) continue;

      if (isWin7) {
        await sendReminderEmail({
          to: seller.email,
          ownerName: seller.owner_name,
          daysLeft: 7,
          scheduledIso: seller.deletion_scheduled_at,
        });
        // 7일 reminder 발송 흔적 기록
        await admin.from('sellers')
          .update({ deletion_reminder_sent_at: new Date().toISOString() })
          .eq('id', seller.id);
        sent7 += 1;
        console.log(`[send-deletion-reminders] 7일 reminder seller=${seller.id.slice(0, 8)}`);
      } else if (isWin1) {
        await sendReminderEmail({
          to: seller.email,
          ownerName: seller.owner_name,
          daysLeft: 1,
          scheduledIso: seller.deletion_scheduled_at,
        });
        // 1일 reminder 는 별도 가드 없음 — 24h cron 윈도우 자체가 가드
        sent1 += 1;
        console.log(`[send-deletion-reminders] 1일 reminder seller=${seller.id.slice(0, 8)}`);
      }
    } catch (e) {
      failed += 1;
      console.error(`[send-deletion-reminders] seller=${seller.id.slice(0, 8)} 실패:`, e.message);
    }
  }

  console.log(`[send-deletion-reminders] 완료 candidates=${list.length} sent7=${sent7} sent1=${sent1} failed=${failed}`);
  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, candidates: list.length, sent7, sent1, failed }),
  };
};
