# Linky Assistant

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5.x-646CFF?logo=vite&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-Edge%20Functions%20%2B%20Postgres-3ECF8E?logo=supabase&logoColor=white)
![Chrome Extension](https://img.shields.io/badge/Chrome%20Extension-MV3-4285F4?logo=googlechrome&logoColor=white)

AI-powered Chrome extension for LinkedIn that saves lead profiles and generates personalized outreach messages from live conversation context.

---

## 🚀 Overview

Linky Assistant is a Chrome Extension (MV3) designed for founder-led LinkedIn outreach.

It helps you:

- Save LinkedIn profiles into your personal lead library
- Attach trigger context (post/comment text + URL)
- Generate personalized AI messages directly in LinkedIn messaging
- Authenticate users with email OTP and a custom JWT flow

### Tech Stack

- **Extension runtime:** Chrome Extension MV3
- **Frontend:** TypeScript + Vite + CRXJS
- **Backend:** Supabase Edge Functions + Postgres (REST via service role on server side)
- **Email delivery:** Resend
- **AI generation:** Anthropic Claude (via `generate-message` edge function)

---

## 🧱 Architecture

### Auth Flow (Text Diagram)

```text
[User enters email in sidepanel]
        |
        v
[request-otp Edge Function]
 - validates email
 - checks access (premium/waitlist)
 - applies anti-enumeration + rate limit
 - stores hashed OTP in otp_codes
 - sends OTP via Resend
        |
        v
[User submits OTP]
        |
        v
[verify-otp Edge Function]
 - validates OTP + rate limits attempts
 - checks access again
 - signs custom JWT (HS256, exp=30d) with AUTH_JWT_SECRET
        |
        v
[Extension stores auth state in chrome.storage.local]
 key: "crm_auth" (jwt, email, access, expiresAt, checkedAt)
        |
        v
[Authenticated calls to Edge Functions]
 Authorization: Bearer <custom_jwt>
```

### Project Structure (Commented)

```text
.
├─ src/
│  ├─ background/
│  │  └─ index.ts                # MV3 service worker (sidepanel orchestration, SPA nav events)
│  ├─ content/
│  │  └─ index.ts                # Injects UI into LinkedIn pages and messaging surfaces
│  ├─ moduli/
│  │  ├─ authService.ts          # OTP requests/verification + local auth persistence
│  │  ├─ apiClient.ts            # Authenticated calls for lead CRUD/search
│  │  ├─ messageGenerator.ts     # AI generate button + invoke generate-message function
│  │  ├─ messagingContext.ts     # Extracts lead context for AI prompt
│  │  ├─ profileSaver.ts         # Save/search profile flow from LinkedIn UI
│  │  ├─ crm.ts                  # Sidepanel lead library UI logic
│  │  ├─ userSettings.ts         # Value proposition, language, custom AI instructions
│  │  └─ supabase.ts             # Supabase client bootstrap (anon key)
│  ├─ sidepanel.css              # Sidepanel styles
│  ├─ content-floating-crm.css   # Floating CRM UI styles
│  └─ style.css                  # Shared styles
├─ supabase/
│  ├─ functions/
│  │  ├─ _shared/                # JWT verify/sign, CORS, access resolver, rate limit helpers
│  │  ├─ request-otp/            # OTP request endpoint
│  │  ├─ verify-otp/             # OTP verification + JWT mint
│  │  ├─ list-profiles/          # List lead profiles for authenticated user
│  │  ├─ save-profile/           # Save lead profile
│  │  ├─ update-profile/         # Update lead profile fields
│  │  ├─ delete-profile/         # Delete lead profile
│  │  ├─ search-profile/         # Exact/fuzzy search by LinkedIn URL/slug
│  │  └─ generate-message/       # AI message generation endpoint
│  ├─ migrations/
│  │  └─ 20260416120000_auth_setup.sql  # OTP/rate-limit tables + RLS policies
│  └─ config.toml
├─ manifest.json                 # Extension manifest (MV3)
├─ vite.config.ts                # Vite + CRXJS build config
└─ sidepanel.html                # Sidepanel entry page
```

### Edge Functions

- `request-otp` — receives email, enforces anti-enumeration and rate limits, stores hashed OTP, sends email via Resend.
- `verify-otp` — validates OTP (expiry/attempts), checks access tier, returns signed custom JWT (30 days).
- `list-profiles` — returns user-owned saved profiles ordered by creation time.
- `save-profile` — inserts/merges profile data for authenticated user.
- `update-profile` — updates mutable profile fields by `id` + `user_email`.
- `delete-profile` — deletes profile by `id` + `user_email`.
- `search-profile` — finds profile by normalized LinkedIn URL and `/in/<slug>` fallback.
- `generate-message` — validates JWT/access, applies per-user rate limit, generates outreach text using Claude.

---

## ⚙️ Local Setup

### Prerequisites

- Node.js **18+** (recommended 20+)
- npm
- Supabase CLI
- Supabase project (with Edge Functions enabled)
- Resend account + API key
- Anthropic API key (for AI generation)

### Clone & Install

```bash
git clone <your-repo-url>
cd estensioneLinkedInTs
npm install
```

### Environment Configuration

Create a local `.env` file (you can base it on `.env.example` if you add one to the repo).

Suggested client variables:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_EDGE_FUNCTIONS_BASE_URL=
VITE_REQUEST_OTP_URL=
VITE_VERIFY_OTP_URL=
VITE_PURCHASE_URL=
```

> Note: if `.env.example` is not yet present, create it with the same keys and placeholder values.

### Load Extension in Chrome (Developer Mode)

1. Build once:
   ```bash
   npm run build
   ```
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the generated `dist/` folder
6. Open LinkedIn and pin/open the extension sidepanel

---

## ☁️ Deploy

### 1) Configure Supabase Secrets

Set required secrets in your Supabase project:

- `AUTH_JWT_SECRET`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_URL`
- `CLAUDE_API_KEY`

Example:

```bash
supabase secrets set AUTH_JWT_SECRET=...
supabase secrets set RESEND_API_KEY=...
supabase secrets set EMAIL_FROM="Linky Assistant <noreply@yourdomain.com>"
```

### 2) Push Database Migrations

```bash
supabase db push
```

### 3) Deploy Edge Functions

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

### 4) Build Extension

```bash
npm run build
```

---

## 🔐 Authentication Flow

### OTP Login (Step-by-step)

1. User enters email in sidepanel.
2. `request-otp` receives email.
3. Backend checks:
   - email format
   - access eligibility (`utenti` / `utenti_waitlist`)
   - per-IP and per-email rate limits
4. Backend generates 6-digit OTP, stores hash in `otp_codes`, sends email.
5. User submits OTP.
6. `verify-otp` validates code, expiry, attempts, and access status.
7. If valid, backend signs custom JWT and returns auth payload.
8. Extension stores auth state in `chrome.storage.local` (`crm_auth` key).

### Custom JWT Details

- **Algorithm:** HS256 (HMAC SHA-256)
- **Claims:** `email`, `access`, `exp`
- **Default lifetime:** 30 days
- **Signing secret:** `AUTH_JWT_SECRET`

### Auth State Persistence

Stored in `chrome.storage.local` under:

- `jwt`
- `email`
- `access`
- `expiresAt`
- `daysLeft`
- `checkedAt`

### What Happens on Expiration

- Expired/invalid JWT returns `401` from protected functions.
- Client clears local auth (`crm_auth` removed).
- User is prompted to login again via OTP.
- Access is re-evaluated server-side during each auth flow.

---

## 🛡️ Security

- **RLS enabled** on sensitive tables (`profili_salvati`, `otp_codes`, `auth_rate_limits`) with deny-by-default policies for `anon` / `authenticated`.
- **Service role key never exposed** to extension client; it is used only inside Edge Functions.
- **Anti-enumeration** in `request-otp`: unauthorized or throttled states can return generic success responses.
- **Rate limiting** implemented with dedicated table + shared helper:
  - OTP request (per IP + per email window)
  - OTP verify attempts
  - Message generation calls per user

---

## Environment Variables

| Variable | Description | Location |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL used by extension client | `.env` (client) |
| `VITE_SUPABASE_ANON_KEY` | Public anon key for client-side Supabase SDK | `.env` (client) |
| `VITE_EDGE_FUNCTIONS_BASE_URL` | Base URL for function calls from client API module | `.env` (client) |
| `VITE_REQUEST_OTP_URL` | Direct endpoint URL for OTP request | `.env` (client) |
| `VITE_VERIFY_OTP_URL` | Direct endpoint URL for OTP verification | `.env` (client) |
| `VITE_PURCHASE_URL` | Upgrade/purchase URL shown in extension UX | `.env` (client) |
| `AUTH_JWT_SECRET` | Secret used to sign and verify custom JWT | Supabase Edge Function secrets |
| `RESEND_API_KEY` | API key used to send OTP emails | Supabase Edge Function secrets |
| `EMAIL_FROM` | Sender identity for OTP emails | Supabase Edge Function secrets |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key for privileged DB access | Supabase Edge Function secrets |
| `SUPABASE_URL` | Supabase URL used server-side in functions | Supabase Edge Function secrets |
| `CLAUDE_API_KEY` | Anthropic API key for AI message generation | Supabase Edge Function secrets |
| `CLAUDE_MODEL` *(optional)* | Override/fallback model selection for generate-message | Supabase Edge Function secrets |

---

## ✅ Open TODOs

- Remove localhost entries from `manifest.json` before Chrome Web Store submission.
- Add pagination to `list-profiles` endpoint.
- Add rate limiting on profiles CRUD endpoints.
- Replace `alert()` with toast notifications in content script UX.
- Increase automated test coverage (unit + integration + e2e).