# Linky Assistant — API Edge Functions

Tutte le Edge Functions sono su Supabase (`rfyutermluskpkwwszxm`).
**Base URL:** `https://rfyutermluskpkwwszxm.supabase.co/functions/v1`
**JWT Verification:** OFF su tutte (la verifica è manuale con `AUTH_JWT_SECRET`)

---

## Autenticazione

Le function protette richiedono un JWT custom nell'header:
```
Authorization: Bearer <jwt>
```
Il JWT è firmato con `AUTH_JWT_SECRET` (HS256) e contiene `{ email, access, exp }`.

`generate-message` accetta anche:
```
x-supabase-authorization: Bearer <jwt>
```

---

## request-otp

Genera e invia un OTP via email all'utente.

**POST** `/request-otp`

**Headers:**
```
Content-Type: application/json
```

**Body:**
```json
{ "email": "user@example.com" }
```

**Response 200 — successo (sempre, anche se email non registrata per anti-enumeration):**
```json
{ "ok": true }
```

**Response 429:**
```json
{ "error": "Troppi tentativi. Riprova più tardi." }
```

**Logica interna:**
- Rate limit per IP: max 5/ora
- Rate limit per email: max 1/60s
- Se email non in `utenti` o `utenti_waitlist` → risponde `{ ok: true }` senza mandare l'OTP (anti-enumeration)
- Se email scaduta (`expired_premium` / `expired_waitlist`) → genera OTP comunque, `verify-otp` gestirà il blocco
- OTP: 6 cifre, scade in 10 minuti, salvato come SHA-256 in `otp_codes`

---

## verify-otp

Verifica il codice OTP e restituisce un JWT custom.

**POST** `/verify-otp`

**Headers:**
```
Content-Type: application/json
```

**Body:**
```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

**Response 200 — successo:**
```json
{
  "jwt": "eyJhbGc...",
  "access": "premium",
  "expiresAt": "2026-06-10T10:00:00.000Z",
  "daysLeft": 30
}
```

**Response 200 — successo (trial):**
```json
{
  "jwt": "eyJhbGc...",
  "access": "waitlist_trial",
  "expiresAt": "2026-05-17T10:00:00.000Z",
  "daysLeft": 5
}
```

**Response 400:**
```json
{ "error": "Codice non valido o scaduto" }
```

**Response 403 — accesso scaduto:**
```json
{ "access": "expired_premium", "message": "Accesso non disponibile." }
```
oppure `"expired_waitlist"` o `"unauthorized"`.

**Response 429:**
```json
{ "error": "Troppi tentativi. Riprova più tardi." }
```

**Logica interna:**
- Rate limit: max 10 tentativi/ora per email
- Max 5 tentativi per singolo OTP, poi viene marcato come usato
- JWT custom HS256, scadenza 30 giorni
- Valori `access`: `"premium"` | `"waitlist_trial"`

---

## list-profiles

Restituisce tutti i lead salvati dell'utente autenticato.

**GET** `/list-profiles`

**Headers:**
```
Authorization: Bearer <jwt>
```

**Response 200:**
```json
{
  "profiles": [
    {
      "id": 42,
      "full_name": "Mario Rossi",
      "linkedin_url": "https://www.linkedin.com/in/mario-rossi",
      "comment_text": "Interessante punto sul growth hacking...",
      "comment_url": "https://www.linkedin.com/feed/update/urn:li:activity:...",
      "user_email": "user@example.com",
      "created_at": "2026-05-10T14:30:00.000Z",
      "source": "extension"
    }
  ]
}
```

**Response 401:**
```json
{ "error": "Token non valido o scaduto" }
```

**Note:**
- Ordinati per `created_at DESC`
- Filtra per `user_email = jwt.email` con SERVICE_ROLE_KEY (bypass RLS)
- Il campo `source` può essere `"extension"` o `"scout"` (Linky Scout)

---

## save-profile

Salva un lead nel CRM.

**POST** `/save-profile`

**Headers:**
```
Authorization: Bearer <jwt>
Content-Type: application/json
```

**Body:**
```json
{
  "full_name": "Mario Rossi",
  "linkedin_url": "https://www.linkedin.com/in/mario-rossi",
  "comment_text": "Testo del commento salvato",
  "comment_url": "https://www.linkedin.com/feed/update/urn:li:activity:..."
}
```

**Campi obbligatori:** `full_name`, `linkedin_url`
**Campi opzionali:** `comment_text`, `comment_url`

**Response 200:**
```json
{
  "profile": {
    "id": 42,
    "full_name": "Mario Rossi",
    "linkedin_url": "https://www.linkedin.com/in/mario-rossi",
    "comment_text": "Testo del commento salvato",
    "comment_url": "https://...",
    "user_email": "user@example.com",
    "created_at": "2026-05-10T14:30:00.000Z"
  }
}
```

**Response 400:**
```json
{ "error": "full_name e linkedin_url sono obbligatori" }
```

**Note:**
- Usa `resolution=merge-duplicates` — se il profilo esiste già (stessa `linkedin_url` + `user_email`) viene aggiornato

---

## update-profile

Aggiorna il nome di un lead salvato.

**POST** `/update-profile`

**Headers:**
```
Authorization: Bearer <jwt>
Content-Type: application/json
```

**Body:**
```json
{
  "id": 42,
  "full_name": "Mario Rossi (updated)"
}
```

**Response 200:**
```json
{
  "profile": {
    "id": 42,
    "full_name": "Mario Rossi (updated)",
    "linkedin_url": "...",
    ...
  }
}
```

**Response 404:**
```json
{ "error": "Profilo non trovato" }
```

**Note:**
- Verifica che il profilo appartenga all'utente autenticato (`user_email = jwt.email`)
- Attualmente aggiorna solo `full_name`

---

## delete-profile

Elimina un lead dal CRM.

**POST** `/delete-profile`

**Headers:**
```
Authorization: Bearer <jwt>
Content-Type: application/json
```

**Body:**
```json
{ "id": 42 }
```

**Response 200:**
```json
{ "ok": true, "deleted": 1 }
```

**Note:**
- Verifica che il profilo appartenga all'utente autenticato
- `deleted` è il numero di righe eliminate (0 se non trovato)

---

## search-profile

Cerca un lead per URL LinkedIn (exact + fuzzy fallback).

**POST** `/search-profile`

**Headers:**
```
Authorization: Bearer <jwt>
Content-Type: application/json
```

**Body:**
```json
{ "linkedin_url": "https://www.linkedin.com/in/mario-rossi" }
```

**Response 200 — trovato:**
```json
{
  "profile": {
    "full_name": "Mario Rossi",
    "comment_text": "Testo del commento...",
    "comment_url": "https://...",
    "linkedin_url": "https://www.linkedin.com/in/mario-rossi"
  }
}
```

**Response 200 — non trovato:**
```json
{ "profile": null }
```

**Logica di ricerca:**
1. Match esatto sull'URL normalizzato (senza query params e trailing slash)
2. Se non trovato → fuzzy match con `ILIKE %/in/<slug>%`
3. Restituisce sempre il più recente (`created_at DESC`)

**Uso principale:** `messagingContext.ts` cerca il profilo prima di generare un messaggio trigger

---

## generate-message

Genera un messaggio di outreach LinkedIn con Claude AI.

**POST** `/generate-message`

**Headers:**
```
Authorization: Bearer <jwt>
Content-Type: application/json
```
oppure:
```
x-supabase-authorization: Bearer <jwt>
```

**Body:**
```json
{
  "scenario": "pain",
  "valueProposition": "Aiutiamo i B2B SaaS founder a trovare lead qualificati su LinkedIn",
  "leadName": "Mario Rossi",
  "headline": "Co-founder @ Startup | B2B SaaS",
  "profileUrl": "https://www.linkedin.com/in/mario-rossi",
  "targetLanguage": "Inglese",
  "aiInstructions": "Keep it under 60 words, peer-to-peer tone",
  "triggerText": null,
  "triggerUrl": null,
  "industry": null
}
```

**Campi obbligatori:** `scenario`, `valueProposition`
**Campi opzionali:** tutti gli altri

**Valori scenario:**
- `"pain"` — messaggio basato su pain point non ovvio per il ruolo
- `"founder"` — peer-to-peer, founder a founder
- `"trigger"` — basato su commento/post salvato nel CRM

**Valori targetLanguage:**
- `"Italiano"` (default)
- `"Inglese"`
- `"Spagnolo"`
- `"Tedesco"`

**Response 200:**
```json
{ "message": "Ciao Mario, lavorando con co-founder B2B SaaS..." }
```

**Response 400:**
```json
{ "error": "Required field \"scenario\": \"pain\" | \"founder\" | \"trigger\"" }
```

**Response 400:**
```json
{ "error": "Required field \"valueProposition\": set your value proposition in the extension CRM settings." }
```

**Response 429:**
```json
{ "error": "Rate limit exceeded. Try again later." }
```

**Response 502:**
```json
{ "error": "Anthropic: model not found. Check CLAUDE_MODEL or use a model supported on your account." }
```

**Logica interna:**
- Rate limit: 20 generazioni/ora per email
- Modello primario: `claude-sonnet-4-6`
- Fallback automatico su `claude-3-haiku-20240307` se il modello principale non è disponibile
- `aiInstructions` viene sanitizzato per prevenire prompt injection (max 500 char, pattern dannosi rimossi)
- Il system prompt è in `BASE_SYSTEM_PROMPT` + regole dinamiche per lingua e stile

---

## Shared Utilities (`_shared/`)

### `_shared/jwt.ts`

```typescript
// Firma un JWT custom HS256
signJwt(payload: { email, access, exp }, secret: string): Promise<string>

// Verifica e decode di un JWT custom
verifyJwt(token: string, secret: string): Promise<JwtPayload | null>
// Restituisce null se firma non valida o token scaduto
```

### `_shared/access.ts`

```typescript
resolveAccess(email: string, supabaseUrl: string, serviceKey: string): Promise<AccessResult>
// Controlla utenti → utenti_waitlist
// Restituisce: { access: "premium" | "waitlist_trial", expiresAt, daysLeft }
//           o: { access: "expired_premium" | "expired_waitlist" | "unauthorized" }
```

### `_shared/rateLimit.ts`

```typescript
checkAndRecord({ supabaseUrl, serviceKey, email?, ip?, action, maxPerWindow, windowSeconds })
// Restituisce { allowed: boolean }
// Registra ogni tentativo in auth_rate_limits
// Conta quanti record trovati nell'ultima finestra temporale
```

### `_shared/validation.ts`

```typescript
isValidEmail(s: unknown): s is string  // regex + lunghezza max 254
isValidOtp(s: unknown): s is string    // esattamente 6 cifre numeriche
```

### `_shared/cors.ts`

```typescript
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
}
```

---

## Tabelle database rilevanti

| Tabella | Uso |
|---|---|
| `profili_salvati` | Lead salvati. Colonne: `id`, `full_name`, `linkedin_url`, `comment_text`, `comment_url`, `user_email`, `created_at`, `source` |
| `otp_codes` | Codici OTP temporanei. Colonne: `id`, `email`, `code_hash`, `expires_at`, `used_at`, `attempts`, `ip_address` |
| `auth_rate_limits` | Rate limiting. Colonne: `id`, `email`, `ip_address`, `action`, `created_at` |
| `utenti` | Utenti premium. Colonne: `email`, `expires_at` |
| `utenti_waitlist` | Utenti trial. Colonne: `email`, `created_at`, `source` |

**RLS:** tutte le tabelle hanno policy `deny all` per `anon`/`authenticated`. Accesso solo via SERVICE_ROLE_KEY nelle Edge Functions.

---

## Codici di errore comuni

| Status | Significato |
|---|---|
| 400 | Input mancante o non valido |
| 401 | JWT mancante, non valido o scaduto |
| 403 | Accesso negato (trial scaduto, abbonamento scaduto) |
| 405 | Metodo HTTP non consentito |
| 429 | Rate limit superato |
| 500 | Errore interno server |
| 502 | Errore upstream (Anthropic API) |
