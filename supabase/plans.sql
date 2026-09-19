-- The Playbook Caller — plan catalogue. Run after billing.sql.
-- Price ids are public (they appear in Checkout URLs). These are the TEST-mode ids created
-- 2026-09-19 in the MiaMetrix sandbox; replace with live ids when going live.

create table if not exists public.plans (
  plan         text not null,          -- personal | team | program | unlimited
  interval     text not null,          -- month | year
  price_id     text primary key,       -- Stripe price id
  amount_cents integer not null,
  seat_limit   integer not null,
  label        text not null,
  unique (plan, interval)
);
alter table public.plans enable row level security;
drop policy if exists "plans: public read" on public.plans;
create policy "plans: public read" on public.plans for select to anon, authenticated using (true);
grant select on public.plans to anon, authenticated;

insert into public.plans (plan, interval, price_id, amount_cents, seat_limit, label) values
  ('personal',  'month', 'price_1UHNyrFOiHtvEtqSC4jDXdi1',  999,   1,    'Personal'),
  ('personal',  'year',  'price_1UHNyrFOiHtvEtqSxm2ukUO9',   9900,  1,    'Personal'),
  ('team',      'month', 'price_1UHNzpFOiHtvEtqS3uqyzoYk',      2999,  6,    'Team'),
  ('team',      'year',  'price_1UHNzpFOiHtvEtqSdKahHrz3',       29900, 6,    'Team'),
  ('program',   'month', 'price_1UHO0hFOiHtvEtqStpHD2lDB',   4999,  15,   'Program'),
  ('program',   'year',  'price_1UHO0hFOiHtvEtqSIfsjTFHx',    49900, 15,   'Program'),
  ('unlimited', 'month', 'price_1UHO1FFOiHtvEtqSSzQnoqMJ', 9900,  9999, 'Unlimited'),
  ('unlimited', 'year',  'price_1UHO1FFOiHtvEtqS9cHRulGj',  99000, 9999, 'Unlimited')
on conflict (plan, interval) do update
  set price_id = excluded.price_id, amount_cents = excluded.amount_cents, seat_limit = excluded.seat_limit, label = excluded.label;
