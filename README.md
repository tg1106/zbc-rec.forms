# ZBC Round 2 — Interview Slot Selection

A full Node.js/Express web app for ZBC Round 2 interview slot registration.  
Google Forms-style UI · Google Sheets backend · Secrets stay on the server.

---

## Architecture

```
Browser  ──►  Express (server.js)  ──►  Google Apps Script  ──►  Google Sheet
              ↑ reads .env                ↑ token auth
              Secrets never reach         (injected server-side)
              the browser
```

| File | Purpose |
|---|---|
| `server.js` | Express app — routes, auth, rate limiting, GAS proxy |
| `views/index.html` | Public form (served at `/`) |
| `views/admin.html` | Admin dashboard (served at `/admin`) |
| `public/xlsx.mini.min.js` | SheetJS — bundled locally, no CDN |
| `google-sheet-sync.gs` | Google Apps Script backend |
| `.env` | **Your secrets** — never committed to git |
| `.env.example` | Template — commit this, not `.env` |

---

## Setup

### 1 — Prerequisites

- Node.js 18 or newer
- A Google account

---

### 2 — Install dependencies

```bash
cd rec-gforms-replica
npm install
```

---

### 3 — Deploy the Google Apps Script

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet.
2. Open **Extensions → Apps Script**.
3. Delete any starter code and paste the contents of `google-sheet-sync.gs`.
4. Edit the two token lines near the top:
   ```javascript
   var SUBMIT_TOKEN = 'your-long-random-submit-token';
   var ADMIN_TOKEN  = 'your-long-random-admin-token';
   ```
   Generate tokens at [randomkeygen.com](https://randomkeygen.com) → "Fort Knox Passwords".
5. Click **Deploy → New deployment**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click **Deploy** → authorize → copy the **Web App URL**.

---

### 4 — Configure .env

```bash
cp .env.example .env
```

Open `.env` and fill in every value:

```env
NODE_ENV=development
PORT=3000

# Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
SESSION_SECRET=<generate a long random string>

# From step 3
GAS_URL=https://script.google.com/macros/s/YOUR_ID/exec
GAS_SUBMIT_TOKEN=<same token as in google-sheet-sync.gs>
GAS_ADMIN_TOKEN=<same token as in google-sheet-sync.gs>

# Admin dashboard password
ADMIN_PASSWORD=Zbcftw
```

---

### 5 — Run locally

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Open:
- **Public form** → http://localhost:3000/
- **Admin dashboard** → http://localhost:3000/admin

---

## Deploying to production

### Option A — Railway (recommended, free tier)

1. Push your repo to GitHub (**make sure `.env` is in `.gitignore`**).
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub.
3. In the Railway dashboard → your service → **Variables**, add every key from `.env.example` with your real values.
4. Railway auto-detects Node.js and runs `npm start`.
5. Your two URLs will be `https://yourapp.railway.app/` and `https://yourapp.railway.app/admin`.

### Option B — Render (free tier)

1. Push repo to GitHub (no `.env`).
2. [render.com](https://render.com) → New Web Service → connect repo.
3. Build command: `npm install`  Start command: `npm start`
4. Add environment variables in the Render dashboard.

### Option C — VPS (DigitalOcean, Hetzner, etc.)

```bash
git clone <your-repo>
cd rec-gforms-replica
cp .env.example .env   # fill in values
npm install
# Use pm2 to keep it running
npm install -g pm2
pm2 start server.js --name zbc-form
pm2 save
```

Put nginx in front for HTTPS (Let's Encrypt / certbot).

---

## Security notes

| What | How |
|---|---|
| GAS tokens | Live in `.env` only, injected server-side. Never sent to browser. |
| Admin password | Hashed with SHA-256 at server startup. Plaintext never leaves `.env`. |
| Session cookie | `httpOnly`, `sameSite: lax`, `secure: true` in production. |
| Rate limiting | 60 req/min general · 3 submissions/10 min · 10 login attempts/15 min |
| Input validation | Every field validated on the server before forwarding to GAS. |
| Helmet | Sets secure HTTP headers (CSP, HSTS, etc.). |

---

## Changing the admin password

1. Open `.env`
2. Change `ADMIN_PASSWORD=NewPassword`
3. Restart the server — the hash is recomputed at startup.

No code changes needed.

---

## Updating the GAS script

After any edit to `google-sheet-sync.gs`:

1. Apps Script editor → **Deploy → Manage deployments**
2. Click the pencil ✏️ on your deployment
3. Version → **New version**
4. Click **Deploy**

The URL stays the same — no changes needed in `.env`.
