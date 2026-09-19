-- The Playbook Caller — Phase 1 billing: profiles with a 14-day trial, a subscriptions cache
-- written by the Stripe webhook, and one entitlement rule the app and RLS both use.
-- Run once in the Supabase SQL editor, after schema.sql.

-- ---------------------------------------------------------------- profiles + trial
create table if not exists public.profiles (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  email              text,
  name               text,
  team_name          text,          -- shown in place of the coach's name
  trial_ends_at      timestamptz not null default (now() + interval '14 days'),
  stripe_customer_id text unique,
  created_at         timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles: own row select" on public.profiles;
create policy "profiles: own row select" on public.profiles
  for select to authenticated using (auth.uid() = user_id);

-- Users may edit their display name only; billing columns are written by functions (service role).
drop policy if exists "profiles: own row update name" on public.profiles;
create policy "profiles: own row update name" on public.profiles
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.profiles from anon;
grant select, update (name, team_name) on public.profiles to authenticated;

-- A profile row is created for every new auth user, and back-filled for existing ones.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.profiles (user_id, email, name)
select id, email, coalesce(raw_user_meta_data ->> 'name', '') from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------- subscriptions (Stripe cache)
create table if not exists public.subscriptions (
  id                     text primary key,            -- Stripe subscription id
  user_id                uuid not null references auth.users (id) on delete cascade,
  stripe_customer_id     text not null,
  plan                   text not null,               -- personal | team | program | unlimited
  interval               text not null,               -- month | year
  status                 text not null,               -- trialing | active | past_due | canceled | unpaid | incomplete
  seat_limit             integer not null default 1,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  updated_at             timestamptz not null default now()
);
create index if not exists subscriptions_user_idx on public.subscriptions (user_id);
alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions: own rows select" on public.subscriptions;
create policy "subscriptions: own rows select" on public.subscriptions
  for select to authenticated using (auth.uid() = user_id);
revoke all on public.subscriptions from anon;
grant select on public.subscriptions to authenticated;
-- inserts/updates come only from the webhook function using the service role

-- ---------------------------------------------------------------- the entitlement rule
-- active  = trial still running, or a subscription that is trialing/active,
--           or past_due within a 7-day grace window.
-- entitlement() is defined ONCE, in hardening.sql (team- and comp-aware). Run that file last.
grant execute on function public.entitlement(uuid) to authenticated;
revoke execute on function public.entitlement(uuid) from anon;

-- Convenience for the app: `select * from public.my_entitlement()` = the signed-in user's row.
create or replace function public.my_entitlement()
returns table (active boolean, reason text, plan text, status text, trial_ends_at timestamptz, period_end timestamptz, grace_until timestamptz)
language sql stable security definer set search_path = public as $$
  select * from public.entitlement(auth.uid());
$$;
grant execute on function public.my_entitlement() to authenticated;
revoke execute on function public.my_entitlement() from anon;

-- ---------------------------------------------------------------- enforce it on saved work
-- Reading your own library is always allowed (export never breaks); writing needs an active plan.
drop policy if exists "own row: insert" on public.user_data;
create policy "own row: insert" on public.user_data
  for insert to authenticated
  with check (auth.uid() = user_id and (select active from public.entitlement(auth.uid())));

drop policy if exists "own row: update" on public.user_data;
create policy "own row: update" on public.user_data
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and (select active from public.entitlement(auth.uid())));
