// admin-apply-regions-migration.js — Trend Hub 지역 분할 마이그레이션 (004)
// POST /api/admin-apply-regions-migration
// 인증: x-lumi-secret 헤더 또는 Authorization: Bearer ${LUMI_SECRET}

const { Client } = require('pg');
const { verifyLumiSecret, corsHeaders, getOrigin } = require('./_shared/auth');
const fs = require('fs');
const path = require('path');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST 전용' }) };
  }

  const secretHeader = event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'] || '';
  const bearerHeader = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '');
  const provided = secretHeader || bearerHeader;

  if (!verifyLumiSecret(provided)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
  }

  try {
    const sqlPath = path.join(__dirname, '..', '..', 'migrations', '004-trend-regions.sql');
    let sql;
    try {
      sql = fs.readFileSync(sqlPath, 'utf8');
    } catch (readErr) {
      console.error('[admin-apply-regions-migration] SQL 파일 읽기 실패:', readErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'SQL 파일 읽기 실패' }) };
    }

    const direct = new URL(process.env.SUPABASE_DB_URL);
    const ref = direct.hostname.replace(/^db\./, '').split('.')[0];
    const pwd = direct.password;
    const attempts = [
      ['aws-1-ap-northeast-2', `postgresql://postgres.${ref}:${pwd}@aws-1-ap-northeast-2.pooler.supabase.com:5432${direct.pathname}`],
      ['aws-0-ap-northeast-2', `postgresql://postgres.${ref}:${pwd}@aws-0-ap-northeast-2.pooler.supabase.com:5432${direct.pathname}`],
      ['aws-1-ap-northeast-1', `postgresql://postgres.${ref}:${pwd}@aws-1-ap-northeast-1.pooler.supabase.com:5432${direct.pathname}`],
      ['aws-0-us-east-1',      `postgresql://postgres.${ref}:${pwd}@aws-0-us-east-1.pooler.supabase.com:5432${direct.pathname}`],
    ];

    const errors = [];
    let applied = false;
    for (const [label, connStr] of attempts) {
      const client = new Client({
        connectionString: connStr,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 3000,
      });
      try {
        await client.connect();
        await client.query(sql);
        applied = true;
        await client.end();
        console.log(`[admin-apply-regions-migration] connected via ${label}`);
        break;
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
        try { await client.end(); } catch (_) {}
      }
    }

    if (!applied) {
      const dbg = `direct_host=${direct.hostname} ref=${ref}`;
      console.error(`[admin-apply-regions-migration] DB 연결 실패: ${dbg} | ${errors.join(' | ')}`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '마이그레이션 적용 실패' }) };
    }

    console.log('[admin-apply-regions-migration] 004-trend-regions.sql 적용 완료');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, file: '004-trend-regions.sql' }),
    };
  } catch (err) {
    console.error('[admin-apply-regions-migration] 예외:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '마이그레이션 적용 실패' }) };
  }
};
