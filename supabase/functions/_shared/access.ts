//_shared/access.ts

export type Plan = "assistant" | "scout" | "bundle";
export type AccessKind = "premium" | "trial" | "trial_ended" | "expired" | "none";

export type AccessResult =
  | { access: "premium"; plan: Plan; expiresAt: string; daysLeft: number }
  | { access: "trial"; plan: "trial"; expiresAt: string; daysLeft: number }
  | { access: "trial_ended"; plan: "trial"; expiresAt: string }
  | { access: "expired"; plan: Plan; expiresAt: string }
  | { access: "none" };

export const PLAN_GRANTS: Record<Plan, readonly ("assistant" | "scout")[]> = {
  assistant: ["assistant"],
  scout: ["scout"],
  bundle: ["assistant", "scout"],
};

function restHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}

async function restGet(
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

export async function resolveAccess(
  rawEmail: string,
  supabaseUrl: string,
  serviceKey: string,
  // deno-lint-ignore no-unused-vars
  requiredProduct?: Plan,
): Promise<AccessResult> {
  const email = rawEmail.trim().toLowerCase();
  const now = Date.now();

  const rows = await restGet(supabaseUrl, serviceKey, "user_subscriptions", email);
  if (rows.length === 0) return { access: "none" };

  const row = rows[0];
  const planRaw = String(row.plan ?? "").toLowerCase();
  const expIso = row.current_period_end as string | null;
  if (!expIso) return { access: "none" };
  const expMs = Date.parse(expIso);
  if (!Number.isFinite(expMs)) return { access: "none" };

  const isActive = row.status === "active" && expMs > now;
  const daysLeft = Math.ceil((expMs - now) / 86_400_000);

  if (planRaw === "trial") {
    if (isActive) return { access: "trial", plan: "trial", expiresAt: expIso, daysLeft };
    return { access: "trial_ended", plan: "trial", expiresAt: expIso };
  }

  if (planRaw === "assistant" || planRaw === "scout" || planRaw === "bundle") {
    if (isActive) return { access: "premium", plan: planRaw, expiresAt: expIso, daysLeft };
    return { access: "expired", plan: planRaw, expiresAt: expIso };
  }

  return { access: "none" };
}

export function canUseScout(result: AccessResult): boolean {
  if (result.access === "trial") return true;
  if (result.access === "premium") {
    return PLAN_GRANTS[result.plan].includes("scout");
  }
  return false;
}

export function canUseAssistant(result: AccessResult): boolean {
  if (result.access === "trial") return true;
  if (result.access === "premium") {
    return PLAN_GRANTS[result.plan].includes("assistant");
  }
  return false;
}
