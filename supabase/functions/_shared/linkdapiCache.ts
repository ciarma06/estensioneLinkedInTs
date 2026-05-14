/**
 * Cache 24h per le risposte di LinkdAPI, su tabella `linkdapi_cache`.
 *
 * Schema atteso (già creato nel DB, non ricreare qui):
 *   id            BIGSERIAL PK
 *   linkedin_url  TEXT UNIQUE
 *   profile_data  JSONB
 *   posts_data    JSONB
 *   fetched_at    TIMESTAMPTZ
 *
 * Convenzioni:
 * - Tutte le operazioni passano da SERVICE_ROLE_KEY (RLS bypass).
 * - Errori network/parsing → considerati cache miss / no-op,
 *   non blocchiamo il flow di generazione del messaggio.
 */

const TTL_HOURS = 24;
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

function restHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}

export type CachedProfile = {
  profileData: unknown;
  postsData: unknown;
};

/**
 * Ritorna i dati cached per `linkedinUrl` se `fetched_at > now() - 24h`,
 * altrimenti `null` (cache miss o riga troppo vecchia).
 */
export async function getCachedProfile(
  supabaseUrl: string,
  serviceKey: string,
  linkedinUrl: string,
): Promise<CachedProfile | null> {
  if (!linkedinUrl) return null;

  const url =
    `${supabaseUrl}/rest/v1/linkdapi_cache` +
    `?linkedin_url=eq.${encodeURIComponent(linkedinUrl)}` +
    `&select=profile_data,posts_data,fetched_at&limit=1`;

  try {
    const res = await fetch(url, {
      headers: restHeaders(serviceKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const rows = (await res.json()) as Array<{
      profile_data: unknown;
      posts_data: unknown;
      fetched_at: string | null;
    }>;
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const row = rows[0];
    if (!row.fetched_at) return null;

    const fetchedAt = new Date(row.fetched_at).getTime();
    if (Number.isNaN(fetchedAt)) return null;
    if (Date.now() - fetchedAt > TTL_MS) return null;

    return {
      profileData: row.profile_data ?? null,
      postsData: row.posts_data ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[linkdapiCache] read failed for ${linkedinUrl}: ${msg}`);
    return null;
  }
}

/**
 * Upsert ON CONFLICT (linkedin_url) DO UPDATE.
 * Non solleva eccezioni: se la scrittura fallisce, la prossima chiamata
 * ricalcolerà il fetch da LinkdAPI.
 */
export async function setCachedProfile(
  supabaseUrl: string,
  serviceKey: string,
  linkedinUrl: string,
  profileData: unknown,
  postsData: unknown,
): Promise<void> {
  if (!linkedinUrl) return;

  const url = `${supabaseUrl}/rest/v1/linkdapi_cache?on_conflict=linkedin_url`;
  const body = {
    linkedin_url: linkedinUrl,
    profile_data: profileData ?? null,
    posts_data: postsData ?? null,
    fetched_at: new Date().toISOString(),
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        ...restHeaders(serviceKey),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[linkdapiCache] write failed for ${linkedinUrl}: ${msg}`);
  }
}
