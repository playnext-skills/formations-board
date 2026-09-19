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
// POST { email } from a team owner -> records the invite (RPC invite_coach as the caller) and, when
// the address has no account yet, sends Supabase's invite email so the coach lands on the app with
// a session. Existing users are added the next time they sign in (accept_invites).

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await requireUser(req);
    const { email } = await req.json().catch(() => ({}));
    const em = String(email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return json({ error: "Enter a valid email address." }, 400);

    // Run the RPC as the caller so its owner / seat checks apply.
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false },
    });
    const { data: team, error } = await asUser.rpc("invite_coach", { p_email: em });
    if (error) return json({ error: error.message }, 400);

    // Send the email only for addresses that are not registered yet.
    let emailed = false;
    const { data: existing } = await admin.from("profiles").select("user_id").eq("email", em).maybeSingle();
    if (!existing) {
      const inviterName = (user.user_metadata as Record<string, string> | undefined)?.name || user.email || "your coach";
      const { error: invErr } = await admin.auth.admin.inviteUserByEmail(em, {
        redirectTo: APP_URL,
        data: { invited_by: inviterName, team: (team as { name?: string } | null)?.name ?? "" },
      });
      emailed = !invErr;
      if (invErr) console.warn("invite email not sent", invErr.message);
    }
    return json({ team, emailed, existing: !!existing });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error(e);
    return json({ error: (e as Error).message ?? "Invite failed" }, 500);
  }
});