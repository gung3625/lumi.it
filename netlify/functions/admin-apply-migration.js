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
  'store_context.sql': `
create table if not exists public.store_context (
  user_id uuid primary key references auth.users(id) on delete cascade,
  store_name text,
  address text,
  phone text,
  hours jsonb default '{}'::jsonb,
  menu_or_services text,
  parking text,
  reservation_url text,
  directions text,
  tone text default '친근',
  custom_notes text,
  updated_at timestamptz not null default now()
);
create index if not exists idx_store_context_updated on public.store_context(updated_at desc);
`,
  'pgrst_reload.sql': `
notify pgrst, 'reload schema';
`,
  'auto_reply_tables.sql': `
-- auto_reply_settings: 사장님별 자동응답 설정
create table if not exists public.auto_reply_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  shadow_mode boolean not null default true,
  keyword_rules jsonb not null default '[]'::jsonb,
  default_comment_reply text default '감사합니다 😊 궁금한 점은 DM으로 문의해 주세요!',
  default_dm_reply text default '안녕하세요! 메시지 감사해요 😊',
  negative_keyword_blocklist text[] not null default array['비싸','별로','불만','환불','최악','맛없','이상해','짜증','실망'],
  ai_mode boolean not null default false,
  ai_confidence_threshold numeric not null default 0.85,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- auto_reply_log: 모든 수신/판정/응답 로그
create table if not exists public.auto_reply_log (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  ig_user_id text,
  event_type text not null,
  received_text text,
  sender_id text,
  category text,
  sub_category text,
  sentiment text,
  confidence numeric,
  replied boolean not null default false,
  reply_text text,
  escalated boolean not null default false,
  escalation_reason text,
  shadow_mode boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_auto_reply_log_user_created
  on public.auto_reply_log(user_id, created_at desc);
create index if not exists idx_auto_reply_log_escalated
  on public.auto_reply_log(user_id, created_at desc)
  where escalated = true;
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
