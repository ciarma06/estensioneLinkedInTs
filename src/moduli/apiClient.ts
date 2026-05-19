import { getJwt, clearAuth } from './authService';

const BASE_URL = import.meta.env.VITE_EDGE_FUNCTIONS_BASE_URL as string;

export type Profile = {
  id: number | string;
  full_name: string;
  linkedin_url: string;
  comment_text: string | null;
  comment_url: string | null;
  created_at?: string;
  user_email?: string;
};

export type SaveProfileInput = {
  full_name: string;
  linkedin_url: string;
  comment_text?: string;
  comment_url?: string;
};

type ApiOk<T> = T;
type ApiErr = { error: string; authExpired?: boolean };

async function authedFetch<T>(
  path: string,
  options: { method: string; body?: unknown },
): Promise<ApiOk<T> | ApiErr> {
  const jwt = await getJwt();
  if (!jwt) return { error: "not_authenticated", authExpired: true };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  };

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/${path}`, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { error: "Connection error." };
  }

  if (res.status === 401) {
    await clearAuth();
    let msg = "Session expired.";
    try {
      const data = (await res.json()) as Record<string, unknown>;
      if (typeof data.error === "string") msg = data.error;
    } catch {
      // parse error
    }
    return { error: msg, authExpired: true };
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return { error: "Invalid response from server." };
  }

  if (!res.ok) {
    return { error: String(data.error ?? "Server error.") };
  }

  return data as unknown as T;
}

export function apiListProfiles(): Promise<{ profiles: Profile[] } | ApiErr> {
  return authedFetch<{ profiles: Profile[] }>("list-profiles", { method: "GET" });
}

export function apiSaveProfile(data: SaveProfileInput): Promise<{ profile: Profile } | ApiErr> {
  return authedFetch<{ profile: Profile }>("save-profile", { method: "POST", body: data });
}

export function apiDeleteProfile(id: number | string): Promise<{ ok: boolean; deleted?: number } | ApiErr> {
  return authedFetch<{ ok: boolean; deleted?: number }>("delete-profile", { method: "POST", body: { id } });
}

export function apiUpdateProfile(
  id: number | string,
  fullName: string,
): Promise<{ profile: Profile } | ApiErr> {
  return authedFetch<{ profile: Profile }>("update-profile", {
    method: "POST",
    body: { id, full_name: fullName },
  });
}

export function apiSearchProfile(
  linkedinUrl: string,
): Promise<{ profile: Profile | null } | ApiErr> {
  return authedFetch<{ profile: Profile | null }>("search-profile", {
    method: "POST",
    body: { linkedin_url: linkedinUrl },
  });
}

export type Plan = 'assistant' | 'scout' | 'bundle';

export type MessageQuota = {
  messages_used: number | null;
  messages_limit: number | null;
  messages_period_end: string | null;
  plan: Plan | null;
  access: string;
};

/**
 * Recupera lo stato della quota mensile messaggi AI per l'utente autenticato.
 *
 * - Per gli utenti premium ritorna i contatori reali da `user_credits`.
 * - Per il `waitlist_trial` i campi quota sono `null` (gate orario).
 *
 * Lancia `Error` con messaggio significativo per failure di rete / 5xx, in modo
 * che il caller possa gestire la UI di errore senza dover ispezionare ApiErr.
 */
export async function fetchMessageQuota(jwt: string): Promise<MessageQuota> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/get-message-quota`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[apiClient] fetchMessageQuota network error:", err);
    throw new Error("Connection error.");
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid response from server.");
  }

  if (!res.ok) {
    const msg = typeof data.error === "string" ? data.error : "Server error.";
    const err = new Error(msg) as Error & {
      status?: number;
      reason?: string;
      plan?: Plan | null;
    };
    err.status = res.status;
    if (typeof data.reason === "string") err.reason = data.reason;
    if (data.plan === null || data.plan === "assistant" || data.plan === "scout" || data.plan === "bundle") {
      err.plan = data.plan as Plan | null;
    }
    throw err;
  }

  return {
    messages_used:
      typeof data.messages_used === "number" ? data.messages_used : null,
    messages_limit:
      typeof data.messages_limit === "number" ? data.messages_limit : null,
    messages_period_end:
      typeof data.messages_period_end === "string"
        ? data.messages_period_end
        : null,
    plan:
      data.plan === "assistant" || data.plan === "scout" || data.plan === "bundle"
        ? (data.plan as Plan)
        : null,
    access: typeof data.access === "string" ? data.access : "unknown",
  };
}
