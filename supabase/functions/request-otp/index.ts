import { corsHeaders } from "../_shared/cors.ts";
import { isValidEmail } from "../_shared/validation.ts";
import { resolveAccess } from "../_shared/access.ts";
import { checkAndRecord } from "../_shared/rateLimit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "Linky Assistant <noreply@linkyassistant.com>";

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

function generateOtp(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1_000_000).padStart(6, "0");
}

async function fakeDelay(): Promise<void> {
  const ms = 200 + Math.random() * 200;
  await new Promise((r) => setTimeout(r, ms));
}

function extractIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

async function sendOtpEmail(email: string, otp: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: email,
        subject: "Your Linky Assistant code",
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:400px;margin:0 auto;padding:24px;">
            <h2 style="color:#6d47f5;margin-bottom:8px;">Linky</h2>
            <p>Your access code:</p>
            <p style="font-size:32px;font-weight:800;letter-spacing:6px;color:#6d47f5;margin:16px 0;">${otp}</p>
            <p style="font-size:13px;color:#666;">Expires in 10 minutes. Never share this code with anyone.</p>
          </div>
        `,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    console.error("[request-otp] Resend error:", err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    let body: { email?: unknown };
    try {
      body = (await req.json()) as { email?: unknown };
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    if (!isValidEmail(body.email)) {
      return jsonResponse({ error: "Invalid email" }, 400);
    }

    const email = body.email.trim().toLowerCase();
    const ip = extractIp(req);

    // Rate limit per IP: max 5/hour
    const ipCheck = await checkAndRecord({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
      ip,
      action: "request_otp_ip",
      maxPerWindow: 5,
      windowSeconds: 3600,
    });
    if (!ipCheck.allowed) {
      return jsonResponse(
        { error: `Too many attempts. ${ipCheck.retryMessage ?? "Try again later."}` },
        429,
      );
    }

    // Rate limit per email: max 1 in 60s
    const emailCheck = await checkAndRecord({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
      email,
      action: "request_otp_email",
      maxPerWindow: 1,
      windowSeconds: 60,
    });
    if (!emailCheck.allowed) {
      // Anti-enumeration: fake success with delay
      await fakeDelay();
      return jsonResponse({ ok: true });
    }

    // Check access
    const access = await resolveAccess(email, SUPABASE_URL, SERVICE_KEY);

    if (access.access === "unauthorized") {
      await fakeDelay();
      return jsonResponse({ ok: true });
    }

    // For expired users, still generate OTP — verify-otp will tell them the status
    const otp = generateOtp();
    const codeHash = await sha256Hex(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Insert OTP record
    await fetch(`${SUPABASE_URL}/rest/v1/otp_codes`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        email,
        code_hash: codeHash,
        expires_at: expiresAt,
        ip_address: ip,
      }),
      signal: AbortSignal.timeout(5000),
    });

    // Send email (log failures but always return 200)
    await sendOtpEmail(email, otp);

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("[request-otp] Unexpected error:", err);
    return jsonResponse({ ok: true });
  }
});
