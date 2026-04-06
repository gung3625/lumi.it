const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // JSON과 form-urlencoded 둘 다 처리
  let email, caption, secret;
  const contentType = event.headers['content-type'] || '';

  try {
    if (contentType.includes('application/json')) {
      const body = JSON.parse(event.body);
      email = body.email;
      caption = body.caption;
      secret = body.secret;
    } else {
      // form-urlencoded (Make.com Key-Value 방식)
      const params = new URLSearchParams(event.body);
      email = params.get('email');
      caption = params.get('caption');
      secret = params.get('secret');
    }
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.', detail: e.message }) };
  }

  if (secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: '인증 실패' }) };
  }

  if (!email || !caption) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email, caption 필수' }) };
  }

  try {
    const store = getStore({
      name: 'users', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN
    });

    let history = [];
    try {
      const raw = await store.get('caption-history:' + email);
      if (raw) history = JSON.parse(raw);
    } catch { history = []; }

    const newEntry = {
      id: Date.now(),
      caption: caption.trim(),
      createdAt: new Date().toISOString(),
      feedback: null
    };
    history.unshift(newEntry);
    if (history.length > 20) history = history.slice(0, 20);

    await store.set('caption-history:' + email, JSON.stringify(history));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, captionId: newEntry.id })
    };
  } catch (err) {
    console.error('save-caption error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장 실패', detail: err.message }) };
  }
};
