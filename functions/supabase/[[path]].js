// Cloudflare Pages Function: the supabase/ folder (schema, policies, Edge Function sources)
// is in the repo for version control only and must not be served from the public site.
export function onRequest() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" } });
}
