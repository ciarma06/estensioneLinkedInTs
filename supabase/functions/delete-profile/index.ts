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

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const token = extractBearer(req);
    if (!token) return jsonResponse({ error: "Missing authorization" }, 401);

    const payload = await verifyJwt(token, JWT_SECRET);
    if (!payload) return jsonResponse({ error: "Invalid or expired token" }, 401);

    const access = await resolveAccess(payload.email, SUPABASE_URL, SERVICE_KEY);
    if (access.access !== "premium" && access.access !== "trial") {
      return jsonResponse({ error: "Invalid access", access: access.access }, 401);
    }

    let body: { id?: unknown };
    try {
      body = (await req.json()) as { id?: unknown };
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    if (!body.id) {
      return jsonResponse({ error: "id is required" }, 400);
    }

    const deleteUrl =
      `${SUPABASE_URL}/rest/v1/profili_salvati?` +
      `id=eq.${encodeURIComponent(String(body.id))}` +
      `&user_email=eq.${encodeURIComponent(payload.email)}`;

    const res = await fetch(deleteUrl, {
      method: "DELETE",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      signal: AbortSignal.timeout(10_000),
    });

    let deleted: unknown[] = [];
    try {
      deleted = (await res.json()) as unknown[];
    } catch {
      // parse error
    }

    return jsonResponse({ ok: true, deleted: deleted.length });
  } catch (err) {
    console.error("[delete-profile] Error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
