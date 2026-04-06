const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
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
    const store = getStore({
      name: 'otp-store',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    const raw = await store.get(`otp:${email}`);
    if (!raw) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '인증번호가 만료되었거나 존재하지 않습니다.' }) };
    }

    const { otp: savedOtp, expiresAt } = JSON.parse(raw);

    if (Date.now() > expiresAt) {
      await store.delete(`otp:${email}`);
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '인증번호가 만료되었습니다. 다시 요청해주세요.' }) };
    }

    if (otp !== savedOtp) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '인증번호가 올바르지 않습니다.' }) };
    }

    // 인증 성공 — 사용된 OTP 삭제
    await store.delete(`otp:${email}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, message: '이메일 인증이 완료되었습니다.' })
    };

  } catch (err) {
    console.error('verify-otp error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '인증 처리 중 오류가 발생했습니다.' })
    };
  }
};
