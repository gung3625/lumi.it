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

    // Netlify AWS 런타임은 direct DB 호스트(db.*.supabase.co)를 IPv6 전용이라 resolve 실패.
    // SUPABASE_DB_URL을 pooler URL로 변환: 호스트→aws-0-ap-northeast-2.pooler.supabase.com, 유저→postgres.<REF>.
    const direct = new URL(process.env.SUPABASE_DB_URL);
    const ref = direct.hostname.replace(/^db\./, '').split('.')[0];
    const poolerUrl = `postgresql://postgres.${ref}:${direct.password}@aws-0-ap-northeast-2.pooler.supabase.com:5432${direct.pathname}`;

    let lastErr;
    let applied = false;
    for (const connStr of [poolerUrl, process.env.SUPABASE_DB_URL]) {
      const client = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
      try {
        await client.connect();
        await client.query(sql);
        applied = true;
        await client.end();
        break;
      } catch (e) {
        lastErr = e;
        try { await client.end(); } catch (_) {}
      }
    }
    if (!applied) throw lastErr || new Error('DB 연결 실패');

    console.log(`[admin-apply-migration] applied: ${file}`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, file }) };
  } catch (err) {
    console.error('[admin-apply-migration] 예외:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || '실행 실패' }) };
  }
};
