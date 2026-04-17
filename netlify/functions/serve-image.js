const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  // img 태그, Instagram Graph API 등에서 헤더 없이 호출되므로 인증 없이 key prefix만 검증
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
  if (!key || !key.startsWith('temp-img:')) {
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
