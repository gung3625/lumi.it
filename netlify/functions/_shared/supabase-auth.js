// Bearer token verification helper.
// Wraps supabase.auth.getUser(token) and returns { user, error }.
const { createClient } = require('@supabase/supabase-js');

let cached = null;

function getAuthClient() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Supabase 환경변수(SUPABASE_URL / SUPABASE_ANON_KEY)가 설정되지 않았습니다.');
  }
  cached = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Verify a Bearer token and return the associated user.
 * @param {string} token - Supabase access_token (JWT)
 * @returns {Promise<{ user: object|null, error: Error|null }>}
 */
async function verifyBearerToken(token) {
  if (!token) return { user: null, error: new Error('토큰이 없습니다.') };
  try {
    const client = getAuthClient();
    const { data, error } = await client.auth.getUser(token);
    if (error) return { user: null, error };
    if (!data || !data.user) return { user: null, error: new Error('유효하지 않은 토큰입니다.') };
    return { user: data.user, error: null };
  } catch (err) {
    return { user: null, error: err };
  }
}

/**
 * Extract Bearer token from Netlify event headers.
 * @param {object} event
 * @returns {string}
 */
function extractBearerToken(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  return auth.replace(/^Bearer\s+/i, '');
}

module.exports = { verifyBearerToken, extractBearerToken, getAuthClient };
