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
