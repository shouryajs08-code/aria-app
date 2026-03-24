-- ARIA Supabase schema
-- Run in the Supabase SQL editor.

-- Users table for app-specific metadata.
-- Links to Supabase Auth users.
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  plan text not null default 'free',
  created_at timestamptz not null default now(),
  referral_code text
);

-- Prop firm settings per user (one row per firm).
create table if not exists public.prop_settings (
  user_id uuid not null references public.users(id) on delete cascade,
  firm text not null,
  balance numeric not null default 0,
  pnl numeric not null default 0,
  target numeric not null default 0,
  max_dd numeric not null default 0,
  daily_limit numeric not null default 0,
  primary key (user_id, firm)
);

-- Trades history.
create table if not exists public.trades (
  user_id uuid not null references public.users(id) on delete cascade,
  pair text not null,
  dir text not null,
  entry numeric not null,
  exit numeric,
  pnl numeric,
  result text,
  timestamp timestamptz not null default now()
);

-- Signals table.
create table if not exists public.signals (
  user_id uuid not null references public.users(id) on delete cascade,
  pair text not null,
  analysis text not null,
  timestamp timestamptz not null default now()
);

-- Usage / rate-limit tracking.
create table if not exists public.usage (
  user_id uuid primary key references public.users(id) on delete cascade,
  queries_today integer not null default 0,
  reset_at timestamptz not null default now()
);

-- Helpful indexes.
create index if not exists idx_prop_settings_user on public.prop_settings (user_id);
create index if not exists idx_trades_user_ts on public.trades (user_id, timestamp desc);
create index if not exists idx_signals_user_ts on public.signals (user_id, timestamp desc);

-- Row Level Security (required so authenticated users can read their own data).
alter table public.users enable row level security;
alter table public.prop_settings enable row level security;
alter table public.trades enable row level security;
alter table public.signals enable row level security;
alter table public.usage enable row level security;

-- USERS policies
create policy "users_select_own" on public.users
  for select using (id = auth.uid());

create policy "users_insert_own" on public.users
  for insert with check (id = auth.uid());

create policy "users_update_own" on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- PROP SETTINGS policies
create policy "prop_settings_select_own" on public.prop_settings
  for select using (user_id = auth.uid());

create policy "prop_settings_insert_own" on public.prop_settings
  for insert with check (user_id = auth.uid());

create policy "prop_settings_update_own" on public.prop_settings
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "prop_settings_delete_own" on public.prop_settings
  for delete using (user_id = auth.uid());

-- TRADES policies
create policy "trades_select_own" on public.trades
  for select using (user_id = auth.uid());

create policy "trades_insert_own" on public.trades
  for insert with check (user_id = auth.uid());

-- SIGNALS policies
create policy "signals_select_own" on public.signals
  for select using (user_id = auth.uid());

create policy "signals_insert_own" on public.signals
  for insert with check (user_id = auth.uid());

-- USAGE policies
create policy "usage_select_own" on public.usage
  for select using (user_id = auth.uid());

create policy "usage_insert_own" on public.usage
  for insert with check (user_id = auth.uid());

create policy "usage_update_own" on public.usage
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

