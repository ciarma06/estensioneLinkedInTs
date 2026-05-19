//_shared/access.ts

export type Product = "assistant" | "scout";
export type Plan = "assistant" | "scout" | "bundle";

/**
 * Mappa il piano commerciale all'elenco dei prodotti a cui dà accesso.
 * Aggiornato dal repo Scout: ora due prodotti (assistant + scout) e un piano
 * combinato (bundle).
 */
export const PLAN_GRANTS: Record<Plan, readonly Product[]> = {
  assistant: ["assistant"],
  scout: ["scout"],
  bundle: ["assistant", "scout"],
};

export type AccessResult =
  | {
      access: "premium";
      plan: Plan;
      expiresAt: string;
      daysLeft: number;
    }
  | {
      access: "waitlist_trial";
      expiresAt: string;
      daysLeft: number;
    }
  | { access: "expired_premium" | "expired_waitlist" | "unauthorized" };

type ActiveSubscriptionRow = {
  plan?: unknown;
  status?: unknown;
  current_period_end?: unknown;
};

function restHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}

async function queryTable(
  supabaseUrl: string,
  serviceKey: string,
  table: string,
  email: string,
): Promise<Record<string, unknown>[]> {
  const url = `${supabaseUrl}/rest/v1/${table}?email=eq.${encodeURIComponent(email)}&select=*`;
  const res = await fetch(url, {
    headers: restHeaders(serviceKey),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  try {
    return (await res.json()) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

function isPlan(value: unknown): value is Plan {
  return value === "assistant" || value === "scout" || value === "bundle";
}

/**
 * Restituisce la subscription attiva con scadenza più lontana, oppure null.
 * Tollera schema con o senza colonna `status`.
 */
async function findActiveSubscription(
  supabaseUrl: string,
  serviceKey: string,
  email: string,
): Promise<{ plan: Plan; periodEnd: string } | null> {
  const rows = await queryTable(supabaseUrl, serviceKey, "user_subscriptions", email);
  if (rows.length === 0) return null;

  const now = Date.now();
  let best: { plan: Plan; periodEnd: string; expMs: number } | null = null;

  for (const raw of rows as ActiveSubscriptionRow[]) {
    const plan = raw.plan;
    if (!isPlan(plan)) continue;

    const status = typeof raw.status === "string" ? raw.status : null;
    if (status && status !== "active" && status !== "trialing") continue;

    const periodEnd =
      typeof raw.current_period_end === "string" ? raw.current_period_end : null;
    if (!periodEnd) continue;

    const expMs = new Date(periodEnd).getTime();
    if (Number.isNaN(expMs) || expMs < now) continue;

    if (!best || expMs > best.expMs) {
      best = { plan, periodEnd, expMs };
    }
  }

  return best ? { plan: best.plan, periodEnd: best.periodEnd } : null;
}

/**
 * Risolve lo stato di accesso dell'utente identificato da email.
 *
 * Priorità sorgenti:
 * 1. user_subscriptions (Stripe/landing) — fonte di verità per `plan`.
 * 2. utenti_waitlist — 7 giorni di trial dal created_at.
 *
 * `requiredProduct` è informativo: il gate effettivo è demandato a
 * `canUseScout` / `canUseAssistant` sui call site.
 */
export async function resolveAccess(
  rawEmail: string,
  supabaseUrl: string,
  serviceKey: string,
  // deno-lint-ignore no-unused-vars
  requiredProduct?: Product,
): Promise<AccessResult> {
  const email = rawEmail.trim().toLowerCase();
  const now = Date.now();

  // 1. user_subscriptions (nuovo modello, fonte di verità per il plan)
  const sub = await findActiveSubscription(supabaseUrl, serviceKey, email);
  if (sub) {
    const expMs = new Date(sub.periodEnd).getTime();
    const daysLeft = Math.ceil((expMs - now) / 86_400_000);
    return {
      access: "premium",
      plan: sub.plan,
      expiresAt: sub.periodEnd,
      daysLeft,
    };
  }

  // 2. utenti_waitlist (trial 7 giorni)
  const waitlist = await queryTable(supabaseUrl, serviceKey, "utenti_waitlist", email);
  if (waitlist.length > 0) {
    const row = waitlist[0];
    const createdAt = row.created_at as string | null;
    if (createdAt) {
      const trialEnd = new Date(createdAt).getTime() + 7 * 86_400_000;
      if (trialEnd >= now) {
        const expiresAt = new Date(trialEnd).toISOString();
        const daysLeft = Math.ceil((trialEnd - now) / 86_400_000);
        return { access: "waitlist_trial", expiresAt, daysLeft };
      }
    }
    return { access: "expired_waitlist" };
  }

  return { access: "unauthorized" };
}

/**
 * True se l'utente può usare le feature del prodotto Scout (linkedin scraping
 * + ricerca lead). Trial waitlist incluso per UX onboarding.
 */
export function canUseScout(result: AccessResult): boolean {
  if (result.access === "waitlist_trial") return true;
  if (result.access === "premium") {
    return PLAN_GRANTS[result.plan].includes("scout");
  }
  return false;
}

/**
 * True se l'utente può usare le feature del prodotto Assistant (generazione
 * messaggi AI). Trial waitlist incluso (con rate limit orario gestito a parte).
 */
export function canUseAssistant(result: AccessResult): boolean {
  if (result.access === "waitlist_trial") return true;
  if (result.access === "premium") {
    return PLAN_GRANTS[result.plan].includes("assistant");
  }
  return false;
}
