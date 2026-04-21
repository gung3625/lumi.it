// 관리자 전용 DB 마이그레이션 실행기 — docs/sql/ 내 SQL 파일을 이름으로 지정해 실행.
// 인증: Authorization: Bearer ${LUMI_SECRET}. 허용 파일명 화이트리스트로 제한.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// 허용된 마이그레이션 파일명 화이트리스트 (임의 SQL 실행 차단)
const ALLOWED = new Set([
  'promo_schedule.sql',
  'link_in_bio.sql',
]);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST 전용' }) };
  }

  const auth = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '');
  if (!process.env.LUMI_SECRET || auth !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
  }

  try {
    const { file } = JSON.parse(event.body || '{}');
    if (!file || typeof file !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'file 필드 필요' }) };
    }
    if (!ALLOWED.has(file)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '허용되지 않은 파일', allowed: Array.from(ALLOWED) }) };
    }

    const sqlPath = path.join(__dirname, '..', '..', 'docs', 'sql', file);
    if (!fs.existsSync(sqlPath)) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'SQL 파일을 찾을 수 없음' }) };
    }
    const sql = fs.readFileSync(sqlPath, 'utf8');

    const client = new Client({
      connectionString: process.env.SUPABASE_DB_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }

    console.log(`[admin-apply-migration] applied: ${file}`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, file }) };
  } catch (err) {
    console.error('[admin-apply-migration] 예외:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || '실행 실패' }) };
  }
};
