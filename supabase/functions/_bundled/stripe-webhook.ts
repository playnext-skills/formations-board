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
// Stripe -> this function. Verifies the signature, then mirrors subscription state into
// public.subscriptions. Stripe is the source of truth; this table is a cache of it.
// Deploy with JWT verification OFF (see supabase/config.toml).

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const cryptoProvider = Stripe.createSubtleCryptoProvider();

async function userIdForCustomer(customerId: string, sub?: Stripe.Subscription): Promise<string | null> {
  const fromMeta = sub?.metadata?.supabase_user_id;
  if (fromMeta) return fromMeta;
  const { data } = await admin.from("profiles").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
  if (data?.user_id) return data.user_id;
  const customer = await getStripe().customers.retrieve(customerId);
  return (customer as Stripe.Customer).metadata?.supabase_user_id ?? null;
}

async function upsertSubscription(sub: Stripe.Subscription, eventCreated?: number) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const userId = await userIdForCustomer(customerId, sub);
  if (!userId) { console.warn("No user for customer", customerId); return; }
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? "";
  const { data: plan } = await admin.from("plans").select("plan, interval, seat_limit").eq("price_id", priceId).maybeSingle();
  // An unknown price must fail loudly (Stripe retries) rather than silently write a 1-seat row.
  if (!plan) throw new Error(`Price ${priceId} is not in public.plans`);
  // Out-of-order delivery: never let an older event overwrite a newer one.
  if (eventCreated) {
    const { data: cur } = await admin.from("subscriptions").select("last_event_at").eq("id", sub.id).maybeSingle();
    if (cur?.last_event_at && Date.parse(cur.last_event_at) > eventCreated * 1000) { console.warn("stale event ignored", sub.id); return; }
  }
  const { error: subErr } = await admin.from("subscriptions").upsert({
    id: sub.id,
    user_id: userId,
    stripe_customer_id: customerId,
    plan: plan?.plan ?? sub.metadata?.plan ?? "personal",
    interval: plan?.interval ?? item?.price?.recurring?.interval ?? "month",
    status: sub.status,
    seat_limit: plan?.seat_limit ?? 1,
    // API versions from 2025-03 carry the period on the subscription item, older ones on the subscription.
    current_period_end: (function(){ const t = (sub as unknown as { current_period_end?: number }).current_period_end ?? (item as unknown as { current_period_end?: number } | undefined)?.current_period_end; return t ? new Date(t * 1000).toISOString() : null; })(),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
    last_event_at: new Date((eventCreated ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  }, { onConflict: "id" });
  if (subErr) throw subErr;
  const { error: profErr } = await admin.from("profiles").upsert({ user_id: userId, stripe_customer_id: customerId }, { onConflict: "user_id" });
  if (profErr) throw profErr;
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();
  let event: Stripe.Event;
  try {
    if (!WEBHOOK_SECRET) return new Response("Webhook not configured (STRIPE_WEBHOOK_SECRET missing)", { status: 503 });
    event = await getStripe().webhooks.constructEventAsync(body, sig, WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch (e) {
    if (e instanceof Response) return e;   // getStripe(): billing not configured
    console.error("Bad signature", (e as Error).message);
    return new Response("Bad signature", { status: 400 });
  }
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (subId) await upsertSubscription(await getStripe().subscriptions.retrieve(subId), event.created);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed": {
        // Always read the current state from Stripe rather than trusting a possibly stale payload.
        const s = event.data.object as Stripe.Subscription;
        await upsertSubscription(await getStripe().subscriptions.retrieve(s.id), event.created);
        break;
      }
      case "invoice.payment_failed":
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice;
        // 2025-04+ API versions moved the subscription reference under invoice.parent.
        const parentRef = (inv as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } } } }).parent?.subscription_details?.subscription;
        const raw = inv.subscription ?? parentRef;
        const subId = typeof raw === "string" ? raw : raw?.id;
        if (subId) await upsertSubscription(await getStripe().subscriptions.retrieve(subId), event.created);
        break;
      }
      default:
        break;
    }
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error(e);
    return new Response("Handler error", { status: 500 });
  }
});