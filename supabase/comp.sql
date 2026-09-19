-- Grant a complimentary plan without Stripe. Replace the user id, plan, seat_limit and end date.
-- Re-runnable: the id is derived from the user id, so running it again updates the grant.
insert into public.subscriptions (id, user_id, stripe_customer_id, plan, interval, status, seat_limit, current_period_end, cancel_at_period_end, updated_at)
values ('comp_<auth.users.id>', '<auth.users.id>', 'comp', 'program', 'year', 'comp', 15, now() + interval '1 year', false, now())
on conflict (id) do update set plan = excluded.plan, interval = excluded.interval, status = 'comp', seat_limit = excluded.seat_limit,
  current_period_end = excluded.current_period_end, updated_at = now();
