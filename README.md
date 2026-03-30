# Expense Logger

Upload a receipt → Claude extracts the details → review → log to Streamtime → save to Drive.

**Hosted on GitHub Pages. All API keys stored in Cloudflare Workers. Zero spend.**

---

## How it works

```
Browser (GitHub Pages)
  │
  ├─ POST /jobs      ─┐
  ├─ POST /expenses   ├─▶  Cloudflare Worker  ──▶  Streamtime API
  ├─ POST /extract   ─┘         (holds all          Gemini API
  │                              API keys)
  └─ Drive OAuth ──────────────────────────────▶  Google Drive (direct)
```

The browser never sees any API key. Every call to Streamtime and Gemini goes through the Worker, which holds the secrets in Cloudflare's encrypted environment.

Google Drive uses standard OAuth — the user grants permission in a popup, and uploads happen directly from their browser using a short-lived access token. The OAuth Client ID is not sensitive.

---

## One-time setup

### Step 1 — Cloudflare (free account)

1. Sign up at [cloudflare.com](https://cloudflare.com) — free plan is sufficient
2. **Get your Account ID**: Dashboard → right sidebar → copy Account ID
3. **Create an API token**: My Profile → API Tokens → Create Token
   - Use the **Edit Cloudflare Workers** template
   - Copy the token — you'll only see it once

### Step 2 — Google (free)

**Gemini API key** (for receipt extraction):
1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Click **Create API key** — no billing required
3. Copy the key

**Google Drive OAuth** (for saving receipts):
1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create or select a project
2. **APIs & Services → Library** → enable **Google Drive API**
3. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web Application**
   - Authorised JavaScript origins: `https://your-org.github.io`
4. Copy the **Client ID** (the secret is not needed)
5. Open your receipts folder in Google Drive → copy the **folder ID** from the URL

### Step 3 — GitHub Secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**

Add each of these:

| Secret name | Value |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token from Step 1 |
| `CF_ACCOUNT_ID` | Cloudflare Account ID from Step 1 |
| `STREAMTIME_KEY` | Streamtime bearer token (Company Settings → Integrations → API) |
| `GEMINI_KEY` | Google AI Studio API key from Step 2 |
| `GOOGLE_CLIENT_ID` | OAuth Client ID from Step 2 |
| `DRIVE_FOLDER_ID` | Google Drive folder ID from Step 2 |
| `ALLOWED_ORIGIN` | Your GitHub Pages URL, e.g. `https://your-org.github.io` |

### Step 4 — Deploy

```
1. Create a GitHub repo (private is fine)
2. Push this folder's contents to main
3. Repo Settings → Pages → Source: GitHub Actions
4. Push triggers the workflow — both the Worker and the Pages site deploy automatically
```

The workflow deploys in two parallel jobs:
- **deploy-worker** — pushes `worker.js` + all secrets to Cloudflare Workers
- **deploy-pages** — publishes the HTML to GitHub Pages

### Step 5 — Configure the app

1. Open your GitHub Pages URL
2. Click ⚙️ → enter your **Worker URL** (shown in Cloudflare dashboard after first deploy)
3. Click **Test connection** to verify
4. Enter your **initials**
5. Save — jobs load automatically

That's it. Each team member opens the same URL, enters their own initials, and is ready to go.

---

## Usage

| Step | Action |
|---|---|
| **1 — Select Job** | Search and pick from your active Streamtime jobs |
| **2 — Upload** | Drag & drop or click — JPG, PNG, WebP or PDF up to 20 MB |
| **3 — Review** | Gemini pre-fills all fields; edit anything before submitting |
| **Submit** | Logs the expense in Streamtime; optionally saves receipt to Drive |

**Drive filename format:**
```
DD.MM.YY_Supplier_Initials_JobCode_$Amount.ext
30.03.26_Officeworks_BE_JOB-001_$54.50.pdf
```

---

## Team rollout

Each person needs only two things:
1. The GitHub Pages URL (share it internally — don't post it publicly)
2. Their own initials (entered once, saved in their browser)

No API keys, no setup, no installs.

---

## Updating secrets

To rotate a key (e.g. a new Streamtime token):
1. Update the secret in **GitHub → Settings → Secrets**
2. Push any change to `main` (or trigger the workflow manually via **Actions → Run workflow**)
3. The Worker redeploys with the new secret automatically

---

## Files in this repo

```
expense-logger.html          ← the app (no API keys)
worker.js                    ← Cloudflare Worker proxy
wrangler.toml                ← Worker configuration
.github/
  workflows/
    deploy.yml               ← deploys Worker + Pages on push to main
```
