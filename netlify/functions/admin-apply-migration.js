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
  'reservations_tone_rated.sql': `
alter table public.reservations add column if not exists tone_rated boolean not null default false;
create index if not exists idx_reservations_pending_rating
  on public.reservations(user_id, created_at desc)
  where caption_status='posted' and is_sent=true and tone_rated=false;
`,
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

    // Netlify AWS 런타임은 direct DB 호스트(db.*.supabase.co) IPv6 전용이라 resolve 실패.
    // 프로젝트 리전이 불명확해서 pooler 리전을 브루트포스.
    const direct = new URL(process.env.SUPABASE_DB_URL);
    const ref = direct.hostname.replace(/^db\./, '').split('.')[0];
    const REGIONS = [
      'ap-northeast-2', 'ap-northeast-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-south-1',
      'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
      'eu-west-1', 'eu-west-2', 'eu-central-1', 'sa-east-1', 'ca-central-1',
    ];
    const attempts = [];
    for (const r of REGIONS) {
      for (const prefix of ['aws-1', 'aws-0']) {
        attempts.push([
          `${prefix}-${r}`,
          `postgresql://postgres.${ref}:${direct.password}@${prefix}-${r}.pooler.supabase.com:5432${direct.pathname}`,
        ]);
      }
    }

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
        console.log(`[admin-apply-migration] connected via ${label}`);
        break;
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
        try { await client.end(); } catch (_) {}
      }
    }
    if (!applied) {
      // 디버그: 실제 host와 ref 공개 (비밀번호는 제외).
      const dbg = `direct_host=${direct.hostname} ref=${ref} supabase_url=${process.env.SUPABASE_URL || ''}`;
      throw new Error(`${dbg} | ${errors.join(' | ')}`);
    }

    console.log(`[admin-apply-migration] applied: ${file}`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, file }) };
  } catch (err) {
    console.error('[admin-apply-migration] 예외:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || '실행 실패' }) };
  }
};
