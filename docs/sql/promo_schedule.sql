create table if not exists public.promo_schedule (
  id bigserial primary key,
  scheduled_at timestamptz not null,
  image_url text not null,
  caption text not null,
  label text,
  status text not null default 'pending',  -- pending | done | failed
  post_id text,
  last_error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_promo_schedule_pending
  on public.promo_schedule(scheduled_at)
  where status='pending';
