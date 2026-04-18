// 만료 임박 알림 (cron)
// public.users 에서 trial_start 기준 만료 임박 사용자 → Resend 이메일
// service role 사용 (RLS 우회, 개인정보 로그 금지)
const { Resend } = require('resend');
const { getAdminClient } = require('./_shared/supabase-admin');

// 체험 기간 기본 7일 (schema users.trial_start 기반)
const TRIAL_DAYS = 7;

// 알림 타이밍 설정 (만료일까지 남은 일수 → 메시지)
const NOTICE_RULES = [
  { daysUntilExpiry: 7,  key: 'd7',  subject: '플랜이 7일 후 만료됩니다', heading: '플랜 만료 7일 전이에요', body: '지금 갱신하시면 서비스가 끊기지 않아요.' },
  { daysUntilExpiry: 3,  key: 'd3',  subject: '플랜 만료가 3일 남았어요', heading: '플랜 만료까지 3일!', body: '서비스 이용이 곧 중단됩니다. 미리 갱신해주세요.' },
  { daysUntilExpiry: 1,  key: 'd1',  subject: '내일 플랜이 만료됩니다', heading: '플랜 만료 하루 전이에요', body: '내일 자정 이후 서비스 이용이 제한됩니다.' },
];

function getTodayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

// 만료일까지 남은 일수 (KST 기준, expiryIso = trial_start + TRIAL_DAYS)
function getDaysUntilExpiry(expiryIso) {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayMidnight = new Date(kst.toISOString().slice(0, 10) + 'T00:00:00Z');
  const expiryMidnight = new Date(expiryIso.slice(0, 10) + 'T00:00:00Z');
  return Math.round((expiryMidnight - todayMidnight) / (1000 * 60 * 60 * 24));
}

function buildEmailHtml({ heading, body, userName }) {
  return `
    <div style="font-family:Pretendard,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
      <div style="text-align:center;margin-bottom:32px;">
        <span style="font-size:28px;font-weight:900;color:#C8507A;">lumi</span>
      </div>
      <h2 style="font-size:20px;font-weight:700;color:#1a1a2e;margin-bottom:8px;">${heading}</h2>
      <p style="color:#666;margin-bottom:8px;">${userName}님, ${body}</p>
      <div style="background:#fff0f6;border-radius:16px;padding:24px;text-align:center;margin:24px 0;">
        <p style="font-size:15px;color:#C8507A;font-weight:700;margin:0 0 8px 0;">지금 갱신하면 서비스가 끊기지 않아요</p>
        <p style="font-size:13px;color:#999;margin:0;">대시보드에서 바로 갱신할 수 있어요.</p>
      </div>
      <div style="text-align:center;margin:32px 0;">
        <a href="https://lumi.it.kr/subscribe"
           style="display:inline-block;padding:14px 40px;background:#C8507A;color:#fff;font-size:16px;font-weight:700;border-radius:980px;text-decoration:none;">
          지금 갱신하기
        </a>
      </div>
      <p style="font-size:13px;color:#999;">본인이 요청하지 않았다면 이 메일을 무시하세요.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
      <p style="font-size:12px;color:#ccc;text-align:center;">lumi — 소상공인 SNS 자동화 서비스</p>
    </div>
  `;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // 스케줄 함수 또는 수동 호출
  const isScheduled = !event.httpMethod && !event.headers;
  if (!isScheduled) {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers, body: '' };
    }
    const secret = event.headers?.['x-lumi-secret'];
    if (secret !== process.env.LUMI_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
    }
  }

  if (!process.env.RESEND_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '메일 설정 오류입니다.' }) };
  }

  const admin = getAdminClient();
  const resend = new Resend(process.env.RESEND_API_KEY);
  const todayStr = getTodayKST();

  try {
    // trial_start + TRIAL_DAYS 가 내일~일주일 내인 유저 조회
    // 필터 범위: now - TRIAL_DAYS + 1day ≤ trial_start ≤ now - TRIAL_DAYS + 7day
    //   (즉, 만료까지 1~7일 남은 경우)
    const now = Date.now();
    const MS_DAY = 24 * 60 * 60 * 1000;
    const earliestStart = new Date(now - (TRIAL_DAYS - 1) * MS_DAY).toISOString();       // 만료 1일 전
    const latestStart = new Date(now - (TRIAL_DAYS - 7) * MS_DAY).toISOString();         // 만료 7일 전

    const { data: candidates, error: queryErr } = await admin
      .from('users')
      .select('id, email, name, store_name, plan, trial_start')
      .neq('plan', 'trial')
      .not('trial_start', 'is', null)
      .gte('trial_start', earliestStart)
      .lte('trial_start', latestStart);

    if (queryErr) {
      console.error('[check-expiry] users 쿼리 오류:', queryErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) };
    }

    let sent = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of (candidates || [])) {
      try {
        if (!row.email || !row.trial_start) { skipped++; continue; }

        // 만료일 = trial_start + TRIAL_DAYS
        const expiry = new Date(new Date(row.trial_start).getTime() + TRIAL_DAYS * MS_DAY).toISOString();
        const daysLeft = getDaysUntilExpiry(expiry);
        const rule = NOTICE_RULES.find(r => r.daysUntilExpiry === daysLeft);
        if (!rule) { skipped++; continue; }

        // 중복 발송 방지 기록 필드가 스키마에 없음 → 동일 사용자에게 하루 1회 제약을
        // 외부에서 관리할 수 없는 상황. 현재는 cron 주기 1일 전제(현 send-notifications
        // 패턴 참조)로 단순 발송.
        const userName = row.store_name || row.name || '고객';
        await resend.emails.send({
          from: 'lumi <noreply@lumi.it.kr>',
          to: row.email,
          subject: `[lumi] ${rule.subject}`,
          html: buildEmailHtml({
            heading: rule.heading,
            body: rule.body,
            userName,
          }),
        });

        sent++;
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error('[check-expiry] 발송 실패:', e.message);
        errors++;
      }
    }

    console.log('[check-expiry] 완료:', { date: todayStr, sent, skipped, errors });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, sent, skipped, errors }),
    };
  } catch (err) {
    console.error('[check-expiry] error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }),
    };
  }
};
