// 관리자 전용 DB 마이그레이션 실행기 — 인라인 SQL 딕셔너리에서 이름으로 지정.
// 인증: Authorization: Bearer ${LUMI_SECRET}. SQL은 본 파일에 하드코딩해 임의 실행 차단.
const { Client } = require('pg');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// 마이그레이션 SQL — 이름 → SQL 본문. 새 마이그레이션 추가 시 여기 등록.
const MIGRATIONS = {
  'promo_schedule.sql': `
create table if not exists public.promo_schedule (
  id bigserial primary key,
  scheduled_at timestamptz not null,
  image_url text not null,
  caption text not null,
  label text,
  status text not null default 'pending',
  post_id text,
  last_error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_promo_schedule_pending
  on public.promo_schedule(scheduled_at)
  where status='pending';
`,
};

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
    const sql = MIGRATIONS[file];
    if (!sql) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '허용되지 않은 마이그레이션', allowed: Object.keys(MIGRATIONS) }) };
    }

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
