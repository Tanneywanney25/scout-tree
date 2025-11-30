-- Create profiles table
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Create scout_usage table to track free scouts
create table public.scout_usage (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade,
  username text not null,
  platform text not null,
  created_at timestamp with time zone default now(),
  unique(user_id, username, platform)
);

alter table public.scout_usage enable row level security;

create policy "Users can view own scout usage"
  on public.scout_usage for select
  using (auth.uid() = user_id);

create policy "Users can insert own scout usage"
  on public.scout_usage for insert
  with check (auth.uid() = user_id);

-- Create anonymous_scout_usage table for tracking free scout without login
create table public.anonymous_scout_usage (
  id uuid default gen_random_uuid() primary key,
  fingerprint text not null unique,
  used_at timestamp with time zone default now()
);

alter table public.anonymous_scout_usage enable row level security;

-- Allow anyone to check and insert anonymous usage (1 free scout)
create policy "Anyone can view anonymous scout usage"
  on public.anonymous_scout_usage for select
  using (true);

create policy "Anyone can insert anonymous scout usage"
  on public.anonymous_scout_usage for insert
  with check (true);

-- Function to handle new user signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

-- Trigger for new user creation
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();