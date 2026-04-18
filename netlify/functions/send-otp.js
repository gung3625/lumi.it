const { Resend } = require('resend');
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

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
  const rl = await checkRateLimit(supabase, 'otp', ip, { windowSeconds: 600, max: 10 });
  if (!rl.ok) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'OTP 요청이 너무 많습니다. 10분 후 다시 시도해주세요.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, skipDuplicateCheck } = body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이메일 형식이 올바르지 않습니다.' }) };
  }

  // 이메일 중복 체크 (비번 찾기 등에서는 skipDuplicateCheck=true)
  if (!skipDuplicateCheck) {
    try {
      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .maybeSingle();
      if (existing) {
        return {
          statusCode: 409,
          headers: CORS,
          body: JSON.stringify({ error: '이미 가입된 이메일이에요. 로그인해주세요.' })
        };
      }
    } catch (e) { /* 조회 실패 시 진행 */ }
  }

  // 6자리 OTP 생성
  const otp = String(crypto.randomInt(100000, 999999));
  const nonceKey = 'otp:' + email;

  // oauth_nonces 테이블을 단기 OTP 저장소로 재사용 (10분 TTL)
  // lumi_token 필드에 JSON { otp, expiresAt } 저장
  try {
    const payload = JSON.stringify({ otp, expiresAt: Date.now() + 10 * 60 * 1000 });
    // 기존 동일 키 삭제 후 insert
    await supabase.from('oauth_nonces').delete().eq('nonce', nonceKey);
    const { error: insErr } = await supabase.from('oauth_nonces').insert({
      nonce: nonceKey,
      lumi_token: payload,
    });
    if (insErr) throw insErr;
  } catch (err) {
    console.error('[send-otp] store error:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'OTP 저장에 실패했습니다.' }) };
  }

  // Resend 이메일 발송 (기존 플로우 유지)
  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    await resend.emails.send({
      from: 'lumi <noreply@lumi.it.kr>',
      to: email,
      subject: '[lumi] 이메일 인증번호',
      html: `
        <div style="font-family:'Noto Sans KR',sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
          <div style="text-align:center;margin-bottom:32px;">
            <span style="font-size:28px;font-weight:900;color:#FF6B9D;">lumi</span>
          </div>
          <h2 style="font-size:20px;font-weight:700;color:#1a1a2e;margin-bottom:8px;">이메일 인증번호</h2>
          <p style="color:#666;margin-bottom:24px;">아래 인증번호를 입력해 주세요. 10분 후 만료됩니다.</p>
          <div style="background:#fff0f6;border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
            <span style="font-size:40px;font-weight:900;letter-spacing:12px;color:#FF6B9D;">${otp}</span>
          </div>
          <p style="font-size:13px;color:#999;">본인이 요청하지 않았다면 이 메일을 무시하세요.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="font-size:12px;color:#ccc;text-align:center;">lumi — 소상공인 SNS 자동화 서비스</p>
        </div>
      `
    });
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, message: '인증번호를 발송했습니다.' })
    };
  } catch (err) {
    console.error('Resend error:', err && err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' })
    };
  }
};
