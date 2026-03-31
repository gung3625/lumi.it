const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const key = event.queryStringParameters?.key;
  if (!key) {
    return { statusCode: 400, body: 'key 필수' };
  }

  try {
    const store = getStore({
      name: 'temp-images',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID,
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
