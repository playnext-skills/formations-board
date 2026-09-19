// POST {} -> { url } of a Stripe Customer Portal session for the signed-in user.
import { admin, APP_URL, cors, getStripe, json, requireUser } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await requireUser(req);
    const { data: profile } = await admin.from("profiles").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
    if (!profile?.stripe_customer_id) return json({ error: "No billing account yet. Choose a plan first." }, 404);
    const session = await getStripe().billingPortal.sessions.create({ customer: profile.stripe_customer_id, return_url: APP_URL });
    return json({ url: session.url });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error(e);
    return json({ error: (e as Error).message ?? "Portal failed" }, 500);
  }
});
