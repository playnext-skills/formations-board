-- The Playbook Caller — plan catalogue. Run after billing.sql.
-- Price ids are public (they appear in Checkout URLs); fill them in from the Stripe dashboard,
-- test-mode ids first, live ids when going live.

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
  ('personal',  'month', 'price_PERSONAL_MONTH',  999,   1,    'Personal'),
  ('personal',  'year',  'price_PERSONAL_YEAR',   9900,  1,    'Personal'),
  ('team',      'month', 'price_TEAM_MONTH',      2999,  6,    'Team'),
  ('team',      'year',  'price_TEAM_YEAR',       29900, 6,    'Team'),
  ('program',   'month', 'price_PROGRAM_MONTH',   4999,  15,   'Program'),
  ('program',   'year',  'price_PROGRAM_YEAR',    49900, 15,   'Program'),
  ('unlimited', 'month', 'price_UNLIMITED_MONTH', 9900,  9999, 'Unlimited'),
  ('unlimited', 'year',  'price_UNLIMITED_YEAR',  99000, 9999, 'Unlimited')
on conflict (plan, interval) do update
  set price_id = excluded.price_id, amount_cents = excluded.amount_cents, seat_limit = excluded.seat_limit, label = excluded.label;
