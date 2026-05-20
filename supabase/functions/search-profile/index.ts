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

function normalizeLinkedInUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("linkedin.com")) return url.split("?")[0].replace(/\/$/, "");
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url.split("?")[0].replace(/\/$/, "");
  }
}

function extractInSlug(profileUrl: string): string | null {
  try {
    const u = new URL(profileUrl);
    const m = u.pathname.match(/\/in\/([^/?#]+)/);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    const m = profileUrl.match(/\/in\/([^/?#]+)/);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  }
}

type ProfileRow = {
  full_name: string | null;
  comment_text: string | null;
  comment_url: string | null;
  linkedin_url: string | null;
};

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

    let body: { linkedin_url?: string };
    try {
      body = (await req.json()) as { linkedin_url?: string };
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const rawUrl = (body.linkedin_url ?? "").trim();
    if (!rawUrl) {
      return jsonResponse({ error: "Missing linkedin_url" }, 400);
    }

    const normalized = normalizeLinkedInUrl(rawUrl);

    const exactUrl =
      `${SUPABASE_URL}/rest/v1/profili_salvati?` +
      `user_email=eq.${encodeURIComponent(payload.email)}` +
      `&linkedin_url=eq.${encodeURIComponent(normalized)}` +
      `&order=created_at.desc` +
      `&limit=1`;

    const exactRes = await fetch(exactUrl, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    let rows: ProfileRow[] = [];
    try {
      rows = (await exactRes.json()) as ProfileRow[];
    } catch {
      // parse error
    }

    if (rows.length > 0) {
      return jsonResponse({ profile: rows[0] });
    }

    const slug = extractInSlug(normalized);
    if (!slug) {
      return jsonResponse({ profile: null });
    }

    const fuzzyUrl =
      `${SUPABASE_URL}/rest/v1/profili_salvati?` +
      `user_email=eq.${encodeURIComponent(payload.email)}` +
      `&linkedin_url=ilike.${encodeURIComponent(`%/in/${slug}%`)}` +
      `&order=created_at.desc` +
      `&limit=1`;

    const fuzzyRes = await fetch(fuzzyUrl, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    let fuzzyRows: ProfileRow[] = [];
    try {
      fuzzyRows = (await fuzzyRes.json()) as ProfileRow[];
    } catch {
      // parse error
    }

    return jsonResponse({ profile: fuzzyRows[0] ?? null });
  } catch (err) {
    console.error("[search-profile] Error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
