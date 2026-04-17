const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  // 마이그레이션: 600000으로 먼저 시도, 실패 시 구버전 10000으로 재시도
  const verify600k = crypto.pbkdf2Sync(password, salt, 600000, 64, 'sha512').toString('hex');
  if (verify600k === hash) return true;
  const verify10k = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return verify10k === hash;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  // IP rate limit: 10분 내 10회 제한
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown');
  try {
    const rlStore = getStore({ name: 'rate-limit', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    const rlKey = 'login:' + ip;
    const rlRaw = await rlStore.get(rlKey).catch(() => null);
    const rl = rlRaw ? JSON.parse(rlRaw) : { count: 0, firstAt: Date.now() };
    if (Date.now() - rl.firstAt > 600000) { rl.count = 0; rl.firstAt = Date.now(); }
    rl.count++;
    await rlStore.set(rlKey, JSON.stringify(rl));
    if (rl.count > 10) {
      return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: '로그인 시도가 너무 많습니다. 10분 후 다시 시도해주세요.' }) };
    }
  } catch(e) {}

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, password } = body;
  if (!email || !password) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이메일과 비밀번호를 입력하세요.' }) };
  }

  try {
    const store = getStore({
      name: 'users', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    // 3회 재시도 — PAT rate limit(429) → Blobs 401 → catch → null 이 되는 과민반응 방지
    let raw = null;
    let blobError = false;
    for (let i = 0; i < 3; i++) {
      blobError = false;
      try { raw = await store.get('user:' + email); }
      catch(e) { blobError = true; console.error('[login] blob fetch error:', e.message); }
      if (raw) break;
      if (!blobError) break; // 진짜 없음: 재시도 의미 없음
      if (i < 2) await new Promise(r => setTimeout(r, 300));
    }
    if (!raw) {
      if (blobError) {
        return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: '일시적 서버 오류입니다. 잠시 후 다시 시도해주세요.' }) };
      }
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '가입되지 않은 이메일입니다.' }) };
    }

    const user = JSON.parse(raw);

    // 비밀번호 해시 없으면 반드시 로그인 차단
    if (!user.passwordHash) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '비밀번호를 다시 설정해주세요.' }) };
    }

    // 비밀번호 검증
    if (!verifyPassword(password, user.passwordHash)) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '비밀번호가 올바르지 않습니다.' }) };
    }

    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await store.set('token:' + token, JSON.stringify({ email, createdAt: new Date().toISOString(), expiresAt }));

    const { passwordHash, ...safeUser } = user;

    // ig 연동 여부 — user 객체에 저장된 값 그대로 사용
    // (save-ig-token에서 user:이메일에 igConnected: true 저장함)
    if (!safeUser.igUserId) {
      safeUser.igConnected = false;
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, token, user: safeUser })
    };
  } catch (err) {
    console.error('login error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '로그인 처리 중 오류가 발생했습니다.' }) };
  }
};
