# Linky Assistant — Workflow e Architettura

---

## Overview

Linky Assistant è una Chrome Extension MV3 per LinkedIn che permette di:
- Salvare profili lead dai commenti con un click
- Gestire i lead in un mini CRM nel sidepanel
- Generare messaggi di outreach personalizzati con Claude AI direttamente nella chat LinkedIn

---

## Stack tecnologico

| Componente | Tecnologia |
|---|---|
| Extension runtime | Chrome Extension MV3 |
| Frontend | TypeScript + Vite + CRXJS |
| Backend | Supabase Edge Functions (Deno) |
| Database | Supabase Postgres |
| Email delivery | Resend |
| AI generation | Anthropic Claude (claude-sonnet-4-6) |
| Auth | Custom JWT (HS256) + OTP via email |

---

## Struttura del progetto

```
.
├── src/
│   ├── background/index.ts       # Service worker MV3
│   ├── content/index.ts          # Content script LinkedIn
│   ├── moduli/
│   │   ├── authService.ts        # OTP + JWT persistence
│   │   ├── apiClient.ts          # Chiamate autenticate alle Edge Functions
│   │   ├── messageGenerator.ts   # Bottone AI + menu dropdown
│   │   ├── messagingContext.ts   # Scraping contesto chat LinkedIn
│   │   ├── messageComposer.ts    # Inserimento testo nel composer LinkedIn
│   │   ├── profileSaver.ts       # Estrazione profilo da commento + salvataggio CRM
│   │   ├── floatingButton.ts     # Bottone floating CRM
│   │   ├── crm.ts                # Sidepanel UI logic
│   │   ├── userSettings.ts       # Value prop, lingua, AI instructions
│   │   └── supabase.ts           # Supabase client bootstrap
│   ├── sidepanel.css
│   ├── content-floating-crm.css
│   └── style.css
├── supabase/
│   └── functions/
│       ├── _shared/              # JWT, CORS, access resolver, rate limit
│       ├── request-otp/
│       ├── verify-otp/
│       ├── list-profiles/
│       ├── save-profile/
│       ├── update-profile/
│       ├── delete-profile/
│       ├── search-profile/
│       └── generate-message/
├── manifest.json
├── sidepanel.html
├── vite.config.ts
└── tsconfig.json
```

---

## Architettura Auth

### Flusso completo

```
1. Utente inserisce email nel sidepanel
         ↓
2. request-otp Edge Function
   - Valida formato email
   - Controlla accesso (utenti / utenti_waitlist)
   - Rate limit per IP (max 5/ora) + per email (max 1/60s)
   - Anti-enumeration: se email non registrata → finge successo
   - Genera OTP 6 cifre, salva hash SHA-256 in otp_codes
   - Invia email via Resend
         ↓
3. Utente inserisce il codice OTP
         ↓
4. verify-otp Edge Function
   - Valida OTP (hash, scadenza, tentativi max 5)
   - Controlla accesso (premium / waitlist_trial / expired)
   - Firma JWT custom HS256 con AUTH_JWT_SECRET (30 giorni)
   - Ritorna { jwt, access, expiresAt, daysLeft }
         ↓
5. Extension salva in chrome.storage.local (chiave: "crm_auth")
   { jwt, email, access, expiresAt, daysLeft, checkedAt }
         ↓
6. Chiamate autenticate alle Edge Functions
   Header: Authorization: Bearer <jwt>
   oppure: x-supabase-authorization: Bearer <jwt>
```

### JWT custom

- **Algoritmo**: HS256 (HMAC SHA-256)
- **Claims**: `{ email, access, exp }`
- **Scadenza**: 30 giorni
- **Secret**: `AUTH_JWT_SECRET` (Supabase secret)

### Livelli di accesso

| Valore `access` | Significato |
|---|---|
| `premium` | Utente pagante in tabella `utenti` con `expires_at` futuro |
| `waitlist_trial` | Utente in `utenti_waitlist`, trial 7 giorni dall'iscrizione |
| `expired_premium` | Era premium, abbonamento scaduto |
| `expired_waitlist` | Trial 7 giorni terminato |
| `unauthorized` | Email non presente in nessuna tabella |

---

## Database

### Tabelle principali

**`profili_salvati`** — Lead salvati dall'estensione:
```sql
id             BIGSERIAL PRIMARY KEY
created_at     TIMESTAMP WITH TIME ZONE
full_name      TEXT
linkedin_url   TEXT
comment_text   TEXT
comment_url    TEXT
user_email     TEXT
source         TEXT DEFAULT 'extension'  -- aggiunto per Linky Scout
```

**`otp_codes`** — Codici OTP temporanei:
```sql
id          UUID PRIMARY KEY
email       TEXT
code_hash   TEXT  -- SHA-256 del codice
created_at  TIMESTAMPTZ
expires_at  TIMESTAMPTZ
used_at     TIMESTAMPTZ
attempts    INT DEFAULT 0
ip_address  TEXT
```

**`auth_rate_limits`** — Rate limiting:
```sql
id          BIGSERIAL PRIMARY KEY
email       TEXT
ip_address  TEXT
action      TEXT
created_at  TIMESTAMPTZ
```

**`utenti`** — Utenti paganti:
```sql
email       TEXT
expires_at  TEXT  -- data scadenza abbonamento
```

**`utenti_waitlist`** — Utenti in trial:
```sql
email       TEXT
created_at  TIMESTAMPTZ  -- usato per calcolare 7 giorni di trial
source      TEXT
```

### RLS

Tutte le tabelle sensibili hanno RLS abilitato con policy `deny all` per `anon` e `authenticated`. Le operazioni passano esclusivamente attraverso le Edge Functions con `SERVICE_ROLE_KEY`.

---

## Edge Functions

### Pattern comune

Tutte le Edge Functions protette seguono questo pattern:

```typescript
// 1. Gestisci OPTIONS (CORS preflight)
if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

// 2. Estrai e verifica JWT custom
const token = req.headers.get("authorization")?.slice(7);
const payload = await verifyJwt(token, JWT_SECRET);
if (!payload) return 401;

// 3. Verifica accesso utente
const access = await resolveAccess(payload.email, SUPABASE_URL, SERVICE_KEY);
if (access !== "premium" && access !== "waitlist_trial") return 401;

// 4. Logica di business con SERVICE_ROLE_KEY
```

### CORS headers

```typescript
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
```

---

## Content Script — Flusso salvataggio lead

```
Utente vede commento su LinkedIn
         ↓
Content script inietta bottone "Save" nella action bar del commento
(COMMENT_ROOT_SELECTOR: .comments-comment-entity, [componentkey^="replaceableComment_"])
         ↓
Click su "Save"
         ↓
extractProfileFromComment(commentElement):
  - Trova link /in/ → estrae linkedin_url e nome
  - Trova testo commento (.update-components-text, ecc.)
  - Ricostruisce URL deep link del commento (con commentUrn, dashCommentUrn)
         ↓
saveToCRM(profile):
  - Verifica auth valida in chrome.storage.local
  - Chiama Edge Function save-profile con JWT
         ↓
save-profile Edge Function:
  - Verifica JWT + accesso
  - INSERT in profili_salvati con user_email
```

### Selettori DOM commenti

Il content script gestisce due strutture DOM di LinkedIn:

**Legacy (BEM classes)**:
```
.comments-comment-social-bar--{hash}
  → action group con classe hashed
```

**Nuovo DOM (hashed CSS)**:
```
Reply button → replyWrapper div → action bar (parentElement)
→ aggiungi .ln-save-inline-wrap alla fine dell'action bar
```

---

## Generazione messaggi AI

### Flusso

```
Utente clicca "Generate with AI" nel composer LinkedIn
         ↓
Menu dropdown con 3 scenari:
  - Pain point
  - Founder → Founder
  - Trigger (post/commento)
         ↓
Se scenario "trigger":
  - Apre sidepanel (per context dal CRM)
  - Mostra dialog per incollare manualmente il commento
         ↓
getMessagingContext(scenario):
  - Scraping header chat: nome lead, headline, URL profilo
  - Se trigger: cerca in profili_salvati per linkedin_url
         ↓
Chiamata a generate-message Edge Function:
  body: {
    scenario,
    valueProposition,  // da chrome.storage
    targetLanguage,    // da chrome.storage
    aiInstructions,    // da chrome.storage
    leadName,
    headline,
    profileUrl,
    triggerText,
    triggerUrl
  }
         ↓
generate-message Edge Function:
  - Verifica JWT + accesso + rate limit (20 generazioni/ora/utente)
  - Costruisce system prompt dinamico con lingua + istruzioni utente
  - Chiama Claude claude-sonnet-4-6 (fallback: claude-3-haiku)
  - Ritorna { message: "testo pronto" }
         ↓
insertAiMessageIntoComposerNear(message, anchorBtn):
  - Trova il contenteditable del composer LinkedIn
  - Inserisce il testo con innerHTML + dispatchEvent("input")
```

### System prompt Claude

Il prompt è costruito in `generate-message/index.ts` con:
- `BASE_SYSTEM_PROMPT`: regole fisse di tono, anti-pattern, CTA, 3 scenari
- `languageRule`: forza la lingua scelta dall'utente
- `englishToneRule`: tono Silicon Valley se inglese con VP in italiano
- `userStylePref`: istruzioni custom dell'utente (sanitizzate da injection)

### Scenari

| Scenario | Input | Output |
|---|---|---|
| `pain` | Ruolo/azienda lead | Messaggio su pain point NON ovvio |
| `founder` | Info startup lead | Riconoscimento peer-to-peer + VP |
| `trigger` | Testo commento/post | Rielaborazione + insight + domanda |

---

## Impostazioni utente (chrome.storage.local)

| Chiave | Tipo | Default | Descrizione |
|---|---|---|---|
| `ln_user_value_prop` | string | "" | Chi sei / cosa fai (1-2 righe) |
| `ln_user_target_language` | string | "Italiano" | Lingua messaggi AI |
| `ln_user_ai_instructions` | string | "" | Istruzioni custom AI (max 500 char) |
| `crm_auth` | AuthState | null | Stato autenticazione |

---

## Build e Deploy

### Variabili d'ambiente (.env)

```env
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...
VITE_EDGE_FUNCTIONS_BASE_URL=https://xxx.supabase.co/functions/v1
VITE_REQUEST_OTP_URL=https://xxx.supabase.co/functions/v1/request-otp
VITE_VERIFY_OTP_URL=https://xxx.supabase.co/functions/v1/verify-otp
VITE_PURCHASE_URL=https://linkyassistant.com/acquista
```

### Supabase secrets

```
AUTH_JWT_SECRET
RESEND_API_KEY
EMAIL_FROM
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_URL
CLAUDE_API_KEY
CLAUDE_MODEL  (opzionale, override modello)
```

### Build extension

```bash
npm install
npm run build
# Carica la cartella dist/ in chrome://extensions con Developer Mode
```

### Deploy Edge Functions

```bash
supabase functions deploy request-otp
supabase functions deploy verify-otp
supabase functions deploy list-profiles
supabase functions deploy save-profile
supabase functions deploy update-profile
supabase functions deploy delete-profile
supabase functions deploy search-profile
supabase functions deploy generate-message
```

### Distribuzione beta

I tester vengono aggiunti manualmente tramite SQL Editor di Supabase:
```sql
INSERT INTO utenti_waitlist (email, source)
VALUES ('tester@example.com', 'beta');
```

---

## Note importanti

### Manifest.json — Pre-Web Store

Rimuovere prima della submission al Chrome Web Store:
- `http://localhost:5173/*` da `host_permissions`
- `http://localhost:5173` da `content_security_policy`

Il `vite.config.ts` lo fa automaticamente in modalità `production`.

### Chunking Vite

Il `vite.config.ts` definisce `manualChunks` per evitare che:
- `floatingButton.ts` finisca nel bundle del sidepanel
- `userSettings.ts` venga incluso più volte
- Il content script importi codice del sidepanel

### Iniezione bottone "Save"

Il content script usa tre strategie parallele per garantire l'iniezione:
1. `MutationObserver` su `document.documentElement` — intercetta nuovi commenti
2. `setInterval` ogni 2 secondi — heartbeat fallback per commenti caricati in ritardo
3. Scan iniziale all'avvio

### Rate limiting generate-message

20 chiamate/ora per email. Implementato con la tabella `auth_rate_limits` — stesso sistema di rate limiting usato per gli OTP.

### Sicurezza AI instructions

Le `aiInstructions` dell'utente vengono sanitizzate da `sanitizeAiInstructions()` prima di essere passate a Claude, filtrando pattern di prompt injection (`ignore previous instructions`, `you are now a`, ecc.).
