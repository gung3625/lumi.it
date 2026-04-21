// check-slug — GET, 익명 허용 (Bearer 있으면 본인 소유 제외)
// query: slug=<string>
// 응답: { available: boolean, reason?: string }
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$|^[a-z0-9]{2,32}$/;
const RESERVED = new Set([
  'api','p','admin','dashboard','subscribe','support','privacy','terms',
  'settings','login','signup','ig-guide','guide','office','calendar','link',
]);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const slug = String((event.queryStringParameters || {}).slug || '').toLowerCase().trim();
  if (!slug) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ available: false, reason: 'empty' }) };
  }
  if (!SLUG_RE.test(slug)) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ available: false, reason: 'format' }) };
  }
  if (RESERVED.has(slug)) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ available: false, reason: 'reserved' }) };
  }

  // 본인 소유 제외: Bearer 있으면 현재 유저 조회
  let selfId = null;
  try {
    const token = extractBearerToken(event);
    if (token) {
      const { user } = await verifyBearerToken(token);
      if (user) selfId = user.id;
    }
  } catch {}

  try {
    const admin = getAdminClient();
    let q = admin.from('link_pages').select('user_id').eq('slug', slug);
    const { data, error } = await q.maybeSingle();
    if (error) {
      console.error('[check-slug] select error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회 실패' }) };
    }
    if (!data) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ available: true }) };
    }
    if (selfId && data.user_id === selfId) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ available: true, self: true }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ available: false, reason: 'taken' }) };
  } catch (err) {
    console.error('[check-slug] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
