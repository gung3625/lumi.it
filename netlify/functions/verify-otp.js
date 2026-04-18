const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

async function checkRateLimit(supabase, kind, ip, { windowSeconds = 600, max = 10 } = {}) {
  const nowIso = new Date().toISOString();
  try {
    const { data: existing } = await supabase
      .from('rate_limits')
      .select('count, first_at')
      .eq('kind', kind)
      .eq('ip', ip)
      .maybeSingle();

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
  } catch (e) {
    return { ok: true, count: 0 };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabase = getAdminClient();
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown');
  const rl = await checkRateLimit(supabase, 'verify-otp', ip, { windowSeconds: 600, max: 10 });
  if (!rl.ok) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: '시도가 너무 많습니다. 10분 후 다시 시도해주세요.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, otp } = body;
  if (!email || !otp) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이메일과 인증번호를 입력하세요.' }) };
  }

  try {
    const nonceKey = 'otp:' + email;
    const { data: row } = await supabase
      .from('oauth_nonces')
      .select('nonce, lumi_token')
      .eq('nonce', nonceKey)
      .maybeSingle();

    if (!row || !row.lumi_token) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '인증번호가 만료되었거나 존재하지 않습니다.' }) };
    }

    let saved;
    try { saved = JSON.parse(row.lumi_token); } catch { saved = null; }
    if (!saved || !saved.otp || !saved.expiresAt) {
      await supabase.from('oauth_nonces').delete().eq('nonce', nonceKey);
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '인증번호가 만료되었거나 존재하지 않습니다.' }) };
    }

    if (Date.now() > saved.expiresAt) {
      await supabase.from('oauth_nonces').delete().eq('nonce', nonceKey);
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '인증번호가 만료되었습니다. 다시 요청해주세요.' }) };
    }

    if (String(otp) !== String(saved.otp)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '인증번호가 올바르지 않습니다.' }) };
    }

    // 인증 성공 — 기존 OTP 삭제 후, 후속 인증 토큰 발급(reset-password 등에서 사용)
    await supabase.from('oauth_nonces').delete().eq('nonce', nonceKey);

    const otpToken = crypto.randomBytes(32).toString('hex');
    const verifiedKey = 'otp-verified:' + email;
    const verifiedPayload = JSON.stringify({
      token: otpToken,
      verifiedAt: new Date().toISOString(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    try {
      await supabase.from('oauth_nonces').delete().eq('nonce', verifiedKey);
      await supabase.from('oauth_nonces').insert({ nonce: verifiedKey, lumi_token: verifiedPayload });
    } catch (e) {
      console.error('[verify-otp] verified store error:', e && e.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, message: '이메일 인증이 완료되었습니다.', otpToken })
    };

  } catch (err) {
    console.error('verify-otp error:', err && err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '인증 처리 중 오류가 발생했습니다.' })
    };
  }
};
