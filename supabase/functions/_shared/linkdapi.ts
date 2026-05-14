/**
 * Provider isolato per LinkdAPI (https://linkdapi.com).
 *
 * Tutta la logica HTTP, gli header di auth e l'unwrap della struttura
 * `{ success, data }` vivono qui. Il resto del progetto non deve importare
 * direttamente da LinkdAPI ma passare per questo modulo.
 *
 * Convenzioni:
 * - Tutti i metodi pubblici ritornano `null` in caso di errore, MAI throw.
 * - `getRecentPosts` ritorna `[]` se il profilo non ha post pubblici
 *   (LinkdAPI in quel caso risponde con 400/500): è un "no posts", non un
 *   errore di provider.
 * - Secret: `Deno.env.get("LINKDAPI_KEY")`.
 */

const BASE_URL = "https://linkdapi.com";
const REQUEST_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Tipi pubblici (modellati sulla risposta documentata di LinkdAPI)
// ---------------------------------------------------------------------------

export type LinkdApiLocation = {
  countryCode?: string;
  countryName?: string;
  city?: string;
  region?: string;
  fullLocation?: string;
};

export type LinkdApiCurrentPosition = {
  urn?: string;
  name?: string;
  url?: string;
  logoURL?: string;
};

export type LinkdApiOverview = {
  urn: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  headline?: string;
  publicIdentifier?: string;
  followerCount?: number;
  connectionsCount?: number;
  location?: LinkdApiLocation;
  currentPositions?: LinkdApiCurrentPosition[];
};

export type LinkdApiPosition = {
  jobTitle?: string;
  company?: string;
  location?: string;
  duration?: string;
  companyLink?: string;
  companyId?: string;
  jobDescription?: string;
};

export type LinkdApiEducation = {
  duration?: string;
  university?: string;
  degree?: string;
  description?: string | null;
};

export type LinkdApiDetails = {
  about?: string;
  positions?: LinkdApiPosition[];
  education?: LinkdApiEducation[];
};

export type LinkdApiPostEngagements = {
  totalReactions?: number;
  commentsCount?: number;
  repostsCount?: number;
};

export type LinkdApiPost = {
  text?: string;
  url?: string;
  urn?: string;
  postedAt?: string;
  edited?: boolean;
  engagements?: LinkdApiPostEngagements;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estrae lo "username" (slug dopo /in/) da un URL LinkedIn.
 * LinkdAPI `profile/overview` richiede questo, non l'URN.
 */
export function extractUsernameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const afterIn = url.split("/in/")[1];
  if (!afterIn) return null;
  const clean = afterIn.split("?")[0].split("/")[0].trim().replace(/\/$/, "");
  return clean || null;
}

type LinkdApiCallResult = {
  ok: boolean;
  status: number;
  data: unknown;
};

async function callLinkdApi(
  endpoint: string,
  params: Record<string, string>,
): Promise<LinkdApiCallResult> {
  const apiKey = Deno.env.get("LINKDAPI_KEY");
  if (!apiKey) {
    console.warn("[linkdapi] LINKDAPI_KEY non configurata: skip enrichment");
    return { ok: false, status: 0, data: null };
  }

  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-linkdapi-apikey": apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[linkdapi] ${endpoint} network error: ${msg}`);
    return { ok: false, status: 0, data: null };
  }

  let body: { success?: boolean; data?: unknown; message?: string } | null = null;
  try {
    body = (await res.json()) as { success?: boolean; data?: unknown; message?: string };
  } catch {
    body = null;
  }

  if (!res.ok || body?.success === false) {
    if (body?.message) {
      console.warn(`[linkdapi] ${endpoint} HTTP ${res.status}: ${body.message}`);
    } else {
      console.warn(`[linkdapi] ${endpoint} HTTP ${res.status}`);
    }
    return { ok: false, status: res.status, data: body?.data ?? null };
  }

  return { ok: true, status: res.status, data: body?.data ?? null };
}

// ---------------------------------------------------------------------------
// API pubblica
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/profile/overview?username=...
 * Ritorna `null` se l'API ha fallito o l'URN non è ricavabile.
 *
 * Nota: l'API ritorna `CurrentPositions` (C maiuscola) — questo provider
 * lo normalizza in `currentPositions` per coerenza con il resto del codice.
 */
export async function getProfileOverview(
  username: string,
): Promise<LinkdApiOverview | null> {
  if (!username) return null;

  const result = await callLinkdApi("/api/v1/profile/overview", { username });
  if (!result.ok || !result.data || typeof result.data !== "object") return null;

  const d = result.data as Record<string, unknown>;
  const urn = typeof d.urn === "string" ? d.urn : "";
  if (!urn) return null;

  const rawCurrent = d.CurrentPositions ?? d.currentPositions;
  const currentPositions = Array.isArray(rawCurrent)
    ? (rawCurrent as LinkdApiCurrentPosition[])
    : undefined;

  return {
    urn,
    firstName: typeof d.firstName === "string" ? d.firstName : undefined,
    lastName: typeof d.lastName === "string" ? d.lastName : undefined,
    fullName: typeof d.fullName === "string" ? d.fullName : undefined,
    headline: typeof d.headline === "string" ? d.headline : undefined,
    publicIdentifier:
      typeof d.publicIdentifier === "string" ? d.publicIdentifier : undefined,
    followerCount:
      typeof d.followerCount === "number" ? d.followerCount : undefined,
    connectionsCount:
      typeof d.connectionsCount === "number" ? d.connectionsCount : undefined,
    location:
      d.location && typeof d.location === "object"
        ? (d.location as LinkdApiLocation)
        : undefined,
    currentPositions,
  };
}

/**
 * GET /api/v1/profile/details?urn=...
 * Ritorna `null` in caso di errore. Il campo bio è in `about`
 * (NON `bio` / `summary` / `description`).
 */
export async function getProfileDetails(
  urn: string,
): Promise<LinkdApiDetails | null> {
  if (!urn) return null;

  const result = await callLinkdApi("/api/v1/profile/details", { urn });
  if (!result.ok || !result.data || typeof result.data !== "object") return null;

  const d = result.data as Record<string, unknown>;
  return {
    about: typeof d.about === "string" ? d.about : undefined,
    positions: Array.isArray(d.positions)
      ? (d.positions as LinkdApiPosition[])
      : undefined,
    education: Array.isArray(d.education)
      ? (d.education as LinkdApiEducation[])
      : undefined,
  };
}

/**
 * GET /api/v1/posts/all?urn=...
 *
 * Comportamento speciale: se il profilo non ha post pubblici LinkdAPI
 * risponde con 4xx/5xx — quel caso lo trattiamo come "no posts" e
 * ritorniamo `[]` invece di `null`. `null` resta riservato a errori
 * "veri" del provider (network, secret mancante, parsing fallito).
 */
export async function getRecentPosts(
  urn: string,
): Promise<LinkdApiPost[] | null> {
  if (!urn) return null;

  const result = await callLinkdApi("/api/v1/posts/all", { urn });

  if (!result.ok) {
    if (result.status >= 400 && result.status < 600) {
      // Profilo senza post pubblici → trattiamo come array vuoto.
      return [];
    }
    return null;
  }

  if (!result.data || typeof result.data !== "object") return [];
  const posts = (result.data as { posts?: unknown }).posts;
  return Array.isArray(posts) ? (posts as LinkdApiPost[]) : [];
}
