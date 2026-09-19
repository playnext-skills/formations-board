-- The Playbook Caller — hardening after the 2026-09-19 audit. Safe to re-run.
-- Run AFTER schema.sql, billing.sql, plans.sql and teams.sql. This file holds the canonical
-- versions of entitlement(), team_seat_limit(), create_team() and accept_invites().

-- 1. profiles: Supabase's default table-level UPDATE grant let a user rewrite trial_ends_at,
--    stripe_customer_id and email. Only name and team_name are user-editable.
revoke update on public.profiles from authenticated;
grant update (name, team_name) on public.profiles to authenticated;

-- 2. Functions are executable by PUBLIC by default; "revoke from anon" did not remove that.
revoke execute on function public.entitlement(uuid), public.my_entitlement(), public.team_of(uuid), public.team_seat_limit(uuid),
  public.my_team(), public.create_team(text), public.rename_team(text), public.invite_coach(text), public.revoke_invite(text),
  public.remove_member(uuid), public.leave_team(), public.accept_invites(), public.handle_new_user() from public, anon;
grant execute on function public.entitlement(uuid), public.my_entitlement(), public.team_of(uuid), public.team_seat_limit(uuid),
  public.my_team(), public.create_team(text), public.rename_team(text), public.invite_coach(text), public.revoke_invite(text),
  public.remove_member(uuid), public.leave_team(), public.accept_invites() to authenticated;

-- 3. A subscription row is "live" when active/trialing, or a comp that has not expired.
create or replace function public.sub_is_live(st text, period_end timestamptz) returns boolean
language sql stable as $$
  select st in ('active', 'trialing') or (st = 'comp' and (period_end is null or period_end > now()));
$$;
revoke execute on function public.sub_is_live(text, timestamptz) from public, anon;
grant execute on function public.sub_is_live(text, timestamptz) to authenticated;

create or replace function public.team_seat_limit(tid uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((
    select s.seat_limit from public.teams t
    join public.subscriptions s on s.user_id = t.owner_id
    where t.id = tid and public.sub_is_live(s.status, s.current_period_end) and s.seat_limit > 1
    order by s.updated_at desc limit 1
  ), 0);
$$;

-- entitlement(): callers may only ask about themselves (policies and my_entitlement pass
-- auth.uid()); a null auth.uid() is the SQL editor / service role and is allowed.
create or replace function public.entitlement(uid uuid)
returns table (active boolean, reason text, plan text, status text, trial_ends_at timestamptz, period_end timestamptz, grace_until timestamptz)
language sql stable security definer set search_path = public as $$
  with z as (select 1 where auth.uid() is null or uid = auth.uid()),
       p as (select trial_ends_at from public.profiles where user_id = uid),
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
         where m.user_id = uid and m.role = 'coach' and public.sub_is_live(os.status, os.current_period_end) and os.seat_limit > 1
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
  from z left join p on true left join s on true left join t on true;
$$;

create or replace function public.team_of(uid uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select team_id from public.team_members where user_id = uid and (auth.uid() is null or uid = auth.uid());
$$;

create or replace function public.create_team(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); seats integer; tid uuid;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from public.team_members where user_id = me) then raise exception 'You are already on a team'; end if;
  select seat_limit into seats from public.subscriptions
    where user_id = me and public.sub_is_live(status, current_period_end) order by updated_at desc limit 1;
  if coalesce(seats, 0) < 2 then raise exception 'A Team, Program or Unlimited plan is needed to create a team'; end if;
  insert into public.teams (name, owner_id) values (left(coalesce(nullif(trim(p_name), ''), 'My team'), 60), me) returning id into tid;
  insert into public.team_members (team_id, user_id, role) values (tid, me, 'owner');
  insert into public.team_data (team_id, updated_by) values (tid, me) on conflict do nothing;
  return public.my_team();
end $$;

-- invite_coach: lock the team row so two invites cannot both squeeze past the seat count.
create or replace function public.invite_coach(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); tid uuid; em text := lower(trim(p_email));
begin
  select id into tid from public.teams where owner_id = me for update;
  if tid is null then raise exception 'Only the team owner can invite coaches'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if exists (select 1 from public.team_members m join public.profiles p on p.user_id = m.user_id where m.team_id = tid and lower(p.email) = em) then raise exception 'That coach is already on the team'; end if;
  if (select count(*) from public.team_members where team_id = tid) + (select count(*) from public.team_invites where team_id = tid and accepted_at is null) >= public.team_seat_limit(tid)
    then raise exception 'No seats left on your plan'; end if;
  insert into public.team_invites (team_id, email, invited_by) values (tid, em, me)
    on conflict (team_id, email) do update set created_at = now(), accepted_at = null, invited_by = excluded.invited_by;
  return public.my_team();
end $$;

-- accept_invites: only a confirmed email may claim an invite, and the team row is locked
-- while the seat count is checked.
create or replace function public.accept_invites() returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); em text; inv record; joined text := null;
begin
  if me is null then return null; end if;
  select lower(email) into em from auth.users where id = me and email_confirmed_at is not null;
  if em is null then return null; end if;
  if exists (select 1 from public.team_members where user_id = me) then return null; end if;
  for inv in select i.*, t.name from public.team_invites i join public.teams t on t.id = i.team_id
             where i.email = em and i.accepted_at is null order by i.created_at loop
    perform 1 from public.teams where id = inv.team_id for update;
    if (select count(*) from public.team_members where team_id = inv.team_id) < public.team_seat_limit(inv.team_id) then
      insert into public.team_members (team_id, user_id, role) values (inv.team_id, me, 'coach');
      update public.team_invites set accepted_at = now() where id = inv.id;
      joined := inv.name;
      exit;
    end if;
  end loop;
  return case when joined is null then null else jsonb_build_object('team', joined) end;
end $$;

-- 4. Re-assert the gated write policies on user_data (schema.sql's ungated originals must never win).
drop policy if exists "own row: insert" on public.user_data;
create policy "own row: insert" on public.user_data for insert to authenticated
  with check (auth.uid() = user_id and (select active from public.entitlement(auth.uid())));
drop policy if exists "own row: update" on public.user_data;
create policy "own row: update" on public.user_data for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id and (select active from public.entitlement(auth.uid())));

-- 5. Webhook ordering guard: remember the newest Stripe event applied per subscription.
alter table public.subscriptions add column if not exists last_event_at timestamptz;
