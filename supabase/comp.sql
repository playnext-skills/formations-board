-- Grant a complimentary plan without Stripe. Replace the user id, plan, seat_limit and end date.
-- status 'comp' is treated as active by entitlement(), team_seat_limit() and create_team().
insert into public.subscriptions (id, user_id, stripe_customer_id, plan, interval, status, seat_limit, current_period_end, cancel_at_period_end, updated_at)
values ('comp_' || gen_random_uuid()::text, '<auth.users.id>', 'comp', 'program', 'year', 'comp', 15, now() + interval '1 year', false, now());
