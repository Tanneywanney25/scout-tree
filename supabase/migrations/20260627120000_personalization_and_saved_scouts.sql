-- Personalization: extend profiles with chess identity, rating and goals.
alter table public.profiles
  add column if not exists lichess_username text,
  add column if not exists chesscom_username text,
  add column if not exists rating integer,
  add column if not exists preferred_platform text,
  add column if not exists goals text[] not null default '{}',
  add column if not exists onboarded boolean not null default false;

-- Allow users to insert their own profile row (the signup trigger normally
-- creates it, but this makes upserts from the client safe too).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'Users can insert own profile'
  ) then
    create policy "Users can insert own profile"
      on public.profiles for insert
      with check (auth.uid() = id);
  end if;
end $$;

-- Saved scouts: let signed-in users keep a library of opponent reports.
create table if not exists public.saved_scouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  opponent_username text not null,
  platform text not null,
  player_color text,
  total_games integer not null default 0,
  summary jsonb,
  created_at timestamp with time zone not null default now()
);

alter table public.saved_scouts enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='saved_scouts' and policyname='Users can view own saved scouts') then
    create policy "Users can view own saved scouts" on public.saved_scouts for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='saved_scouts' and policyname='Users can insert own saved scouts') then
    create policy "Users can insert own saved scouts" on public.saved_scouts for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='saved_scouts' and policyname='Users can delete own saved scouts') then
    create policy "Users can delete own saved scouts" on public.saved_scouts for delete using (auth.uid() = user_id);
  end if;
end $$;

create index if not exists idx_saved_scouts_user_id on public.saved_scouts(user_id);
create index if not exists idx_saved_scouts_created_at on public.saved_scouts(created_at desc);
