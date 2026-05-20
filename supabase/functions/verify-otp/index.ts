import { corsHeaders } from "../_shared/cors.ts";
import { isValidEmail, isValidOtp } from "../_shared/validation.ts";
import { resolveAccess } from "../_shared/access.ts";
import { checkAndRecord } from "../_shared/rateLimit.ts";
import { signJwt } from "../_shared/jwt.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("AUTH_JWT_SECRET")!;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const restHeaders = (key: string): Record<string, string> => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!JWT_SECRET) {
    return jsonResponse({ error: "Server misconfigured: AUTH_JWT_SECRET missing" }, 500);
  }

  try {
    let body: { email?: unknown; code?: unknown };
    try {
      body = (await req.json()) as { email?: unknown; code?: unknown };
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    if (!isValidEmail(body.email)) {
      return jsonResponse({ error: "Invalid email" }, 400);
    }
    if (!isValidOtp(body.code)) {
      return jsonResponse({ error: "Invalid code" }, 400);
    }

    const email = body.email.trim().toLowerCase();
    const code = body.code;

    // Rate limit per email: max 10 attempts/hour
    const rlCheck = await checkAndRecord({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
      email,
      action: "verify_otp",
      maxPerWindow: 10,
      windowSeconds: 3600,
    });
    if (!rlCheck.allowed) {
      return jsonResponse(
        { error: `Too many attempts. ${rlCheck.retryMessage ?? "Please try again later."}` },
        429,
      );
    }

    const codeHash = await sha256Hex(code);

    // Find matching OTP (not used, not expired)
    const findUrl =
      `${SUPABASE_URL}/rest/v1/otp_codes?` +
      `email=eq.${encodeURIComponent(email)}` +
      `&code_hash=eq.${encodeURIComponent(codeHash)}` +
      `&used_at=is.null` +
      `&expires_at=gte.${encodeURIComponent(new Date().toISOString())}` +
      `&order=created_at.desc&limit=1`;

    const findRes = await fetch(findUrl, {
      headers: restHeaders(SERVICE_KEY),
      signal: AbortSignal.timeout(5000),
    });

    let rows: Array<{ id: string; attempts: number }> = [];
    try {
      rows = (await findRes.json()) as Array<{ id: string; attempts: number }>;
    } catch {
      // parse error
    }

    if (!rows.length || rows[0].attempts >= 5) {
      // Increment attempts on the latest unused OTP for this email
      const latestUrl =
        `${SUPABASE_URL}/rest/v1/otp_codes?` +
        `email=eq.${encodeURIComponent(email)}` +
        `&used_at=is.null` +
        `&order=created_at.desc&limit=1`;

      const latestRes = await fetch(latestUrl, {
        headers: restHeaders(SERVICE_KEY),
        signal: AbortSignal.timeout(5000),
      });

      let latestRows: Array<{ id: string; attempts: number }> = [];
      try {
        latestRows = (await latestRes.json()) as Array<{ id: string; attempts: number }>;
      } catch {
        // parse error
      }

      if (latestRows.length > 0) {
        const latest = latestRows[0];
        const newAttempts = latest.attempts + 1;

        const patchBody: Record<string, unknown> = { attempts: newAttempts };
        if (newAttempts >= 5) {
          patchBody.used_at = new Date().toISOString();
        }

        await fetch(
          `${SUPABASE_URL}/rest/v1/otp_codes?id=eq.${latest.id}`,
          {
            method: "PATCH",
            headers: { ...restHeaders(SERVICE_KEY), Prefer: "return=minimal" },
            body: JSON.stringify(patchBody),
            signal: AbortSignal.timeout(5000),
          },
        );
      }

      return jsonResponse({ error: "Invalid or expired code" }, 400);
    }

    const matched = rows[0];

    // Mark OTP as used
    await fetch(
      `${SUPABASE_URL}/rest/v1/otp_codes?id=eq.${matched.id}`,
      {
        method: "PATCH",
        headers: { ...restHeaders(SERVICE_KEY), Prefer: "return=minimal" },
        body: JSON.stringify({ used_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(5000),
      },
    );

    // Resolve fresh access state
    const access = await resolveAccess(email, SUPABASE_URL, SERVICE_KEY);

    if (
      access.access === "unauthorized" ||
      access.access === "expired_premium" ||
      access.access === "expired_waitlist"
    ) {
      return jsonResponse({ access: access.access, message: "Access not available." }, 403);
    }

    // Sign JWT (30 days)
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const jwt = await signJwt({ email, access: access.access, exp }, JWT_SECRET);

    return jsonResponse({
      jwt,
      access: access.access,
      expiresAt: access.expiresAt,
      daysLeft: access.daysLeft,
    });
  } catch (err) {
    console.error("[verify-otp] Unexpected error:", err);
    return jsonResponse({ error: "Internal error. Please try again." }, 500);
  }
});
