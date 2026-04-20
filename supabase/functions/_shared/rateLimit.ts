type CheckParams = {
  supabaseUrl: string;
  serviceKey: string;
  email?: string;
  ip?: string;
  action: string;
  maxPerWindow: number;
  windowSeconds: number;
};

export async function checkAndRecord(params: CheckParams): Promise<{ allowed: boolean }> {
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
  if (params.email) {
    filterParts += `&email=eq.${encodeURIComponent(params.email)}`;
  } else if (params.ip) {
    filterParts += `&ip_address=eq.${encodeURIComponent(params.ip)}`;
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
    return { allowed: false };
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

  return { allowed: true };
}
