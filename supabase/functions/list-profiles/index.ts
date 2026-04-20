import { corsHeaders } from "../_shared/cors.ts";
import { verifyJwt } from "../_shared/jwt.ts";
import { resolveAccess } from "../_shared/access.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("AUTH_JWT_SECRET")!;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const token = extractBearer(req);
    if (!token) return jsonResponse({ error: "Missing authorization" }, 401);

    const payload = await verifyJwt(token, JWT_SECRET);
    if (!payload) return jsonResponse({ error: "Token non valido o scaduto" }, 401);

    const access = await resolveAccess(payload.email, SUPABASE_URL, SERVICE_KEY);
    if (access.access !== "premium" && access.access !== "waitlist_trial") {
      return jsonResponse({ error: "Accesso non valido", access: access.access }, 401);
    }

    const url =
      `${SUPABASE_URL}/rest/v1/profili_salvati?` +
      `user_email=eq.${encodeURIComponent(payload.email)}` +
      `&order=created_at.desc`;

    const res = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    let profiles: unknown[] = [];
    try {
      profiles = (await res.json()) as unknown[];
    } catch {
      // parse error
    }

    return jsonResponse({ profiles });
  } catch (err) {
    console.error("[list-profiles] Error:", err);
    return jsonResponse({ error: "Errore interno" }, 500);
  }
});
