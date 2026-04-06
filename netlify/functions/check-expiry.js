const { Resend } = require('resend');
const { getStore } = require('@netlify/blobs');

// 알림 타이밍 설정 (만료일 기준 일수 → 메시지)
const NOTICE_RULES = [
  { daysUntilExpiry: 7,  key: 'd7',  subject: '플랜이 7일 후 만료됩니다', heading: '플랜 만료 7일 전이에요', body: '지금 갱신하시면 서비스가 끊기지 않아요.' },
  { daysUntilExpiry: 3,  key: 'd3',  subject: '플랜 만료가 3일 남았어요', heading: '플랜 만료까지 3일!', body: '서비스 이용이 곧 중단됩니다. 미리 갱신해주세요.' },
  { daysUntilExpiry: 0,  key: 'd0',  subject: '오늘 플랜이 만료됩니다', heading: '오늘 플랜이 만료돼요', body: '오늘 자정 이후 서비스 이용이 제한됩니다.' },
  { daysUntilExpiry: -1, key: 'd-1', subject: '플랜이 만료됐어요. 갱신하세요', heading: '플랜이 만료되었습니다', body: '갱신하시면 바로 다시 이용할 수 있어요.' },
];

// 오늘 날짜 문자열 (KST 기준, YYYY-MM-DD)
function getTodayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

// 만료일까지 남은 일수 계산 (KST 기준)
function getDaysUntilExpiry(planExpireAt) {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayMidnight = new Date(kst.toISOString().slice(0, 10) + 'T00:00:00Z');
  const expiryMidnight = new Date(planExpireAt.slice(0, 10) + 'T00:00:00Z');
  return Math.round((expiryMidnight - todayMidnight) / (1000 * 60 * 60 * 24));
}

// 이메일 HTML 템플릿
function buildEmailHtml({ heading, body, userName }) {
  return `
    <div style="font-family:'Noto Sans KR',sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
      <div style="text-align:center;margin-bottom:32px;">
        <span style="font-size:28px;font-weight:900;color:#FF6B9D;">lumi</span>
      </div>
      <h2 style="font-size:20px;font-weight:700;color:#1a1a2e;margin-bottom:8px;">${heading}</h2>
      <p style="color:#666;margin-bottom:8px;">${userName}님, ${body}</p>
      <div style="background:#fff0f6;border-radius:16px;padding:24px;text-align:center;margin:24px 0;">
        <p style="font-size:15px;color:#FF6B9D;font-weight:700;margin:0 0 8px 0;">🎉 연간 플랜으로 갱신하면 20% 할인!</p>
        <p style="font-size:13px;color:#999;margin:0;">더 저렴하게 lumi를 이용해보세요.</p>
      </div>
      <div style="text-align:center;margin:32px 0;">
        <a href="https://lumi.it.kr/subscribe"
           style="display:inline-block;padding:14px 40px;background:#FF6B9D;color:#fff;font-size:16px;font-weight:700;border-radius:12px;text-decoration:none;">
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
  const isScheduled = !event.httpMethod;
  if (!isScheduled) {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers, body: '' };
    }
    const secret = event.headers?.['x-lumi-secret'];
    if (secret !== process.env.LUMI_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
    }
  }

  try {
    const store = getStore({
      name: 'users',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });

    const resend = new Resend(process.env.RESEND_API_KEY);
    const todayStr = getTodayKST();
    const { blobs } = await store.list({ prefix: 'user:' });

    let sent = 0;
    let skipped = 0;
    let errors = 0;

    for (const blob of blobs) {
      try {
        const raw = await store.get(blob.key);
        if (!raw) continue;
        const user = JSON.parse(raw);

        // planExpireAt 필드가 없으면 스킵
        if (!user.planExpireAt || !user.email) continue;

        const daysLeft = getDaysUntilExpiry(user.planExpireAt);
        const rule = NOTICE_RULES.find(r => r.daysUntilExpiry === daysLeft);
        if (!rule) continue;

        // 중복 발송 방지: 같은 날 같은 key로 이미 발송했으면 스킵
        const noticeTag = `${todayStr}:${rule.key}`;
        if (user.lastExpiryNotice === noticeTag) {
          skipped++;
          continue;
        }

        const userName = user.storeName || user.name || '고객';

        await resend.emails.send({
          from: 'lumi <noreply@lumi.it.kr>',
          to: user.email,
          subject: `[lumi] ${rule.subject}`,
          html: buildEmailHtml({
            heading: rule.heading,
            body: rule.body,
            userName,
          }),
        });

        // 발송 기록 저장
        user.lastExpiryNotice = noticeTag;
        await store.set(blob.key, JSON.stringify(user));
        sent++;

        // Resend rate limit 대비
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error('[check-expiry] 발송 실패:', blob.key, e.message);
        errors++;
      }
    }

    console.log('[lumi] check-expiry 완료:', { sent, skipped, errors });
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
      body: JSON.stringify({ error: err.message }),
    };
  }
};
