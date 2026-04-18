const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'text/html; charset=utf-8',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: '<p>Method not allowed</p>' };
  }

  try {
    const params = event.queryStringParameters || {};
    const email = params.email;
    const token = params.token;

    if (!email || !token) {
      return { statusCode: 400, headers, body: buildPage('잘못된 요청', '유효하지 않은 수신거부 링크입니다.') };
    }

    let valid = false;
    if (token.includes(':')) {
      const [hmacPart, tsPart] = token.split(':');
      const ts = parseInt(tsPart);
      if (ts && (Date.now() - ts) < 30 * 24 * 60 * 60 * 1000) {
        const expected = crypto.createHmac('sha256', process.env.LUMI_SECRET).update(email + ':' + tsPart).digest('hex');
        if (hmacPart === expected) valid = true;
      }
    }
    if (!valid) {
      const legacyExpected = crypto.createHmac('sha256', process.env.LUMI_SECRET).update(email).digest('hex');
      if (token === legacyExpected) valid = true;
    }
    if (!valid) {
      return { statusCode: 403, headers, body: buildPage('인증 실패', '유효하지 않은 수신거부 링크입니다.') };
    }

    const admin = getAdminClient();
    const { data: updated, error } = await admin
      .from('users')
      .update({ retention_unsubscribed: true, updated_at: new Date().toISOString() })
      .eq('email', email)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('unsubscribe-retention db error:', error.message);
      return { statusCode: 500, headers, body: buildPage('오류 발생', '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.') };
    }
    if (!updated) {
      return { statusCode: 404, headers, body: buildPage('사용자 없음', '해당 이메일로 등록된 사용자를 찾을 수 없습니다.') };
    }

    return { statusCode: 200, headers, body: buildPage('수신 해제 완료', '리텐션 이메일 수신이 해제되었습니다.<br>더 이상 마케팅 이메일을 받지 않으실 거예요.') };
  } catch (err) {
    console.error('unsubscribe-retention error:', err.message);
    return { statusCode: 500, headers, body: buildPage('오류 발생', '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.') };
  }
};

function buildPage(title, message) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} - lumi</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9f9f9; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
    .card { background: #fff; border-radius: 16px; padding: 48px 32px; text-align: center; max-width: 420px; width: 100%; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
    .logo { font-size: 28px; font-weight: 800; color: #C8507A; margin-bottom: 24px; letter-spacing: -0.5px; }
    h1 { font-size: 20px; color: #191F28; margin-bottom: 12px; }
    p { font-size: 15px; color: #4E5968; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">lumi</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}
