import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

// ---- shared helpers (inlined for single-file dashboard deploys; regenerate with the script in README) ----
// Shared helpers for the billing Edge Functions (Deno).

const APP_URL = Deno.env.get("APP_URL") ?? "https://theplaybookcaller.com/";

// Built on first use, not at module load: an unset STRIPE_SECRET_KEY must produce a clear
// "not configured" reply rather than crash the worker.
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw json({ error: "Billing is not configured yet (STRIPE_SECRET_KEY missing)." }, 503);
  _stripe = new Stripe(key, { apiVersion: "2024-12-18.acacia", httpClient: Stripe.createFetchHttpClient() });
  return _stripe;
}

// Service-role client: bypasses RLS, used only inside these functions.
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

/** Resolve the caller from the Authorization: Bearer <access_token> header. */
async function requireUser(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw json({ error: "Not signed in" }, 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw json({ error: "Session invalid" }, 401);
  return data.user;
}

/** Find or create the Stripe customer for a user and remember it on the profile. */
async function customerFor(userId: string, email?: string, name?: string): Promise<string> {
  const { data: profile } = await admin.from("profiles").select("stripe_customer_id, email, name").eq("user_id", userId).maybeSingle();
  if (profile?.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await getStripe().customers.create({
    email: email ?? profile?.email ?? undefined,
    name: name ?? profile?.name ?? undefined,
    metadata: { supabase_user_id: userId },
  });
  await admin.from("profiles").upsert(
    { user_id: userId, stripe_customer_id: customer.id, email: email ?? profile?.email ?? null },
    { onConflict: "user_id" },
  );
  return customer.id;
}
// ---- function ----
// POST { plan: "personal"|"team"|"program"|"unlimited", interval: "month"|"year" }
// -> { url } of a Stripe Checkout Session for the signed-in user.

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
      .eq("user_id", user.id).in("status", ["active", "trialing", "past_due", "comp"]).limit(1);
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
    return json({ error: "Checkout could not start. Please try again in a moment." }, 500);
  }
});