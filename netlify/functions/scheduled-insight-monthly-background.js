// scheduled-insight-monthly-background.js — 월간 인사이트 자동 생성 + 발송
//
// 스케줄: 매월 1일 KST 09:00 (= UTC 0일 00:00) — netlify.toml
// 발송 채널: 알림톡 → 이메일 fallback
//
// 주간 cron과 동일한 패턴, reportType='monthly' / 템플릿 별도

const crypto = require('crypto');
const { runGuarded } = require('./_shared/cron-guard');
const { getAdminClient } = require('./_shared/supabase-admin');
const { buildReport } = require('./_shared/insight-builder');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const SOLAPI_API_KEY = process.env.SOLAPI_API_KEY;
const SOLAPI_API_SECRET = process.env.SOLAPI_API_SECRET;
const SOLAPI_CHANNEL_ID = 'KA01PF26032219112677567W26lSNGQj';
const ALIMTALK_TEMPLATE_ID = process.env.ALIMTALK_INSIGHT_MONTHLY_TEMPLATE || 'KA01TP_INSIGHT_MONTHLY';
const RESEND_KEY = process.env.RESEND_API_KEY;

function solapiAuthHeader() {
  const date = new Date().toISOString();
  const salt = Math.random().toString(36).substring(2, 12);
  const signature = crypto
    .createHmac('sha256', SOLAPI_API_SECRET)
    .update(date + salt)
    .digest('hex');
  return `HMAC-SHA256 apiKey=${SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function sendAlimtalk(phone, summary, periodLabel) {
  if (!SOLAPI_API_KEY || !SOLAPI_API_SECRET || !phone) return { ok: false, reason: 'no_config' };
  try {
    const body = {
      message: {
        to: phone,
        from: SOLAPI_CHANNEL_ID,
        type: 'ATA',
        kakaoOptions: {
          pfId: SOLAPI_CHANNEL_ID,
          templateId: ALIMTALK_TEMPLATE_ID,
          variables: {
            '#{period}': periodLabel,
            '#{summary}': (summary || '').slice(0, 200),
          },
        },
      },
    };
    const res = await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': solapiAuthHeader() },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function sendEmailFallback(email, summary, periodLabel) {
  if (!RESEND_KEY || !email) return { ok: false, reason: 'no_config' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'Lumi <hello@lumi.it.kr>',
        to: [email],
        subject: `[루미] 월간 AI 인사이트 (${periodLabel})`,
        html: `<p>${(summary || '').replace(/</g, '&lt;')}</p><p style="color:#888;font-size:12px">대시보드에서 전체 보고서를 확인하실 수 있어요.</p>`,
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function deliverReport(supa, seller, summary, periodLabel) {
  let channel = 'dashboard_only';
  let status = 'pending';

  if (seller.phone) {
    const r = await sendAlimtalk(seller.phone, summary, periodLabel);
    if (r.ok) { channel = 'alimtalk'; status = 'sent'; }
    else if (seller.email) {
      const e = await sendEmailFallback(seller.email, summary, periodLabel);
      if (e.ok) { channel = 'email'; status = 'sent'; }
    }
  } else if (seller.email) {
    const e = await sendEmailFallback(seller.email, summary, periodLabel);
    if (e.ok) { channel = 'email'; status = 'sent'; }
  }

  return { channel, status };
}

async function fetchActiveSellers(supa) {
  try {
    const { data } = await supa
      .from('sellers')
      .select('id, business_name, phone, email, status, notification_opt_in')
      .eq('status', 'active')
      .limit(1000);
    return data || [];
  } catch (e) {
    console.error('[insight-monthly-cron] sellers 조회 실패:', e.message);
    return [];
  }
}

async function mainHandler(event, ctx) {
  const secret = (event.headers && (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'])) || '';
  if (!process.env.LUMI_SECRET || secret !== process.env.LUMI_SECRET) {
    return {
      statusCode: 401,
      headers: HEADERS,
      body: JSON.stringify({ error: '인증 실패' }),
    };
  }

  const supa = getAdminClient();
  const sellers = await fetchActiveSellers(supa);
  await ctx.stage('init', { totalSellers: sellers.length });

  const result = { generated: 0, delivered: 0, skipped_cost: 0, errors: 0, total: sellers.length };

  for (const seller of sellers) {
    try {
      const optIn = seller.notification_opt_in !== false;

      const r = await buildReport({
        admin: supa,
        sellerId: seller.id,
        reportType: 'monthly',
      });

      if (!r.ok) {
        if ((r.error || '').includes('한도')) result.skipped_cost++;
        else result.errors++;
        continue;
      }
      result.generated++;

      if (!optIn) continue;

      const periodLabel = r.report?.period || r.period?.label || '';
      const summary = r.report?.summary || '';

      const delivery = await deliverReport(supa, seller, summary, periodLabel);
      if (delivery.status === 'sent') result.delivered++;

      if (r.reportId) {
        try {
          await supa.from('insight_reports').update({
            delivered_at: new Date().toISOString(),
            delivery_channel: delivery.channel,
            delivery_status: delivery.status,
          }).eq('id', r.reportId);
        } catch (_) { /* silent */ }
      }
    } catch (e) {
      console.error(`[insight-monthly-cron] 셀러 ${seller.id} 처리 실패: ${e.message}`);
      result.errors++;
    }
  }

  await ctx.stage('done', result);

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true,
      ...result,
      completedAt: new Date().toISOString(),
    }),
  };
}

exports.handler = runGuarded({
  name: 'scheduled-insight-monthly',
  handler: mainHandler,
});
