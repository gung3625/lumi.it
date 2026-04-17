const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
  }

  const token = authHeader.slice(7);

  try {
    const usersStore = getStore({
      name: 'users', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    const tokenData = await usersStore.get('token:' + token);
    if (!tokenData) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: '인증 실패' }) };
    }

    const parsed = JSON.parse(tokenData);
    const email = parsed.email;
    if (!email) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: '인증 실패' }) };
    }

    const calStore = getStore({
      name: 'calendars', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    const raw = await calStore.get('cal:' + email);
    if (!raw) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ calendar: null }) };
    }

    const data = JSON.parse(raw);

    // 7일 만료 체크
    if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ calendar: null, expired: true }) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(data)
    };

  } catch (e) {
    console.error('get-calendar error:', e.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: '캘린더 조회 중 오류가 발생했습니다.' })
    };
  }
};
