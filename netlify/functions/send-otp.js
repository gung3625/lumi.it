const { Resend } = require('resend');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email } = body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: '이메일 형식이 올바르지 않습니다.' }) };
  }

  // 6자리 OTP 생성
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10분 유효

  // Netlify Blobs에 저장
  try {
    const store = getStore('otp-store');
    await store.set('otp:' + email, JSON.stringify({ otp, expiresAt }));
  } catch (err) {
    console.error('Blobs error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'OTP 저장에 실패했습니다.' }) };
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: '인증번호를 발송했습니다.' })
    };
  } catch (err) {
    console.error('Resend error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' })
    };
  }
};
