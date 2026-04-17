const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const store = getStore({
    name: 'auto-replies', consistency: 'strong'
  });

  // GET: 설정 불러오기
  if (event.httpMethod === 'GET') {
    try {
      // 토큰으로 이메일 확인
      const authHeader = event.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 필요' }) };

      const tokenStore = getStore({ name: 'users', consistency: 'strong' });
      const tokenData = await tokenStore.get('token:' + token);
      if (!tokenData) return { statusCode: 401, headers, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };

      const { email } = JSON.parse(tokenData);
      const raw = await store.get('reply:' + email);
      const data = raw ? JSON.parse(raw) : { comment: { keywords: [], defaultReply: '' }, dm: { keywords: [], defaultReply: '' } };

      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch(e) {
      console.error('save-auto-reply GET error:', e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '오류가 발생했습니다.' }) };
    }
  }

  // POST: 설정 저장
  if (event.httpMethod === 'POST') {
    try {
      const authHeader = event.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 필요' }) };

      const tokenStore = getStore({ name: 'users', consistency: 'strong' });
      const tokenData = await tokenStore.get('token:' + token);
      if (!tokenData) return { statusCode: 401, headers, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };

      const { email } = JSON.parse(tokenData);
      const body = JSON.parse(event.body);

      // 스키마 검증: 허용 필드만 저장
      const sanitized = {};
      if (Array.isArray(body.commentRules)) {
        sanitized.commentRules = body.commentRules.slice(0, 20).map(r => ({
          keyword: String(r.keyword || '').slice(0, 100),
          reply: String(r.reply || '').slice(0, 500)
        }));
      }
      if (Array.isArray(body.dmRules)) {
        sanitized.dmRules = body.dmRules.slice(0, 20).map(r => ({
          keyword: String(r.keyword || '').slice(0, 100),
          reply: String(r.reply || '').slice(0, 500)
        }));
      }
      if (typeof body.commentEnabled === 'boolean') sanitized.commentEnabled = body.commentEnabled;
      if (typeof body.dmEnabled === 'boolean') sanitized.dmEnabled = body.dmEnabled;

      await store.set('reply:' + email, JSON.stringify(sanitized));

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } catch(e) {
      console.error('save-auto-reply POST error:', e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '저장 중 오류가 발생했습니다.' }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
};
