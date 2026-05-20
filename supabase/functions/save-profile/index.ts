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
    if (access.access !== "premium" && access.access !== "waitlist_trial") {
      return jsonResponse({ error: "Invalid access", access: access.access }, 401);
    }

    let body: {
      full_name?: string;
      linkedin_url?: string;
      comment_text?: string;
      comment_url?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    if (!body.full_name || !body.linkedin_url) {
      return jsonResponse({ error: "full_name and linkedin_url are required" }, 400);
    }

    const insertBody = {
      full_name: body.full_name,
      linkedin_url: body.linkedin_url,
      comment_text: body.comment_text ?? null,
      comment_url: body.comment_url ?? null,
      user_email: payload.email,
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/profili_salvati`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation,resolution=merge-duplicates",
      },
      body: JSON.stringify(insertBody),
      signal: AbortSignal.timeout(10_000),
    });

    let result: unknown = null;
    try {
      const arr = (await res.json()) as unknown[];
      result = arr?.[0] ?? null;
    } catch {
      // parse error
    }

    if (!res.ok) {
      return jsonResponse({ error: "Failed to save profile" }, 500);
    }

    return jsonResponse({ profile: result });
  } catch (err) {
    console.error("[save-profile] Error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
