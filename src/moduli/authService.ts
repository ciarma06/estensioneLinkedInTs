export type AuthState = {
  jwt: string;
  email: string;
  access: "premium" | "waitlist_trial";
  expiresAt: string;
  daysLeft: number;
  checkedAt: number;
};

export type RequestOtpResult = { ok: true } | { ok: false; message: string };

export type VerifyOtpResult =
  | AuthState
  | { access: "expired_premium" | "expired_waitlist" | "unauthorized" | "error"; message?: string };

const REQUEST_OTP_URL = import.meta.env.VITE_REQUEST_OTP_URL as string;
const VERIFY_OTP_URL = import.meta.env.VITE_VERIFY_OTP_URL as string;

const STORAGE_KEY = "crm_auth";
const JWT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function isAuthState(v: unknown): v is AuthState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.jwt === "string" &&
    typeof o.email === "string" &&
    (o.access === "premium" || o.access === "waitlist_trial") &&
    typeof o.expiresAt === "string" &&
    typeof o.daysLeft === "number" &&
    typeof o.checkedAt === "number"
  );
}

export async function requestOtp(email: string): Promise<RequestOtpResult> {
  try {
    const res = await fetch(REQUEST_OTP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 429) {
      return { ok: false, message: "Troppi tentativi. Riprova tra un minuto." };
    }

    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, message: "Risposta non valida dal server." };
    }

    if (data.ok === true) return { ok: true };
    return { ok: false, message: String(data.error ?? "Errore sconosciuto.") };
  } catch {
    return { ok: false, message: "Errore di connessione. Verifica la tua rete." };
  }
}

export async function verifyOtp(email: string, code: string): Promise<VerifyOtpResult> {
  try {
    const res = await fetch(VERIFY_OTP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
      signal: AbortSignal.timeout(10_000),
    });

    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      return { access: "error", message: "Risposta non valida dal server." };
    }

    if (res.status === 429) {
      return { access: "error", message: "Troppi tentativi. Riprova più tardi." };
    }

    if (res.status === 403) {
      const access = data.access as string;
      if (access === "expired_premium" || access === "expired_waitlist" || access === "unauthorized") {
        return { access, message: String(data.message ?? "") };
      }
      return { access: "error", message: String(data.message ?? "Accesso negato.") };
    }

    if (res.status === 400) {
      return { access: "error", message: String(data.error ?? "Codice non valido.") };
    }

    if (!res.ok) {
      return { access: "error", message: String(data.error ?? "Errore del server.") };
    }

    if (typeof data.jwt !== "string" || typeof data.access !== "string") {
      return { access: "error", message: "Risposta incompleta dal server." };
    }

    const state: AuthState = {
      jwt: data.jwt as string,
      email,
      access: data.access as "premium" | "waitlist_trial",
      expiresAt: String(data.expiresAt ?? ""),
      daysLeft: Number(data.daysLeft ?? 0),
      checkedAt: Date.now(),
    };

    return state;
  } catch {
    return { access: "error", message: "Errore di connessione. Verifica la tua rete." };
  }
}

export async function getStoredAuth(): Promise<AuthState | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const raw = result[STORAGE_KEY];
    if (!isAuthState(raw)) return null;

    if (Date.now() - raw.checkedAt > JWT_MAX_AGE_MS) return null;

    return raw;
  } catch {
    return null;
  }
}

export async function saveAuth(state: AuthState): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  } catch {
    // storage write failed
  }
}

export async function clearAuth(): Promise<void> {
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch {
    // storage remove failed
  }
}

export async function getJwt(): Promise<string | null> {
  const stored = await getStoredAuth();
  return stored?.jwt ?? null;
}

export function isAccessStillValid(state: AuthState): boolean {
  const expMs = new Date(state.expiresAt).getTime();
  return expMs >= Date.now();
}
