import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

// ---- shared helpers (inlined for single-file dashboard deploys) ----
// Shared helpers for the billing Edge Functions (Deno).

const APP_URL = Deno.env.get("APP_URL") ?? "https://theplaybookcaller.com/";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-12-18.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

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
  const customer = await stripe.customers.create({
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
  const customer = await stripe.customers.retrieve(customerId);
  return (customer as Stripe.Customer).metadata?.supabase_user_id ?? null;
}

async function upsertSubscription(sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const userId = await userIdForCustomer(customerId, sub);
  if (!userId) { console.warn("No user for customer", customerId); return; }
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? "";
  const { data: plan } = await admin.from("plans").select("plan, interval, seat_limit").eq("price_id", priceId).maybeSingle();
  await admin.from("subscriptions").upsert({
    id: sub.id,
    user_id: userId,
    stripe_customer_id: customerId,
    plan: plan?.plan ?? sub.metadata?.plan ?? "personal",
    interval: plan?.interval ?? item?.price?.recurring?.interval ?? "month",
    status: sub.status,
    seat_limit: plan?.seat_limit ?? 1,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  await admin.from("profiles").upsert({ user_id: userId, stripe_customer_id: customerId }, { onConflict: "user_id" });
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch (e) {
    console.error("Bad signature", (e as Error).message);
    return new Response("Bad signature", { status: 400 });
  }
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (subId) await upsertSubscription(await stripe.subscriptions.retrieve(subId));
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await upsertSubscription(event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed":
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;
        if (subId) await upsertSubscription(await stripe.subscriptions.retrieve(subId));
        break;
      }
      default:
        break;
    }
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response("Handler error", { status: 500 });
  }
});