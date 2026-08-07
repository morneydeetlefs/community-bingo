# Community Bingo — Project Handoff v3
**MD Works · Morney Deetlefs · mdworks.dev**
**Status:** Full build complete — ready for deployment
**Last updated:** 2026-08-06

---

## What Was Built This Session

All application code is complete. 4 723 lines across 11 files.

### File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | 983 | Cloudflare Worker — all 11 REST endpoints, card generation, win validation, KV management |
| `play.html` | 1 516 | Player card — PWA, full-screen scaled, 3 colour modes, KV polling, BINGO claim, carousel |
| `caller.html` | 1 278 | Caller screen — live draw, Web Speech API, winner confirmation overlay |
| `index.html` | 946 | Organiser dashboard — session create, ticket management, WhatsApp share, winners log |
| `schema.sql` | 42 | D1 database schema — 4 tables, indexes |
| `manifest.json` | 15 | PWA manifest — fullscreen portrait, both icon sizes |
| `sw.js` | 62 | Service worker — Cache First shell, Network Only for API |
| `wrangler.toml` | 18 | Worker config — D1 + KV bindings (3 placeholders to fill) |
| `package.json` | 16 | npm scripts for dev/deploy/migrate |
| `tsconfig.json` | 12 | TypeScript config |
| `SETUP.md` | 55 | Quick-start CLI reference |

---

## Architecture Recap

```
Player phone          Organiser laptop       Organiser laptop
play.html  ──────────► caller.html           index.html
   │                       │                     │
   │  poll KV (2.5s)       │  POST /draw          │  POST /session
   │                       │  POST /confirm        │  POST /ticket
   └───────────────────────┴──────────────────────┘
                           │
              Cloudflare Worker (src/index.ts)
                           │
                  ┌────────┴────────┐
                  D1 (persistent)   KV (real-time)
                  sessions          status
                  tickets           latest ball
                  called_numbers    pot
                  winners           pending winner
```

### Key decisions locked in
- **Card generation** — tested algorithm, zero failures / 10 000 cards, ~1 retry average
- **Win validation** — mathematical server-side check before any winner is written; caller confirmation is a deliberate trust layer on top
- **Pot** — grows live until first ball is drawn; locks at `pot_locked_at`; prize amounts calculated from locked pot at claim time
- **Winner flow** — claim → Worker validates → writes `validated=0` → caller sees overlay → Confirm/Reject → `validated=1/-1` → KV pushed to all `play.html` instances
- **PWA** — `play.html` is installable on Android; Cache First for shell, Network Only for API; three colour modes (Night / Day / High Contrast) persisted to localStorage
- **Scaling** — `play.html` uses a fixed 390×820 reference frame scaled via `transform:scale()` — no scrolling, all elements visible on any phone

---

## Three Placeholders — Fill Before Any Deploy

Search all files for these strings and replace:

| Placeholder | File(s) | What to put there |
|-------------|---------|-------------------|
| `YOUR_SUBDOMAIN` in `API_BASE` | `play.html`, `caller.html`, `index.html` | Your Worker URL after deploy, e.g. `community-bingo.morney.workers.dev` |
| `REPLACE_WITH_YOUR_D1_DATABASE_ID` | `wrangler.toml` | Output of `wrangler d1 create community-bingo-db` |
| `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` / `PREVIEW_ID` | `wrangler.toml` | Output of `wrangler kv:namespace create BINGO_KV` |

Also update `PLAY_BASE` in `index.html` once you have the Cloudflare Pages URL (used to build WhatsApp share links).

---

## Two Icon Files Needed

The PWA requires two PNG icons. Create them however you like — a gold ✦ on `#110e09` background works well.

| File | Size |
|------|------|
| `icon-192.png` | 192 × 192 px |
| `icon-512.png` | 512 × 512 px |

Place both in the same folder as `play.html` (the `bingo/` directory on Pages).

---

## Full Deployment — Step by Step

The project splits into two parts:
- **Worker** — deployed via Wrangler CLI (handles the API)
- **Frontend pages** — deployed via GitHub → Cloudflare Pages (serves the HTML files)

---

### Part A — Deploy the Worker (CLI)

You need Node.js installed. Do this once on your machine.

#### A1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login
# Opens a browser — log in with your Cloudflare account
```

#### A2 — Create the D1 database

```bash
wrangler d1 create community-bingo-db
```

Output will contain something like:
```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Open `wrangler.toml` and paste that value in place of `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

#### A3 — Create the KV namespace

```bash
# Production namespace
wrangler kv:namespace create BINGO_KV

# Preview namespace (for local dev)
wrangler kv:namespace create BINGO_KV --preview
```

Each command outputs an `id`. Paste them into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding    = "KV"
id         = "paste-production-id-here"
preview_id = "paste-preview-id-here"
```

#### A4 — Run the D1 migration

```bash
# Local (test before going live)
npm run migrate:local

# Production
npm run migrate:remote
```

#### A5 — Install dependencies and deploy

```bash
npm install
npm run deploy
```

Wrangler will print the Worker URL:
```
https://community-bingo.YOUR_SUBDOMAIN.workers.dev
```

Copy this URL. Open `play.html`, `caller.html`, and `index.html` — find `API_BASE` near the top of each `<script>` block and replace `YOUR_SUBDOMAIN` with your actual subdomain.

#### A6 — Smoke test (optional but recommended)

```bash
# Create a test session
curl -X POST https://community-bingo.YOUR_SUBDOMAIN.workers.dev/bingo/session \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Night",
    "date": "2026-08-10",
    "mode": "90",
    "ticket_price": 5000,
    "pct_one_line": 20,
    "pct_two_lines": 30,
    "pct_full_house": 40,
    "pct_organiser": 10
  }'
# Should return: { "id": "...", "status": "pending" }
```

---

### Part B — Push to GitHub (web browser, no Git CLI needed)

#### B1 — Create the repository

1. Go to [github.com](https://github.com) and sign in (or create a free account)
2. Click the **+** button → **New repository**
3. Name it `community-bingo`
4. Set to **Public** (required for free Cloudflare Pages)
5. Leave all other options at their defaults
6. Click **Create repository**

#### B2 — Upload your files

After creating the repo, GitHub shows an empty repository page.

1. Click **uploading an existing file** (the link in the middle of the page)
2. Drag and drop **all your project files** into the upload area. You need to upload:
   - `index.html`
   - `caller.html`
   - `play.html`
   - `manifest.json`
   - `sw.js`
   - `icon-192.png` ← create this first
   - `icon-512.png` ← create this first
   - `schema.sql`
   - `wrangler.toml`
   - `package.json`
   - `tsconfig.json`
   - `SETUP.md`

   > **Note:** GitHub's web uploader can't create folders directly. For `src/index.ts`, you'll need to either use the GitHub web editor to create the file, or use the CLI. See the note at the end of this section.

3. Scroll down, write a commit message like `Initial build`, click **Commit changes**

#### B3 — Upload `src/index.ts` via the web editor

The Worker source lives in a subfolder. Do this after the main upload:

1. In your repo, click **Add file → Create new file**
2. In the filename box, type `src/index.ts` — GitHub will create the `src/` folder automatically when you include the `/`
3. Paste the entire contents of `src/index.ts`
4. Click **Commit changes**

---

### Part C — Deploy Frontend to Cloudflare Pages

#### C1 — Connect your GitHub repo

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. In the left sidebar, click **Workers & Pages**
3. Click **Create** → **Pages**
4. Click **Connect to Git**
5. Authorise Cloudflare to access your GitHub account
6. Select the `community-bingo` repository
7. Click **Begin setup**

#### C2 — Configure the build

On the build settings screen:

| Setting | Value |
|---------|-------|
| Project name | `community-bingo` (or any name you like) |
| Production branch | `main` |
| Framework preset | **None** |
| Build command | *(leave blank)* |
| Build output directory | *(leave blank — Cloudflare serves files from the root)* |

Click **Save and Deploy**.

Cloudflare will deploy in about 30 seconds. You'll get a URL like:
```
https://community-bingo.pages.dev
```

#### C3 — Update PLAY_BASE in index.html

Open `index.html`, find `PLAY_BASE` near the top of the `<script>` block, and update it:

```javascript
const PLAY_BASE = 'https://community-bingo.pages.dev/play.html';
```

Commit the change on GitHub (edit the file in the browser → Commit changes). Cloudflare re-deploys automatically within 30 seconds.

#### C4 — (Optional) Custom subdomain

In Cloudflare Pages → your project → **Custom domains**, you can add a subdomain like `bingo.mdworks.dev` if you have your domain on Cloudflare. Takes about 2 minutes to activate.

---

### Part D — CORS (if needed)

Once your Pages URL is known, update `ALLOWED_ORIGIN` in `wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGIN = "https://community-bingo.pages.dev"
```

Then redeploy the Worker:

```bash
npm run deploy
```

If you add a custom domain later, update this again and redeploy.

---

## How to Use on the Night

### Before the event

1. Open `index.html` → **Sessions tab** → create a session (name, date, mode, price, percentages)
2. Copy the session ID shown after creation
3. Open `caller.html` in a separate browser tab — paste the session ID to connect
4. Back in `index.html` → **Tickets tab** — select the session, add each player (name + phone)
5. WhatsApp links send automatically if a phone number is entered
6. Mark tickets as **Paid** as cash is collected
7. Watch the pot grow in real time on the Tickets tab

### On the night

1. On `caller.html` — click **Start Session** when ready to begin (pot locks)
2. Click **Draw Ball** for each ball — the call is read aloud automatically
3. When a player claims BINGO, a full-screen overlay appears on `caller.html` — review the card preview, then **Confirm** or **Reject**
4. On confirm: the player's phone shows a winner certificate; the prize tier is marked won on all screens
5. Continue drawing for remaining tiers
6. Click **End Round** when the session is finished

### Players

Players tap the WhatsApp link → opens `play.html` in their browser → tap **Add to Home Screen** when prompted → it installs as a full-screen app, no browser chrome.

---

## Local Development (optional)

To run the Worker locally while building:

```bash
wrangler dev
# Worker runs at http://localhost:8787
```

Temporarily change `API_BASE` in the HTML files to `http://localhost:8787` for local testing. Revert before deploying.

---

## Open Items / Future Scope

These are explicitly not built yet but are architecturally ready:

- [ ] **Pattern picker for 75-ball** — pattern map stubbed in `bingo.html` comments, ready to wire into the Worker's `validateClaim()` function. Caller selects pattern before each round.
- [ ] **GET /bingo/session/:id/tickets endpoint** — `index.html` currently uses localStorage as the ticket list cache. A proper server-side list endpoint would allow multi-device organiser access (e.g. one person on the door selling tickets, one at the caller screen).
- [ ] **Google Sheets sync** — winners log exportable to a Sheet via Apps Script. Pattern established in the MD Works brand skill.
- [ ] **Print strip** — PDF of 6 cards per A4 page for players without smartphones.
- [ ] **Icons** — `icon-192.png` and `icon-512.png` still need to be created.

---

## Rebuild Notes for Next Session

- All code is in the GitHub repo after deployment
- `API_BASE` is the only string linking the frontend to the Worker — one search-and-replace if the Worker URL ever changes
- Bump `CACHE_VERSION` in `sw.js` after any deploy to force players to get the new shell (e.g. `bingo-v2`)
- The 90-ball card algorithm is in `generate90Card()` / `generate90CardSafe()` in `src/index.ts` — validated, do not modify unless you understand the distribution constraints
- KV keys follow the pattern `bingo:session:<id>:<key>` — defined in `kvKeys()` helper

---

*MD Works · mdworks.dev · Morney Deetlefs · Durban, KZN, South Africa*
