# Community Bingo — Worker Setup
**MD Works · mdworks.dev**

## Prerequisites

```bash
npm install -g wrangler
wrangler login
```

---

## 1. Create D1 database

```bash
wrangler d1 create community-bingo-db
```

Copy the `database_id` from the output and paste it into `wrangler.toml`.

---

## 2. Create KV namespace

```bash
# Production
wrangler kv:namespace create BINGO_KV

# Preview (for local dev)
wrangler kv:namespace create BINGO_KV --preview
```

Copy both IDs into `wrangler.toml` (`id` and `preview_id`).

---

## 3. Run the D1 migration

```bash
# Local (for dev/testing)
wrangler d1 execute community-bingo-db --file=schema.sql

# Remote (production)
wrangler d1 execute community-bingo-db --file=schema.sql --remote
```

---

## 4. Install deps and deploy

```bash
npm install
wrangler deploy
```

Your worker will be live at:
`https://community-bingo.<your-subdomain>.workers.dev`

---

## 5. Local development

```bash
wrangler dev
```

Worker runs at `http://localhost:8787`.

---

## Quick smoke test (once deployed)

```bash
# Create a session
curl -X POST https://community-bingo.<subdomain>.workers.dev/bingo/session \
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

# Returns: { "id": "...", "status": "pending" }

# Create a ticket (use the session id from above)
curl -X POST .../bingo/ticket \
  -H "Content-Type: application/json" \
  -d '{ "session_id": "<id>", "player_name": "Test Player" }'
```

---

## Wrangler.toml placeholders to fill in

| Placeholder | Where to get it |
|-------------|-----------------|
| `REPLACE_WITH_YOUR_D1_DATABASE_ID` | Output of `wrangler d1 create` |
| `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` | Output of `wrangler kv:namespace create BINGO_KV` |
| `REPLACE_WITH_YOUR_KV_PREVIEW_ID` | Output of `wrangler kv:namespace create BINGO_KV --preview` |
