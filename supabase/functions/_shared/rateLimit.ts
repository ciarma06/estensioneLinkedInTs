type CheckParams = {
  supabaseUrl: string;
  serviceKey: string;
  email?: string;
  ip?: string;
  action: string;
  maxPerWindow: number;
  windowSeconds: number;
};

type CheckResult = {
  allowed: boolean;
  retryMessage?: string;
};

/**
 * Costruisce un messaggio di retry human-readable a partire dalla finestra
 * temporale del rate limit, così il messaggio mostrato all'utente è sempre
 * coerente con `windowSeconds` (es. 3600 → "Try again in 1 hour.",
 * 60 → "Try again in 1 minute.").
 */
function buildRetryMessage(windowSeconds: number): string {
  if (windowSeconds <= 0) return "Please try again later.";

  if (windowSeconds % 3600 === 0) {
    const hours = windowSeconds / 3600;
    return `Please try again in ${hours} ${hours === 1 ? "hour" : "hours"}.`;
  }
  if (windowSeconds % 60 === 0) {
    const minutes = windowSeconds / 60;
    return `Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  return `Please try again in ${windowSeconds} seconds.`;
}

export async function checkAndRecord(params: CheckParams): Promise<CheckResult> {
  const { supabaseUrl, serviceKey, action, maxPerWindow, windowSeconds } = params;
  const baseUrl = `${supabaseUrl}/rest/v1/auth_rate_limits`;
  const headers: Record<string, string> = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };

  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();

  let filterParts = `action=eq.${encodeURIComponent(action)}&created_at=gte.${encodeURIComponent(since)}`;
  let keyFilter = "";
  if (params.email) {
    const part = `email=eq.${encodeURIComponent(params.email)}`;
    filterParts += `&${part}`;
    keyFilter = part;
  } else if (params.ip) {
    const part = `ip_address=eq.${encodeURIComponent(params.ip)}`;
    filterParts += `&${part}`;
    keyFilter = part;
  } else {
    return { allowed: true };
  }

  const countUrl = `${baseUrl}?${filterParts}&select=id`;
  const countRes = await fetch(countUrl, {
    headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
    signal: AbortSignal.timeout(5000),
  });

  const countHeader = countRes.headers.get("content-range");
  let count = 0;
  if (countHeader) {
    const match = countHeader.match(/\/(\d+)/);
    if (match) count = parseInt(match[1], 10);
  }

  if (count >= maxPerWindow) {
    return { allowed: false, retryMessage: buildRetryMessage(windowSeconds) };
  }

  const insertBody: Record<string, string> = { action };
  if (params.email) insertBody.email = params.email;
  if (params.ip) insertBody.ip_address = params.ip;

  await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(insertBody),
    signal: AbortSignal.timeout(5000),
  });

  // Cleanup: elimina le entries più vecchie della finestra per questa
  // combinazione (email|ip)+action. Evita che la tabella cresca all'infinito
  // e impedisce blocchi causati da residui storici. Fire-and-forget: un
  // errore qui non deve compromettere il rate-limiting (la count query
  // sopra resta comunque autorevole perché filtra già su created_at).
  try {
    const deleteUrl =
      `${baseUrl}?${keyFilter}` +
      `&action=eq.${encodeURIComponent(action)}` +
      `&created_at=lt.${encodeURIComponent(since)}`;
    await fetch(deleteUrl, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn("[rateLimit] cleanup delete failed:", err);
  }

  return { allowed: true };
}
