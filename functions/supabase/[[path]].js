// Cloudflare Pages Function: the supabase/ folder (schema, policies, Edge Function sources)
// is in the repo for version control only and must not be served from the public site.
// Answers 404 with the branded not-found page (security headers set here, because _headers
// does not apply to Function responses).
const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export async function onRequest({ request, env }) {
  try {
    let res = await env.ASSETS.fetch(new URL("/404.html", request.url));
    if (res.status >= 300 && res.status < 400 && res.headers.get("Location")) {
      res = await env.ASSETS.fetch(new URL(res.headers.get("Location"), request.url));
    }
    if ((res.headers.get("Content-Type") || "").includes("text/html")) {
      return new Response(await res.text(), { status: 404, headers: HEADERS });
    }
  } catch (_) { /* fall through to the plain answer */ }
  return new Response("Not found", { status: 404, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}
