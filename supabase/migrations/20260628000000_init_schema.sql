-- ============================================================================
-- ScoutTree — full initial database schema
-- Idempotent: safe to run on an empty database (and to re-run).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Shared helper: keep updated_at fresh on row updates.
-- ---------------------------------------------------------------------------
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user, holding personalization data.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  lichess_username text,
  chesscom_username text,
  rating integer,
  preferred_platform text,
  goals text[] not null default '{}',
  onboarded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile"
  on public.profiles for select using (auth.uid() = id);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

drop trigger if exists update_profiles_updated_at on public.profiles;
create trigger update_profiles_updated_at
  before update on public.profiles
  for each row execute function public.update_updated_at_column();

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- scout_usage — per-user record of scouts run (for logged-in users).
-- ---------------------------------------------------------------------------
create table if not exists public.scout_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  username text not null,
  platform text not null,
  created_at timestamptz not null default now(),
  unique (user_id, username, platform)
);

alter table public.scout_usage enable row level security;

drop policy if exists "Users can view own scout usage" on public.scout_usage;
create policy "Users can view own scout usage"
  on public.scout_usage for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own scout usage" on public.scout_usage;
create policy "Users can insert own scout usage"
  on public.scout_usage for insert with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- anonymous_scout_usage — 1 free scout per anonymous browser fingerprint.
-- ---------------------------------------------------------------------------
create table if not exists public.anonymous_scout_usage (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  used_at timestamptz not null default now()
);

alter table public.anonymous_scout_usage enable row level security;

drop policy if exists "Anyone can view anonymous scout usage" on public.anonymous_scout_usage;
create policy "Anyone can view anonymous scout usage"
  on public.anonymous_scout_usage for select using (true);

drop policy if exists "Anyone can insert anonymous scout usage" on public.anonymous_scout_usage;
create policy "Anyone can insert anonymous scout usage"
  on public.anonymous_scout_usage for insert with check (true);

-- ---------------------------------------------------------------------------
-- training_positions — spaced-repetition drills, one library per user.
-- ---------------------------------------------------------------------------
create table if not exists public.training_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  fen text not null,
  move_to_find text not null,
  move_to_find_uci text not null,
  weakness_category text not null,
  difficulty integer not null check (difficulty >= 1 and difficulty <= 5),
  eval_loss integer not null,
  game_context text,
  explanation text,
  times_attempted integer not null default 0,
  times_correct integer not null default 0,
  mastery_level integer not null default 0 check (mastery_level >= 0 and mastery_level <= 5),
  easiness_factor decimal(3,2) not null default 2.50,
  next_review timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.training_positions enable row level security;

drop policy if exists "Users can view their own training positions" on public.training_positions;
create policy "Users can view their own training positions"
  on public.training_positions for select using (auth.uid() = user_id);

drop policy if exists "Users can create their own training positions" on public.training_positions;
create policy "Users can create their own training positions"
  on public.training_positions for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update their own training positions" on public.training_positions;
create policy "Users can update their own training positions"
  on public.training_positions for update using (auth.uid() = user_id);

drop policy if exists "Users can delete their own training positions" on public.training_positions;
create policy "Users can delete their own training positions"
  on public.training_positions for delete using (auth.uid() = user_id);

create index if not exists idx_training_positions_user_id on public.training_positions(user_id);
create index if not exists idx_training_positions_next_review on public.training_positions(next_review);
create index if not exists idx_training_positions_weakness on public.training_positions(weakness_category);

drop trigger if exists update_training_positions_updated_at on public.training_positions;
create trigger update_training_positions_updated_at
  before update on public.training_positions
  for each row execute function public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- saved_scouts — a user's library of saved opponent reports.
-- ---------------------------------------------------------------------------
create table if not exists public.saved_scouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  opponent_username text not null,
  platform text not null,
  player_color text,
  total_games integer not null default 0,
  summary jsonb,
  created_at timestamptz not null default now()
);

alter table public.saved_scouts enable row level security;

drop policy if exists "Users can view own saved scouts" on public.saved_scouts;
create policy "Users can view own saved scouts"
  on public.saved_scouts for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own saved scouts" on public.saved_scouts;
create policy "Users can insert own saved scouts"
  on public.saved_scouts for insert with check (auth.uid() = user_id);

drop policy if exists "Users can delete own saved scouts" on public.saved_scouts;
create policy "Users can delete own saved scouts"
  on public.saved_scouts for delete using (auth.uid() = user_id);

create index if not exists idx_saved_scouts_user_id on public.saved_scouts(user_id);
create index if not exists idx_saved_scouts_created_at on public.saved_scouts(created_at desc);
