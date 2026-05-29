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
import { canUseAssistant, resolveAccess, type Plan } from "../_shared/access.ts";

/**
 * Limite mensile messaggi AI di default per piano. Usato come fallback quando
 * `user_credits.messages_limit` è 0/null (riga non ancora popolata da Stripe
 * webhook o creata manualmente senza limite).
 */
const PLAN_DEFAULT_LIMITS: Record<Plan, number> = {
  assistant: 150,
  bundle: 500,
  scout: 0,
};

function defaultLimitForPlan(plan: Plan): number {
  return PLAN_DEFAULT_LIMITS[plan] ?? 0;
}

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
  email?: unknown;
};

async function queryUserCredits(
  filter: string,
  email: string,
): Promise<CreditsRow[] | null> {
  // `select=*` per evitare problemi nel caso in cui una delle colonne specifiche
  // non esista o sia stata rinominata. Non aggiungiamo `order=` per non
  // dipendere da colonne (updated_at/created_at) che potrebbero non esserci.
  const url =
    `${SUPABASE_URL}/rest/v1/user_credits?` +
    `${filter}.${encodeURIComponent(email)}` +
    `&select=*` +
    `&limit=5`;

  console.log("[get-message-quota] user_credits query URL:", url);

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

  try {
    return (await res.json()) as CreditsRow[];
  } catch (err) {
    console.error("[get-message-quota] user_credits JSON parse error:", err);
    return null;
  }
}

/**
 * Legge la riga user_credits per l'utente. Ritorna null se non esiste o errore.
 *
 * Tenta prima `email=eq.<lowercased>`; se la riga non viene trovata fa un
 * fallback case-insensitive con `email=ilike.<lowercased>` (gestisce eventuali
 * row legacy salvate con casing misto).
 */
async function fetchUserCredits(rawEmail: string): Promise<CreditsRow | null> {
  const email = rawEmail.trim().toLowerCase();
  console.log("[get-message-quota] fetching user_credits for email:", email);

  try {
    let rows = await queryUserCredits("email=eq", email);
    if (rows && rows.length === 0) {
      console.warn(
        "[get-message-quota] no row matched email=eq, retrying with ilike",
      );
      rows = await queryUserCredits("email=ilike", email);
    }

    if (!rows) return null;

    console.log("[get-message-quota] rows count:", rows.length);
    if (rows.length === 0) return null;

    const row = rows[0];
    console.log("[get-message-quota] raw row from DB:", JSON.stringify(row));
    return row;
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
    const planFallbackLimit = defaultLimitForPlan(access.plan);

    if (!credits) {
      console.warn(
        "[get-message-quota] no user_credits row for",
        payload.email,
        "→ falling back to plan defaults",
      );
      return jsonResponse({
        messages_used: 0,
        messages_limit: planFallbackLimit,
        messages_period_end: null,
        plan: access.plan,
        access: "premium",
      });
    }

    // Leggi i campi DIRETTAMENTE dalla riga, senza coercion che possa nascondere
    // un null: ci limitiamo a normalizzare il tipo a number/string. Se la
    // colonna manca davvero (undefined) usiamo i fallback espliciti.
    const rawUsed = credits.messages_used;
    const used =
      typeof rawUsed === "number"
        ? rawUsed
        : typeof rawUsed === "string" && rawUsed.trim() !== ""
        ? Number(rawUsed)
        : 0;

    const rawLimit = credits.messages_limit;
    const limitFromRow =
      typeof rawLimit === "number"
        ? rawLimit
        : typeof rawLimit === "string" && rawLimit.trim() !== ""
        ? Number(rawLimit)
        : NaN;
    // Se la riga user_credits ha messages_limit = 0 / null / NaN (es. webhook
    // non ancora arrivato, oppure record creato a mano), deriva dal piano.
    const limit =
      Number.isFinite(limitFromRow) && limitFromRow > 0
        ? limitFromRow
        : planFallbackLimit;

    // messages_period_end è un timestamptz Postgres → PostgREST lo serializza
    // sempre come stringa ISO ("2026-06-18T21:50:57.424066+00:00"). Lo passiamo
    // verbatim, con fallback a `period_end` per schemi legacy.
    let periodEnd: string | null = null;
    if (typeof credits.messages_period_end === "string") {
      periodEnd = credits.messages_period_end;
    } else if (typeof credits.period_end === "string") {
      periodEnd = credits.period_end;
    }

    const responseBody = {
      messages_used: Number.isFinite(used) ? used : 0,
      messages_limit: limit,
      messages_period_end: periodEnd,
      plan: access.plan,
      access: "premium" as const,
    };
    console.log(
      "[get-message-quota] response body:",
      JSON.stringify(responseBody),
    );
    return jsonResponse(responseBody);
  } catch (err) {
    console.error("[get-message-quota] Unexpected error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
