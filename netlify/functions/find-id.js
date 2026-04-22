const { getAdminClient } = require('./_shared/supabase-admin');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

// fail-closed 전환: 재시도 후에도 실패하면 429 차단.
async function checkRateLimit(supabase, kind, ip, { windowSeconds = 600, max = 5 } = {}) {
  const nowIso = new Date().toISOString();
  async function runOnce() {
    const { data: existing, error: selErr } = await supabase
      .from('rate_limits')
      .select('count, first_at')
      .eq('kind', kind)
      .eq('ip', ip)
      .maybeSingle();
    if (selErr) throw selErr;

    if (existing) {
      const age = (Date.now() - new Date(existing.first_at).getTime()) / 1000;
      if (age > windowSeconds) {
        await supabase.from('rate_limits')
          .update({ count: 1, first_at: nowIso, last_at: nowIso })
          .eq('kind', kind).eq('ip', ip);
        return { ok: true, count: 1 };
      }
      const nextCount = existing.count + 1;
      await supabase.from('rate_limits')
        .update({ count: nextCount, last_at: nowIso })
        .eq('kind', kind).eq('ip', ip);
      return { ok: nextCount <= max, count: nextCount };
    }
    await supabase.from('rate_limits').insert({ kind, ip, count: 1, first_at: nowIso, last_at: nowIso });
    return { ok: true, count: 1 };
  }

  try {
    return await runOnce();
  } catch (e1) {
    console.error(`[rate-limit:${kind}] 1차 실패, 재시도:`, e1.message);
    try {
      return await runOnce();
    } catch (e2) {
      console.error(`[rate-limit:${kind}] 2차 실패 — fail-closed 차단:`, e2.message);
      return { ok: false, count: 0, failClosed: true };
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabase = getAdminClient();
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown');
  const rl = await checkRateLimit(supabase, 'find-id', ip, { windowSeconds: 600, max: 5 });
  if (!rl.ok) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: '너무 많은 시도입니다. 10분 후 다시 시도해주세요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { name, phone, birthdate } = body;

  if (!name || !phone || !birthdate) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이름, 전화번호, 생년월일을 모두 입력해주세요.' }) };
  }

  try {
    const { data: match, error } = await supabase
      .from('users')
      .select('email')
      .eq('name', name)
      .eq('phone', phone)
      .eq('birthdate', birthdate)
      .maybeSingle();

    if (error) {
      console.error('[find-id] query error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) };
    }

    if (!match || !match.email) {
      return {
        statusCode: 404,
        headers: CORS,
        body: JSON.stringify({ error: '일치하는 회원 정보를 찾을 수 없습니다.' })
      };
    }

    // 이메일 마스킹 (예: a***@g***.com) — 로컬 첫 1자 + 도메인 첫 1자만 노출
    // 전체 이메일 공개 시 스팸·피싱 표적 위험 (보안 감사 권고).
    const [localPart = '', domain = ''] = match.email.split('@');
    const maskedLocal = (localPart.slice(0, 1) || '') + '***';
    const dotIdx = domain.indexOf('.');
    const domainHead = dotIdx > 0 ? domain.slice(0, 1) : (domain.slice(0, 1) || '');
    const domainTail = dotIdx > 0 ? domain.slice(dotIdx) : '';
    const maskedDomain = domainHead ? (domainHead + '***' + domainTail) : '';
    const maskedEmail = maskedLocal + '@' + maskedDomain;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, email: maskedEmail })
    };
  } catch (err) {
    console.error('find-id error:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) };
  }
};
