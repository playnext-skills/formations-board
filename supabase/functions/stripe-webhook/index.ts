// Stripe -> this function. Verifies the signature, then mirrors subscription state into
// public.subscriptions. Stripe is the source of truth; this table is a cache of it.
// Deploy with JWT verification OFF (see supabase/config.toml).
import Stripe from "npm:stripe@17";
import { admin, getStripe } from "../_shared/common.ts";

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
    // API versions from 2025-03 carry the period on the subscription item, older ones on the subscription.
    current_period_end: (function(){ const t = (sub as unknown as { current_period_end?: number }).current_period_end ?? (item as unknown as { current_period_end?: number } | undefined)?.current_period_end; return t ? new Date(t * 1000).toISOString() : null; })(),
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
        if (subId) await upsertSubscription(await getStripe().subscriptions.retrieve(subId));
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
        if (subId) await upsertSubscription(await getStripe().subscriptions.retrieve(subId));
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
