// 관리자 전용 DB 마이그레이션 실행기 — 인라인 SQL 딕셔너리에서 이름으로 지정.
// 인증: Authorization: Bearer ${LUMI_SECRET}. SQL은 본 파일에 하드코딩해 임의 실행 차단.
const { Client } = require('pg');
const { verifyLumiSecret } = require('./_shared/auth');


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
  'auto_reply_learning.sql': `
-- 평가·수정 필드
alter table public.auto_reply_log
  add column if not exists rating smallint,
  add column if not exists corrected_reply text,
  add column if not exists feedback_note text,
  add column if not exists rated_at timestamptz;

create index if not exists idx_auto_reply_log_rated
  on public.auto_reply_log(user_id, rated_at desc)
  where rating is not null;

create index if not exists idx_auto_reply_log_pending
  on public.auto_reply_log(user_id, created_at desc)
  where rating is null;

-- 학습 샘플 테이블 (few-shot 주입용)
create table if not exists public.auto_reply_corrections (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  category text,
  customer_message text not null,
  correct_reply text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_arc_user_cat
  on public.auto_reply_corrections(user_id, category, created_at desc);
create index if not exists idx_arc_user_recent
  on public.auto_reply_corrections(user_id, created_at desc);
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
  'auth_users_sync.sql': `
-- auth.users → public.users 영구 동기화

-- 1) handle_auth_user_sync 함수: auth.users INSERT/UPDATE 시 public.users upsert
create or replace function public.handle_auth_user_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, created_at)
  values (new.id, new.email, coalesce(new.created_at, now()))
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

-- 2) trigger: auth.users INSERT 시
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_sync();

-- 3) trigger: auth.users UPDATE 시 (이메일 변경 등)
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email on auth.users
  for each row execute function public.handle_auth_user_sync();

-- 4) 백필: 현재 누락된 auth.users 를 public.users에 일괄 insert
insert into public.users (id, email, created_at)
select au.id, au.email, au.created_at
from auth.users au
left join public.users pu on pu.id = au.id
where pu.id is null
on conflict (id) do nothing;
`,
  'security_hardening.sql': `
-- RLS 정책 보강 + FK CASCADE 조정 + 탈퇴 감사 로그 + 마스킹 뷰
-- Part 1. auto_reply_log.user_id FK → on delete cascade
do $$
begin
  if to_regclass('public.auto_reply_log') is not null then
    execute 'alter table public.auto_reply_log drop constraint if exists auto_reply_log_user_id_fkey';
    execute $sql$
      alter table public.auto_reply_log
        add constraint auto_reply_log_user_id_fkey
        foreign key (user_id) references auth.users(id) on delete cascade
    $sql$;
  end if;
end $$;

-- Part 2. 누락 테이블 RLS enable + 4종 정책
do $$
begin
  if to_regclass('public.auto_reply_settings') is not null then
    execute 'alter table public.auto_reply_settings enable row level security';
    execute 'drop policy if exists "auto_reply_settings_select_own" on public.auto_reply_settings';
    execute 'drop policy if exists "auto_reply_settings_insert_own" on public.auto_reply_settings';
    execute 'drop policy if exists "auto_reply_settings_update_own" on public.auto_reply_settings';
    execute 'drop policy if exists "auto_reply_settings_delete_own" on public.auto_reply_settings';
    execute 'create policy "auto_reply_settings_select_own" on public.auto_reply_settings for select using (auth.uid() = user_id)';
    execute 'create policy "auto_reply_settings_insert_own" on public.auto_reply_settings for insert with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_settings_update_own" on public.auto_reply_settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_settings_delete_own" on public.auto_reply_settings for delete using (auth.uid() = user_id)';
  end if;
end $$;

do $$
begin
  if to_regclass('public.auto_reply_log') is not null then
    execute 'alter table public.auto_reply_log enable row level security';
    execute 'drop policy if exists "auto_reply_log_select_own" on public.auto_reply_log';
    execute 'drop policy if exists "auto_reply_log_insert_own" on public.auto_reply_log';
    execute 'drop policy if exists "auto_reply_log_update_own" on public.auto_reply_log';
    execute 'drop policy if exists "auto_reply_log_delete_own" on public.auto_reply_log';
    execute 'create policy "auto_reply_log_select_own" on public.auto_reply_log for select using (auth.uid() = user_id)';
    execute 'create policy "auto_reply_log_insert_own" on public.auto_reply_log for insert with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_log_update_own" on public.auto_reply_log for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_log_delete_own" on public.auto_reply_log for delete using (auth.uid() = user_id)';
  end if;
end $$;

do $$
begin
  if to_regclass('public.auto_reply_corrections') is not null then
    execute 'alter table public.auto_reply_corrections enable row level security';
    execute 'drop policy if exists "auto_reply_corrections_select_own" on public.auto_reply_corrections';
    execute 'drop policy if exists "auto_reply_corrections_insert_own" on public.auto_reply_corrections';
    execute 'drop policy if exists "auto_reply_corrections_update_own" on public.auto_reply_corrections';
    execute 'drop policy if exists "auto_reply_corrections_delete_own" on public.auto_reply_corrections';
    execute 'create policy "auto_reply_corrections_select_own" on public.auto_reply_corrections for select using (auth.uid() = user_id)';
    execute 'create policy "auto_reply_corrections_insert_own" on public.auto_reply_corrections for insert with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_corrections_update_own" on public.auto_reply_corrections for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    execute 'create policy "auto_reply_corrections_delete_own" on public.auto_reply_corrections for delete using (auth.uid() = user_id)';
  end if;
end $$;

do $$
begin
  if to_regclass('public.store_context') is not null then
    execute 'alter table public.store_context enable row level security';
    execute 'drop policy if exists "store_context_select_own" on public.store_context';
    execute 'drop policy if exists "store_context_insert_own" on public.store_context';
    execute 'drop policy if exists "store_context_update_own" on public.store_context';
    execute 'drop policy if exists "store_context_delete_own" on public.store_context';
    execute 'create policy "store_context_select_own" on public.store_context for select using (auth.uid() = user_id)';
    execute 'create policy "store_context_insert_own" on public.store_context for insert with check (auth.uid() = user_id)';
    execute 'create policy "store_context_update_own" on public.store_context for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    execute 'create policy "store_context_delete_own" on public.store_context for delete using (auth.uid() = user_id)';
  end if;
end $$;

do $$
declare
  has_user_id boolean;
begin
  if to_regclass('public.promo_schedule') is null then
    return;
  end if;
  select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='promo_schedule' and column_name='user_id'
  ) into has_user_id;
  execute 'alter table public.promo_schedule enable row level security';
  execute 'drop policy if exists "promo_schedule_select_own" on public.promo_schedule';
  execute 'drop policy if exists "promo_schedule_insert_own" on public.promo_schedule';
  execute 'drop policy if exists "promo_schedule_update_own" on public.promo_schedule';
  execute 'drop policy if exists "promo_schedule_delete_own" on public.promo_schedule';
  if has_user_id then
    execute 'create policy "promo_schedule_select_own" on public.promo_schedule for select using (auth.uid() = user_id)';
    execute 'create policy "promo_schedule_insert_own" on public.promo_schedule for insert with check (auth.uid() = user_id)';
    execute 'create policy "promo_schedule_update_own" on public.promo_schedule for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    execute 'create policy "promo_schedule_delete_own" on public.promo_schedule for delete using (auth.uid() = user_id)';
  end if;
end $$;

do $$
begin
  if to_regclass('public.brand_content_library') is not null then
    execute 'alter table public.brand_content_library enable row level security';
    execute 'drop policy if exists "brand_content_library_read" on public.brand_content_library';
    execute 'create policy "brand_content_library_read" on public.brand_content_library for select to authenticated using (true)';
  end if;
end $$;

do $$
begin
  if to_regclass('public.brand_weekday_schedule') is not null then
    execute 'alter table public.brand_weekday_schedule enable row level security';
    execute 'drop policy if exists "brand_weekday_schedule_read" on public.brand_weekday_schedule';
    execute 'create policy "brand_weekday_schedule_read" on public.brand_weekday_schedule for select to authenticated using (true)';
  end if;
end $$;

-- Part 3. account_deletion_log — 탈퇴 감사 로그
create table if not exists public.account_deletion_log (
  id uuid primary key default gen_random_uuid(),
  user_id_hash text not null,
  deleted_at timestamptz not null default now(),
  deleter_ip inet,
  retained_records text[],
  notes text
);
create index if not exists idx_account_deletion_log_deleted_at
  on public.account_deletion_log(deleted_at desc);
alter table public.account_deletion_log enable row level security;
drop policy if exists "account_deletion_log_read" on public.account_deletion_log;
drop policy if exists "account_deletion_log_insert" on public.account_deletion_log;

-- Part 4. auto_reply_log_safe — PII 마스킹 뷰
do $$
begin
  if to_regclass('public.auto_reply_log') is not null then
    execute $v$
      create or replace view public.auto_reply_log_safe as
      select
        id, user_id, ig_user_id, event_type,
        case
          when received_text is null then null
          when length(received_text) <= 8 then repeat('*', length(received_text))
          else substr(received_text, 1, 8) || '…(' || length(received_text) || 'c)'
        end as received_text_masked,
        sender_id, category, sub_category, sentiment, confidence, replied,
        case
          when reply_text is null then null
          when length(reply_text) <= 8 then repeat('*', length(reply_text))
          else substr(reply_text, 1, 8) || '…(' || length(reply_text) || 'c)'
        end as reply_text_masked,
        escalated, escalation_reason, shadow_mode, rating, rated_at, created_at
      from public.auto_reply_log
    $v$;
  end if;
end $$;

notify pgrst, 'reload schema';
`,
};

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST 전용' }) };
  }

  const auth = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '');
  if (!verifyLumiSecret(auth)) {
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
      // 내부 로그에만 디버그 상세, 응답은 안전한 메시지.
      const dbg = `direct_host=${direct.hostname} ref=${ref} supabase_url=${process.env.SUPABASE_URL || ''}`;
      console.error(`[admin-apply-migration] DB 연결 실패: ${dbg} | ${errors.join(' | ')}`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '마이그레이션 적용 실패' }) };
    }

    console.log(`[admin-apply-migration] applied: ${file}`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, file }) };
  } catch (err) {
    // 스키마/쿼리 상세 노출 방지 — 내부 로그에만 상세 기록.
    console.error('[admin-apply-migration] 예외:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '마이그레이션 적용 실패' }) };
  }
};
