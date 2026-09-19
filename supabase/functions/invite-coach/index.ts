// POST { email } from a team owner -> records the invite (RPC invite_coach as the caller) and, when
// the address has no account yet, sends Supabase's invite email so the coach lands on the app with
// a session. Existing users are added the next time they sign in (accept_invites).
import { createClient } from "npm:@supabase/supabase-js@2";
import { admin, APP_URL, cors, json, requireUser } from "../_shared/common.ts";

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
