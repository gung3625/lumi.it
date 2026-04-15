const { Resend } = require('resend');
const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // IP rate limit: 10분 5회
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown');
  try {
    const rlStore = getStore({ name: 'rate-limit', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    const rlKey = 'otp:' + ip;
    const rlRaw = await rlStore.get(rlKey).catch(() => null);
    const rl = rlRaw ? JSON.parse(rlRaw) : { count: 0, firstAt: Date.now() };
    if (Date.now() - rl.firstAt > 600000) { rl.count = 0; rl.firstAt = Date.now(); }
    rl.count++;
    await rlStore.set(rlKey, JSON.stringify(rl));
    if (rl.count > 5) {
      return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'OTP 요청이 너무 많습니다. 10분 후 다시 시도해주세요.' }) };
    }
  } catch(e) {}

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

  // 이메일 중복 체크 (비밀번호 찾기 등에서는 skipDuplicateCheck=true)
  if (!skipDuplicateCheck) {
    try {
      const userStore = getStore({
        name: 'users', consistency: 'strong',
        siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
        token: process.env.NETLIFY_TOKEN
      });
      const existing = await userStore.get('user:' + email);
      if (existing) {
        return {
          statusCode: 409,
          headers: CORS,
          body: JSON.stringify({ error: '이미 가입된 이메일이에요. 로그인해주세요.' })
        };
      }
    } catch(e) { /* users store 접근 실패 시 무시하고 진행 */ }
  }

  // 6자리 OTP 생성
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10분 유효

  // Netlify Blobs에 저장
  try {
    const store = getStore({
      name: 'otp-store',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });
    await store.set('otp:' + email, JSON.stringify({ otp, expiresAt }));
  } catch (err) {
    console.error('Blobs error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'OTP 저장에 실패했습니다.' }) };
  }

  // Resend로 이메일 발송
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
    console.error('Resend error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' })
    };
  }
};
