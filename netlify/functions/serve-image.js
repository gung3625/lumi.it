const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  // img 태그, Instagram Graph API 등에서 헤더 없이 호출되므로 key prefix로 구분
  // b64key 우선 (Netlify redirect /ig-img/:encoded.jpg → serve-image?b64key=:encoded)
  const qp = event.queryStringParameters || {};
  let key = qp.key;
  if (!key && qp.b64key) {
    try {
      const raw = qp.b64key.replace(/\.jpg$/i, '');
      const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
      key = Buffer.from(b64, 'base64').toString('utf8');
    } catch {}
  }
  // /ig-img/{b64}.jpg 리라이트 경로에서 추출 (Netlify splat이 query 치환 안됨)
  if (!key && event.path) {
    const m = event.path.match(/\/([^\/]+?)(?:\.jpg)?\/?$/i);
    if (m && m[1] && m[1] !== 'serve-image') {
      try {
        const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        key = Buffer.from(b64, 'base64').toString('utf8');
      } catch {}
    }
  }

  if (!key) {
    return { statusCode: 400, body: 'invalid key' };
  }

  // last-post: prefix — 인증 + 이메일 바운드 검증
  if (key.startsWith('last-post:')) {
    // img 태그는 헤더 전달 불가 → ?t= 쿼리 파라미터도 허용 (Authorization 헤더 우선)
    const authHeader = event.headers['authorization'] || '';
    const bearerToken = (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '') || (qp.t || '');
    if (!bearerToken) {
      return { statusCode: 401, body: 'unauthorized' };
    }

    // 토큰 → 이메일 검증
    let tokenEmail = null;
    try {
      const userStore = getStore({
        name: 'users',
        siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
        token: process.env.NETLIFY_TOKEN,
      });
      const tokenRaw = await userStore.get('token:' + bearerToken).catch(() => null);
      if (!tokenRaw) return { statusCode: 401, body: 'unauthorized' };
      const tokenData = JSON.parse(tokenRaw);
      if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
        return { statusCode: 401, body: 'token expired' };
      }
      tokenEmail = tokenData.email || null;
    } catch (e) {
      console.error('[serve-image] token 검증 실패:', e.message);
      return { statusCode: 401, body: 'unauthorized' };
    }

    // key 내 이메일 추출: last-post:{email}:{index}
    // email은 마지막 콜론+숫자 앞까지
    const keyParts = key.slice('last-post:'.length); // "{email}:{index}"
    const lastColon = keyParts.lastIndexOf(':');
    const keyEmail = lastColon >= 0 ? keyParts.slice(0, lastColon) : keyParts;
    if (keyEmail !== tokenEmail) {
      return { statusCode: 403, body: 'forbidden' };
    }

    try {
      const lpStore = getStore({
        name: 'last-post-images',
        consistency: 'strong',
        siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
        token: process.env.NETLIFY_TOKEN,
      });
      const data = await lpStore.get(key, { type: 'arrayBuffer' });
      if (!data) return { statusCode: 404, body: 'not found' };
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
        body: Buffer.from(data).toString('base64'),
        isBase64Encoded: true,
      };
    } catch (err) {
      console.error('[serve-image] last-post error:', err.message);
      return { statusCode: 500, body: 'error' };
    }
  }

  if (!key.startsWith('temp-img:')) {
    return { statusCode: 400, body: 'invalid key' };
  }

  try {
    const store = getStore({
      name: 'temp-images',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    const data = await store.get(key, { type: 'arrayBuffer' });
    if (!data) {
      return { statusCode: 404, body: 'not found' };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=3600',
      },
      body: Buffer.from(data).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('serve-image error:', err.message);
    return { statusCode: 500, body: 'error' };
  }
};
