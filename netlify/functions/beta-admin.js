// 베타 신청자 조회(관리자) — Supabase 기반
// - LUMI_SECRET 인증(timingSafeEqual)
// - IP 기반 rate_limits 테이블로 실패 횟수 제한
// - public.beta_applicants + public.beta_waitlist 조회
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
};

function checkSecret(provided) {
  const secret = process.env.LUMI_SECRET;
  if (!secret) return false;
  try { return crypto.timingSafeEqual(Buffer.from(provided || ''), Buffer.from(secret)); }
  catch { return false; }
}

async function recordAdminFail(supabase, ip) {
  const kind = 'beta-admin';
  const nowIso = new Date().toISOString();
  try {
    const { data: existing } = await supabase
      .from('rate_limits')
      .select('count, first_at')
      .eq('kind', kind)
      .eq('ip', ip)
      .maybeSingle();

    if (existing) {
      const age = Date.now() - new Date(existing.first_at).getTime();
      if (age > 600000) {
        await supabase.from('rate_limits')
          .update({ count: 1, first_at: nowIso, last_at: nowIso })
          .eq('kind', kind).eq('ip', ip);
        return { count: 1, windowMs: 0 };
      }
      const nextCount = existing.count + 1;
      await supabase.from('rate_limits')
        .update({ count: nextCount, last_at: nowIso })
        .eq('kind', kind).eq('ip', ip);
      return { count: nextCount, windowMs: age };
    }
    await supabase.from('rate_limits').insert({ kind, ip, count: 1, first_at: nowIso, last_at: nowIso });
    return { count: 1, windowMs: 0 };
  } catch (e) {
    return { count: 0, windowMs: 0 };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const token = event.headers['x-admin-token'] || (event.headers['authorization'] || '').replace('Bearer ', '');
  if (!checkSecret(token)) {
    const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown');
    try {
      const supabase = getAdminClient();
      const { count, windowMs } = await recordAdminFail(supabase, ip);
      if (count >= 5 && windowMs < 600000) {
        return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: '너무 많은 시도입니다. 잠시 후 다시 시도해주세요.' }) };
      }
    } catch (e) { /* noop */ }
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 실패' }) };
  }

  try {
    const supabase = getAdminClient();

    const { data: applicants, error: appErr } = await supabase
      .from('beta_applicants')
      .select('id, name, store_name, store_type, phone, insta, referral, utm, applied_at')
      .order('applied_at', { ascending: false });

    if (appErr) {
      console.error('[beta-admin] 조회 실패:', appErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회 실패' }) };
    }

    const list = applicants || [];
    const normalized = list.map(r => ({
      id: r.id,
      name: r.name,
      store: r.store_name,
      type: r.store_type,
      phone: r.phone,
      insta: r.insta,
      referral: r.referral,
      utm: r.utm,
      appliedAt: r.applied_at,
    }));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ count: normalized.length, max: 20, applicants: normalized }),
    };
  } catch (e) {
    console.error('[beta-admin] 오류:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회 실패' }) };
  }
};
