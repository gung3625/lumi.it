// admin-apply-launch-migrations.js — 베타 출시 SQL 마이그레이션 일괄 실행기
// POST /api/admin-apply-launch-migrations
// 인증: x-lumi-secret 헤더 또는 Authorization: Bearer ${LUMI_SECRET}

const { Client } = require('pg');
const { verifyLumiSecret, corsHeaders, getOrigin } = require('./_shared/auth');
const fs = require('fs');
const path = require('path');

const FILES = [
  '2026-04-28-dashboard-chat-redesign.sql',
  '2026-04-28-return-history.sql',
  '2026-04-28-settlement.sql',
  '2026-04-28-insights.sql',
  '2026-04-29-atomic-rate-limit-rpc.sql',
  '2026-04-29-order-seller-memo.sql',
  '2026-04-29-sprint-4-dashboard-trend.sql',
];

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

  // SQL 파일 전체 읽기 (연결 전)
  const sqls = [];
  for (const file of FILES) {
    const sqlPath = path.join(__dirname, '..', '..', 'migrations', file);
    try {
      const sql = fs.readFileSync(sqlPath, 'utf8');
      sqls.push({ file, sql });
    } catch (readErr) {
      console.error(`[admin-apply-launch-migrations] SQL 파일 읽기 실패: ${file}`);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: `SQL 파일 읽기 실패: ${file}` }),
      };
    }
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

  const connErrors = [];
  let client = null;
  let connLabel = null;

  for (const [label, connStr] of attempts) {
    const c = new Client({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 3000,
    });
    try {
      await c.connect();
      client = c;
      connLabel = label;
      console.log(`[admin-apply-launch-migrations] connected via ${label}`);
      break;
    } catch (e) {
      connErrors.push(`${label}: ${e.message}`);
      try { await c.end(); } catch (_) {}
    }
  }

  if (!client) {
    const dbg = `direct_host=${direct.hostname} ref=${ref}`;
    console.error(`[admin-apply-launch-migrations] DB 연결 실패: ${dbg} | ${connErrors.join(' | ')}`);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '마이그레이션 적용 실패' }) };
  }

  // 각 SQL 순차 실행 — 실패해도 계속 진행 (idempotent SQL이므로 재실행 안전)
  const results = [];
  for (const { file, sql } of sqls) {
    try {
      await client.query(sql);
      console.log(`[admin-apply-launch-migrations] 적용 완료: ${file}`);
      results.push({ file, ok: true });
    } catch (e) {
      console.error(`[admin-apply-launch-migrations] 적용 실패: ${file}`);
      results.push({ file, ok: false, error: e.message });
    }
  }

  try { await client.end(); } catch (_) {}

  const allOk = results.every((r) => r.ok);
  console.log(`[admin-apply-launch-migrations] 완료 via ${connLabel} — ${results.filter(r => r.ok).length}/${results.length} 성공`);

  return {
    statusCode: allOk ? 200 : 207,
    headers,
    body: JSON.stringify({ success: allOk, results }),
  };
};
