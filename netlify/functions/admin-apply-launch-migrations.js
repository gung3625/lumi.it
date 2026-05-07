// admin-apply-launch-migrations.js
// 일회성 마이그레이션 적용 엔드포인트 — 적용 후 즉시 삭제 예정
// POST /api/admin/apply-launch-migrations
// Header: x-lumi-secret: <LUMI_SECRET>
//
// Netlify infra는 IPv6 OK → SUPABASE_DB_URL(db.*.supabase.co) 직접 연결 가능

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATIONS = [
  '20260501000007_tiktok_accounts.sql',
  '20260501000008_brand_library_tables.sql',
  '20260501000009_reservations_brand_auto_columns.sql',
  '20260501000010_users_is_admin_column.sql',
  '20260506000001_tiktok_accounts_updated_at.sql',
  '20260506000002_sellers_signup_columns.sql',
];

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // secret 검증
  const secret = event.headers['x-lumi-secret'];
  if (!secret || secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'SUPABASE_DB_URL not set' }) };
  }

  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 30000 });

  try {
    await client.connect();
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'DB connect failed', detail: err.message }),
    };
  }

  const results = [];

  for (const filename of MIGRATIONS) {
    const sqlPath = path.join(__dirname, '..', '..', 'supabase', 'migrations', filename);
    let sql;
    try {
      sql = fs.readFileSync(sqlPath, 'utf8');
    } catch (err) {
      results.push({ migration: filename, status: 'fail', error: `File read error: ${err.message}` });
      continue;
    }

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      results.push({ migration: filename, status: 'ok' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      results.push({ migration: filename, status: 'fail', error: err.message });
    }
  }

  await client.end().catch(() => {});

  const allOk = results.every((r) => r.status === 'ok');
  return {
    statusCode: allOk ? 200 : 207,
    headers,
    body: JSON.stringify({ results }),
  };
};
