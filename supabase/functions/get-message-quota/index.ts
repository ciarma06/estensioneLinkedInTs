//get-message-quota/index.ts

/// <reference path="./deno-env.d.ts" />

/**
 * Edge Function: ritorna lo stato della quota mensile messaggi AI per l'utente
 * autenticato (Linky Assistant).
 *
 * - POST con body vuoto, JWT in `Authorization: Bearer ...`.
 * - Risponde 401 se JWT mancante/invalido o se l'utente non ha accesso al
 *   prodotto Assistant (es. plan = "scout").
 * - Per waitlist_trial restituisce campi `null` (gate orario, non quota).
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyJwt } from "../_shared/jwt.ts";
import { canUseAssistant, resolveAccess } from "../_shared/access.ts";

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

type CreditsRow = {
  messages_used?: unknown;
  messages_limit?: unknown;
  messages_period_end?: unknown;
  period_end?: unknown;
};

/**
 * Legge la riga user_credits per l'utente. Ritorna null se non esiste o errore.
 */
async function fetchUserCredits(email: string): Promise<CreditsRow | null> {
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/user_credits?` +
      `email=eq.${encodeURIComponent(email)}` +
      `&select=messages_used,messages_limit,messages_period_end,period_end` +
      `&limit=1`;

    const res = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(
        "[get-message-quota] user_credits HTTP",
        res.status,
        await res.text().catch(() => ""),
      );
      return null;
    }

    const rows = (await res.json()) as CreditsRow[];
    return rows[0] ?? null;
  } catch (err) {
    console.error("[get-message-quota] user_credits fetch error:", err);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!SUPABASE_URL || !SERVICE_KEY || !JWT_SECRET) {
    return jsonResponse({ error: "Server: secrets not configured" }, 500);
  }

  try {
    const token = extractBearer(req);
    if (!token) return jsonResponse({ error: "Missing authorization" }, 401);

    const payload = await verifyJwt(token, JWT_SECRET);
    if (!payload) return jsonResponse({ error: "Invalid or expired token" }, 401);

    const access = await resolveAccess(
      payload.email,
      SUPABASE_URL,
      SERVICE_KEY,
      "assistant",
    );

    if (!canUseAssistant(access)) {
      const reason =
        access.access === "premium" ? "no_assistant_in_plan" : access.access;
      const planInResponse = access.access === "premium" ? access.plan : null;
      return jsonResponse(
        { error: "Unauthorized", reason, plan: planInResponse },
        401,
      );
    }

    // Waitlist trial: nessuna quota mensile (gate via rate limit orario).
    if (access.access === "waitlist_trial") {
      return jsonResponse({
        messages_used: null,
        messages_limit: null,
        messages_period_end: null,
        plan: null,
        access: "waitlist_trial",
      });
    }

    // Guard: dopo canUseAssistant + esclusione trial l'unica variante possibile
    // è "premium", ma TS non riesce a inferirlo (canUseAssistant non è un type
    // predicate). Questo branch non dovrebbe mai essere raggiunto a runtime.
    if (access.access !== "premium") {
      console.error("[get-message-quota] Unexpected access state:", access);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    // Premium: leggi user_credits.
    const credits = await fetchUserCredits(payload.email);
    if (!credits) {
      return jsonResponse({
        messages_used: 0,
        messages_limit: 0,
        messages_period_end: null,
        plan: access.plan,
        access: "premium",
      });
    }

    const used = Number(credits.messages_used ?? 0);
    const limit = Number(credits.messages_limit ?? 0);
    const periodEnd =
      typeof credits.messages_period_end === "string"
        ? credits.messages_period_end
        : typeof credits.period_end === "string"
        ? credits.period_end
        : null;

    return jsonResponse({
      messages_used: used,
      messages_limit: limit,
      messages_period_end: periodEnd,
      plan: access.plan,
      access: "premium",
    });
  } catch (err) {
    console.error("[get-message-quota] Unexpected error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
