const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  // 인증: Bearer 토큰 또는 LUMI_SECRET
  const authHeader = event.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const secret = event.headers['x-lumi-secret'] || '';
  if (!bearerToken && secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, body: 'unauthorized' };
  }

  const key = event.queryStringParameters?.key;
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
