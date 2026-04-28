// scheduled-insight-weekly-background.js — 주간 인사이트 자동 생성 + 발송
//
// 스케줄: 매주 월요일 KST 09:00 (= UTC 일요일 00:00) — netlify.toml
// 인증: x-lumi-secret 헤더 (메모리 reference_cron_manual_trigger.md)
// 가드: runGuarded (heartbeat / stage / error)
//
// 동작:
//   1. 활성 셀러 목록 조회 (sellers 테이블, status='active')
//   2. 각 셀러별 buildReport({ reportType: 'weekly' })
//   3. 보고서 summary를 알림톡(Solapi) 또는 이메일(Resend)로 발송
//   4. 비용 한도/실패는 셀러별 격리 — 한 셀러 실패가 전체 멈추지 않음

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
const ALIMTALK_TEMPLATE_ID = process.env.ALIMTALK_INSIGHT_WEEKLY_TEMPLATE || 'KA01TP_INSIGHT_WEEKLY';
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
        subject: `[루미] 주간 AI 인사이트 (${periodLabel})`,
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
    console.error('[insight-weekly-cron] sellers 조회 실패:', e.message);
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
      // notification_opt_in이 명시 false인 셀러는 발송 스킵 (보고서는 생성)
      const optIn = seller.notification_opt_in !== false;

      const r = await buildReport({
        admin: supa,
        sellerId: seller.id,
        reportType: 'weekly',
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

      // 보고서에 발송 상태 갱신 (best effort)
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
      console.error(`[insight-weekly-cron] 셀러 ${seller.id} 처리 실패: ${e.message}`);
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
  name: 'scheduled-insight-weekly',
  handler: mainHandler,
});
