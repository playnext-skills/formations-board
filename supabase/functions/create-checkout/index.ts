// POST { plan: "personal"|"team"|"program"|"unlimited", interval: "month"|"year" }
// -> { url } of a Stripe Checkout Session for the signed-in user.
import Stripe from "npm:stripe@17";
import { admin, APP_URL, cors, customerFor, getStripe, json, requireUser } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await requireUser(req);
    const { plan, interval } = await req.json().catch(() => ({}));
    const { data: price } = await admin.from("plans").select("price_id, plan, interval, seat_limit")
      .eq("plan", plan).eq("interval", interval).maybeSingle();
    // Placeholder ids (price_PERSONAL_MONTH ...) mean the catalogue has not been filled in yet.
    if (!price || /^price_[A-Z_]+$/.test(price.price_id)) return json({ error: "That plan is not available yet." }, 400);

    // One live subscription per user: send existing subscribers to the portal instead.
    const { data: existing } = await admin.from("subscriptions").select("id")
      .eq("user_id", user.id).in("status", ["active", "trialing", "past_due"]).limit(1);
    if (existing && existing.length) return json({ error: "You already have a plan. Use Manage billing to change it.", portal: true }, 409);

    const meta = (user.user_metadata ?? {}) as Record<string, string>;
    const customer = await customerFor(user.id, user.email, meta.name);
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: price.price_id, quantity: 1 }],
      allow_promotion_codes: true,
      payment_method_collection: "if_required",   // a 100% promotion code needs no card
      success_url: `${APP_URL}?checkout=success`,
      cancel_url: `${APP_URL}?checkout=cancel`,
      subscription_data: { metadata: { supabase_user_id: user.id, plan: price.plan, interval: price.interval } },
      metadata: { supabase_user_id: user.id, plan: price.plan, interval: price.interval },
      // Plain Stripe billing, not Stripe Managed Payments (merchant of record, +3.5%): the
      // account applies Managed Payments by default and then refuses products with no tax code.
      managed_payments: { enabled: false },
    } as unknown as Stripe.Checkout.SessionCreateParams);
    return json({ url: session.url });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error(e);
    return json({ error: (e as Error).message ?? "Checkout failed" }, 500);
  }
});
