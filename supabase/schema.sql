-- The Playbook Caller — per-user cloud storage for custom formations and plays.
-- Run this once in the Supabase SQL editor (Database → SQL Editor → New query → Run).

create table if not exists public.user_data (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  custom_formations jsonb not null default '[]'::jsonb,
  custom_plays      jsonb not null default '[]'::jsonb,
  updated_at        timestamptz not null default now()
);

alter table public.user_data enable row level security;

-- Each signed-in user can read and write only their own row.
drop policy if exists "own row: select" on public.user_data;
create policy "own row: select" on public.user_data
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "own row: insert" on public.user_data;
create policy "own row: insert" on public.user_data
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "own row: update" on public.user_data;
create policy "own row: update" on public.user_data
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The anon key can never touch this table (no policy for the anon role), and nobody can delete
-- rows from the app; deleting the auth user removes the row through the foreign key.
grant select, insert, update on public.user_data to authenticated;
revoke all on public.user_data from anon;
