const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const token = event.headers['x-admin-token'] || event.queryStringParameters?.token;
  if (token !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
  }

  const store = getStore({
    name: 'beta-applicants',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
  const list = await store.list();

  const applicants = await Promise.all(
    list.blobs.map(async (b) => {
      try { return await store.get(b.key, { type: 'json' }); }
      catch { return null; }
    })
  );

  const valid = applicants.filter(Boolean).sort((a, b) =>
    new Date(b.appliedAt) - new Date(a.appliedAt)
  );

  return {
    statusCode: 200, headers,
    body: JSON.stringify({ count: valid.length, max: 20, applicants: valid }),
  };
};
