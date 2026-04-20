export type AccessResult =
  | { access: "premium" | "waitlist_trial"; expiresAt: string; daysLeft: number }
  | { access: "expired_premium" | "expired_waitlist" | "unauthorized" };

async function queryTable(
  supabaseUrl: string,
  serviceKey: string,
  table: string,
  email: string,
): Promise<Record<string, unknown>[]> {
  const url = `${supabaseUrl}/rest/v1/${table}?email=eq.${encodeURIComponent(email)}&select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
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
): Promise<AccessResult> {
  const email = rawEmail.trim().toLowerCase();
  const now = Date.now();

  const utenti = await queryTable(supabaseUrl, serviceKey, "utenti", email);
  if (utenti.length > 0) {
    const row = utenti[0];
    const expiresAt = row.expires_at as string | null;
    if (expiresAt) {
      const expMs = new Date(expiresAt).getTime();
      if (expMs >= now) {
        const daysLeft = Math.ceil((expMs - now) / 86_400_000);
        return { access: "premium", expiresAt, daysLeft };
      }
    }
    return { access: "expired_premium" };
  }

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
