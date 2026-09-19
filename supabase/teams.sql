-- The Playbook Caller — Phase 2: teams. Run once in the Supabase SQL editor, after billing.sql.
-- A team is owned by the coach whose subscription pays for it (Team / Program / Unlimited plan).
-- Members share one library (team_data) and inherit the owner's entitlement.

create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.team_members (
  team_id   uuid not null references public.teams (id) on delete cascade,
  user_id   uuid primary key references auth.users (id) on delete cascade,   -- one team per coach
  role      text not null check (role in ('owner', 'coach')),
  joined_at timestamptz not null default now()
);
create index if not exists team_members_team_idx on public.team_members (team_id);
create table if not exists public.team_invites (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  email       text not null,
  invited_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  unique (team_id, email)
);
create table if not exists public.team_data (
  team_id           uuid primary key references public.teams (id) on delete cascade,
  custom_formations jsonb not null default '[]'::jsonb,
  custom_plays      jsonb not null default '[]'::jsonb,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users (id) on delete set null
);

alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.team_data    enable row level security;

-- ---------------------------------------------------------------- helpers
create or replace function public.team_of(uid uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select team_id from public.team_members where user_id = uid;
$$;

-- Seats the owner's plan allows (0 when the owner has no live team-sized subscription).
create or replace function public.team_seat_limit(tid uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((
    select s.seat_limit from public.teams t
    join public.subscriptions s on s.user_id = t.owner_id
    where t.id = tid and s.status in ('active', 'trialing', 'comp') and s.seat_limit > 1
    order by s.updated_at desc limit 1
  ), 0);
$$;

-- ---------------------------------------------------------------- entitlement, now team-aware
create or replace function public.entitlement(uid uuid)
returns table (active boolean, reason text, plan text, status text, trial_ends_at timestamptz, period_end timestamptz, grace_until timestamptz)
language sql stable security definer set search_path = public as $$
  with p as (select trial_ends_at from public.profiles where user_id = uid),
       s as (
         select plan, status, current_period_end, seat_limit,
                case when status = 'past_due' then coalesce(current_period_end, updated_at) + interval '7 days' end as grace_until
         from public.subscriptions
         where user_id = uid and (status <> 'comp' or current_period_end is null or current_period_end > now())
         order by case status when 'active' then 0 when 'comp' then 0 when 'trialing' then 1 when 'past_due' then 2 else 3 end, updated_at desc
         limit 1
       ),
       t as (
         select os.plan, os.status, os.current_period_end
         from public.team_members m
         join public.teams tm on tm.id = m.team_id
         join public.subscriptions os on os.user_id = tm.owner_id
         where m.user_id = uid and m.role = 'coach' and os.status in ('active', 'trialing', 'comp') and os.seat_limit > 1
         order by os.updated_at desc limit 1
       )
  select
    case
      when s.status in ('active', 'trialing', 'comp') then true
      when s.status = 'past_due' and now() < s.grace_until then true
      when t.plan is not null then true
      when s.status is null and p.trial_ends_at > now() then true
      else false
    end as active,
    case
      when s.status in ('active', 'trialing', 'comp') then 'subscription'
      when s.status = 'past_due' and now() < s.grace_until then 'grace'
      when t.plan is not null then 'team'
      when s.status is null and p.trial_ends_at > now() then 'trial'
      when s.status is null then 'trial_ended'
      else 'lapsed'
    end as reason,
    coalesce(s.plan, t.plan), coalesce(s.status, t.status), p.trial_ends_at, coalesce(s.current_period_end, t.current_period_end), s.grace_until
  from p left join s on true left join t on true;
$$;

-- ---------------------------------------------------------------- policies
drop policy if exists "teams: members read" on public.teams;
create policy "teams: members read" on public.teams for select to authenticated
  using (id = public.team_of(auth.uid()));
drop policy if exists "team_members: same team read" on public.team_members;
create policy "team_members: same team read" on public.team_members for select to authenticated
  using (team_id = public.team_of(auth.uid()));
drop policy if exists "team_invites: owner read" on public.team_invites;
create policy "team_invites: owner read" on public.team_invites for select to authenticated
  using (team_id in (select id from public.teams where owner_id = auth.uid()));
drop policy if exists "team_data: members read" on public.team_data;
create policy "team_data: members read" on public.team_data for select to authenticated
  using (team_id = public.team_of(auth.uid()));
drop policy if exists "team_data: members insert" on public.team_data;
create policy "team_data: members insert" on public.team_data for insert to authenticated
  with check (team_id = public.team_of(auth.uid()) and (select active from public.entitlement(auth.uid())));
drop policy if exists "team_data: members update" on public.team_data;
create policy "team_data: members update" on public.team_data for update to authenticated
  using (team_id = public.team_of(auth.uid()))
  with check (team_id = public.team_of(auth.uid()) and (select active from public.entitlement(auth.uid())));

revoke all on public.teams, public.team_members, public.team_invites, public.team_data from anon;
grant select on public.teams, public.team_members, public.team_invites to authenticated;
grant select, insert, update on public.team_data to authenticated;

-- ---------------------------------------------------------------- RPCs (all act as the signed-in user)
-- Everything about the caller's team in one call: null when they have none.
create or replace function public.my_team() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tid uuid; me uuid := auth.uid(); out jsonb;
begin
  select team_id into tid from public.team_members where user_id = me;
  if tid is null then return null; end if;
  select jsonb_build_object(
    'id', t.id, 'name', t.name, 'owner_id', t.owner_id,
    'role', (select role from public.team_members where user_id = me),
    'seat_limit', public.team_seat_limit(t.id),
    'seats_used', (select count(*) from public.team_members where team_id = t.id) + (select count(*) from public.team_invites where team_id = t.id and accepted_at is null),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'name', p.name, 'email', p.email, 'joined_at', m.joined_at) order by m.role, m.joined_at), '[]'::jsonb)
                from public.team_members m left join public.profiles p on p.user_id = m.user_id where m.team_id = t.id),
    'invites', (select coalesce(jsonb_agg(jsonb_build_object('email', i.email, 'created_at', i.created_at) order by i.created_at), '[]'::jsonb)
                from public.team_invites i where i.team_id = t.id and i.accepted_at is null)
  ) into out from public.teams t where t.id = tid;
  return out;
end $$;

create or replace function public.create_team(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); seats integer; tid uuid;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from public.team_members where user_id = me) then raise exception 'You are already on a team'; end if;
  select seat_limit into seats from public.subscriptions where user_id = me and status in ('active', 'trialing', 'comp') order by updated_at desc limit 1;
  if coalesce(seats, 0) < 2 then raise exception 'A Team, Program or Unlimited plan is needed to create a team'; end if;
  insert into public.teams (name, owner_id) values (left(coalesce(nullif(trim(p_name), ''), 'My team'), 60), me) returning id into tid;
  insert into public.team_members (team_id, user_id, role) values (tid, me, 'owner');
  insert into public.team_data (team_id, updated_by) values (tid, me) on conflict do nothing;
  return public.my_team();
end $$;

create or replace function public.rename_team(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.teams set name = left(coalesce(nullif(trim(p_name), ''), 'My team'), 60) where owner_id = auth.uid();
  if not found then raise exception 'Only the team owner can rename the team'; end if;
  return public.my_team();
end $$;

-- Records an invite (the email itself is sent by the invite-coach Edge Function).
create or replace function public.invite_coach(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); tid uuid; em text := lower(trim(p_email));
begin
  select id into tid from public.teams where owner_id = me;
  if tid is null then raise exception 'Only the team owner can invite coaches'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if exists (select 1 from public.team_members m join public.profiles p on p.user_id = m.user_id where m.team_id = tid and lower(p.email) = em) then raise exception 'That coach is already on the team'; end if;
  if (select count(*) from public.team_members where team_id = tid) + (select count(*) from public.team_invites where team_id = tid and accepted_at is null) >= public.team_seat_limit(tid)
    then raise exception 'No seats left on your plan'; end if;
  insert into public.team_invites (team_id, email, invited_by) values (tid, em, me)
    on conflict (team_id, email) do update set created_at = now(), accepted_at = null, invited_by = excluded.invited_by;
  return public.my_team();
end $$;

create or replace function public.revoke_invite(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  delete from public.team_invites where email = lower(trim(p_email)) and accepted_at is null and team_id in (select id from public.teams where owner_id = auth.uid());
  return public.my_team();
end $$;

create or replace function public.remove_member(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  select id into tid from public.teams where owner_id = auth.uid();
  if tid is null then raise exception 'Only the team owner can remove coaches'; end if;
  if p_user = auth.uid() then raise exception 'The owner cannot leave their own team'; end if;
  delete from public.team_members where team_id = tid and user_id = p_user;
  return public.my_team();
end $$;

create or replace function public.leave_team() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.team_members where user_id = auth.uid() and role = 'coach';
end $$;

-- Called by the app after every sign-in: joins any team that invited this email while a seat is free.
create or replace function public.accept_invites() returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); em text; inv record; joined text := null;
begin
  select lower(email) into em from auth.users where id = me;
  if exists (select 1 from public.team_members where user_id = me) then return null; end if;
  for inv in select i.*, t.name from public.team_invites i join public.teams t on t.id = i.team_id
             where i.email = em and i.accepted_at is null order by i.created_at loop
    if (select count(*) from public.team_members where team_id = inv.team_id) < public.team_seat_limit(inv.team_id) then
      insert into public.team_members (team_id, user_id, role) values (inv.team_id, me, 'coach');
      update public.team_invites set accepted_at = now() where id = inv.id;
      joined := inv.name;
      exit;
    end if;
  end loop;
  return case when joined is null then null else jsonb_build_object('team', joined) end;
end $$;

grant execute on function public.my_team(), public.create_team(text), public.rename_team(text), public.invite_coach(text),
  public.revoke_invite(text), public.remove_member(uuid), public.leave_team(), public.accept_invites(), public.team_of(uuid), public.team_seat_limit(uuid) to authenticated;
revoke execute on function public.my_team(), public.create_team(text), public.rename_team(text), public.invite_coach(text),
  public.revoke_invite(text), public.remove_member(uuid), public.leave_team(), public.accept_invites() from anon;
