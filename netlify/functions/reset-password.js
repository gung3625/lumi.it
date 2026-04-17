const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, password, otpToken } = body;
  if (!email || !password) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: '필수 정보가 없습니다.' }) };
  if (!otpToken) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'OTP 인증이 필요합니다.' }) };
  const pwRegex = /^(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{10,}$/;
  if (!pwRegex.test(password)) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: '비밀번호는 특수문자를 포함한 10자 이상이어야 합니다.' }) };

  try {
    const store = getStore({ name: 'users', consistency: 'strong' });

    // OTP 토큰 검증
    let otpRaw;
    try { otpRaw = await store.get('otp-verified:' + email); } catch(e) { otpRaw = null; }
    if (!otpRaw) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'OTP 인증을 먼저 완료해주세요.' }) };
    const otpData = JSON.parse(otpRaw);
    if (otpData.token !== otpToken) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'OTP 인증 정보가 유효하지 않습니다.' }) };
    // 10분 유효
    if (Date.now() - new Date(otpData.verifiedAt).getTime() > 10 * 60 * 1000) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'OTP 인증이 만료됐습니다. 다시 인증해주세요.' }) };
    }

    let raw;
    try { raw = await store.get('user:' + email); } catch(e) { raw = null; }
    if (!raw) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: '가입되지 않은 이메일입니다.' }) };

    const user = JSON.parse(raw);
    user.passwordHash = hashPassword(password);
    user.passwordUpdatedAt = new Date().toISOString();
    await store.set('user:' + email, JSON.stringify(user));

    // OTP 인증 정보 삭제 (일회용)
    try { await store.delete('otp-verified:' + email); } catch(e) {}

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, message: '비밀번호가 변경됐어요.' }) };
  } catch (err) {
    console.error('reset-password error:', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: '비밀번호 변경 중 오류가 발생했습니다.' }) };
  }
};
