# Setoku sports demo

Self-contained Setoku instances pointed at a **synthetic professional-baseball
dataset** — the fictional **Riverside Stags** (not based on any real team). Use them
to demo Setoku end-to-end to a sports-team prospect: connect Claude, ask business
questions in plain language, see curated "tribal knowledge" steer the answers.

There are **two datasets**, each a separate live instance:

- **`sports/` — the clean "happy path."** One tidy Postgres schema, one season. Crisp,
  fast answers; best for the first "wow." (Live at `stags-lite.setoku.com`.)
- **`sports-realistic/` — the real-world shape.** What a real club's data actually looks
  like: several **disconnected vendor systems** (one schema each), no shared keys, mixed
  money units, 3 seasons, and real mess — duplicate CRM contacts, dirty emails, refunds,
  secondary-market resale, vendor-staffed labor, partial merch coverage. This is where
  Setoku's curated knowledge (identity resolution, code maps, exclusions) earns its keep.
  (Live at `stags.setoku.com` — this is the primary demo to lead with.)

Each runs **alongside** production on the same box without touching it — its own compose
project, network, volumes, and Postgres.

## Live instance — clean demo (`sports/`)

A running copy is deployed on the hedgy box, reachable at:

| | URL |
|---|---|
| **Claude connector (MCP)** | `https://stags-lite.setoku.com/mcp/c1ca64c9825bb0da86e08da8225c1498620c245575e48298` |
| **Admin / approval surface** | https://stags-lite.setoku.com/admin |
| **Health** | https://stags-lite.setoku.com/health |

That token is a shareable bearer credential for the demo. It only grants read +
propose-only access to **synthetic** data (no real PII), so it's fine to hand out;
rotate it anytime by editing `DEMO_TOKENS` in `/opt/setoku/demo/.env.demo` and
restarting the gateway, or mint per-person tokens (see "Inviting people" below).

> `stags-lite.setoku.com` needs a DNS A record (`stags-lite` → the box IP) before
> its cert issues. Until then, the stable alias `https://demo.51-81-222-176.sslip.io`
> serves the exact same endpoints with the same token.

### Connect Claude (the cofounder / prospect experience)

1. In **Claude.ai** (or the desktop app): **Settings → Connectors → Add custom connector**.
2. Paste the full MCP URL (`https://stags-lite.setoku.com/mcp/c1ca64c9825bb0da86e08da8225c1498620c245575e48298`) as the *Remote MCP
   server URL*. There is **no header field** — the token rides in the URL, so leave
   OAuth blank. (Treat the URL like a password.)
3. Ask in plain language. Good openers:
   - "What was our ticket revenue this season, and which games sold best?"
   - "What's our sell-through by game — do promo nights actually fill seats?"
   - "Per-cap food & beverage spend, and which stands drive the most margin?"
   - "Break down sponsorship sold value vs rate card."
   - "Marketing spend by channel and blended CPM."

`find_context` runs first and feeds Claude the curated definitions + gotchas (comps
are free, `scanned` = attended vs `sold` = no-show, money is in cents…), so it
computes things the way the "business" does instead of guessing from column names.

### Admin login

`/admin` is the human approval surface — where pending knowledge (an analyst's
`report_correction`) gets promoted into curated context, outside the agent loop.

- **URL:** https://stags-lite.setoku.com/admin  ·  **Username:** `peter`  ·  **Password:** `stags-demo-2026`
- These are demo credentials over synthetic data. Rotate anytime on the box:
  `docker exec -it -e SETOKU_NEW_PASSWORD='…' setoku-demo-demo-server-1 bun gateway/admin-cli.ts set-password peter`.
- Demo flow to show a prospect: ask a question → correct a definition in chat
  (`report_correction`) → it lands **pending** → approve it in `/admin` → the next
  answer uses it.

### Inviting people (fresh token per person)

```bash
# on the box
docker exec -e SETOKU_TOKENS_FILE=/data/teammates.json \
  setoku-demo-demo-server-1 bun gateway/admin-cli.ts add-teammate alice@example.com
# then restart the demo gateway so the new token loads:
docker compose -p setoku-demo -f /opt/setoku/demo/docker-compose.demo.yml \
  -f /opt/setoku/demo/docker-compose.edge.yml --env-file /opt/setoku/demo/.env.demo \
  up -d demo-server
```

## Live instance — realistic demo (`sports-realistic/`)

The realistic instance models a real club's data: **7 vendor systems** as separate Postgres
schemas (`ticketing`, `crm`, `sponsorship`, `pos`, `merch`, `hr`, `marketing`), **no
foreign keys between them**, money in **cents in ticketing but dollars everywhere else**,
**3 seasons** of history, and deliberate mess. ~6M rows.

| | URL |
|---|---|
| **Claude connector (MCP)** | `https://stags.setoku.com/mcp/28e53fdf11bd086f665064beea5f7d0f6c59292183af96d8` |
| **Admin** | https://stags.setoku.com/admin |
| **Health** | https://stags.setoku.com/health |

(`realistic.51-81-222-176.sslip.io` serves the same endpoints — a stable alias.)

Connect it the same way (Claude.ai → Connectors → Add custom connector; token in the URL).
This is the instance to show when a prospect asks *"but our data is a mess across a dozen
systems"* — because it is, and Setoku still answers correctly. Good questions:

- **"How many unique fans do we have?"** — naive `COUNT(*)` overcounts (CRM has duplicates);
  Setoku dedupes by normalized email and excludes test records (~129k rows → ~98k fans).
- **"What's our season-ticket renewal rate?"** — needs the 3-season ticketing data; ~85%.
- **"Link our CRM to the ticketing system — how many fans can we match?"** — shows the
  email-normalization identity resolution (no shared key); ~80% match.
- **"What's our total ticket revenue?"** — handles cents-vs-dollars, excludes refunds /
  exchanges / comps / test accounts.
- **"What's our F&B per-cap, and how much do we spend on gameday labor?"** — POS is in
  dollars; labor includes vendor staff who aren't in the HR system.
- **"What's our total merchandise revenue?"** — Setoku flags that `merch` is only the
  online store (most merch is Fanatics, not in the data) instead of giving a wrong total.

The contrast between the two instances *is* the pitch: the clean one shows the magic; the
realistic one shows it survives contact with real data. Admin login is the same
(`peter` / `stags-demo-2026`) but scoped to this instance's own store.

## What's in the data (clean `sports/` dataset)

Eight subject areas the demo brief asked for, one season (81 home games), all tied
together by a shared `games` table. Money is integer **cents** everywhere.

| Table | Grain | Notes |
|---|---|---|
| `games` | 1 per home game (81) | opponent, attendance, promo nights — the join hub |
| `tickets` | 1 per seat per game | type (season/single/group/premium/corporate/comp), status (hold→listed→sold→scanned), buyer, dynamic price |
| `fans` | 1 per fan (CRM) | email key, demographics, payment brand+last4, favorite player |
| `sponsorships` | 1 per inventory unit per game | LED/static signage, digital, activation; rate card vs sold |
| `merchandise` | 1 per SKU | team-store catalog, list vs cost, channel, vendor, stock |
| `concessions` | 1 per F&B sale | stand, item, margin, payment, optional fan tie (completed games only) |
| `staffing` | 1 per gameday shift | scheduled vs actual clock in/out, wage, role |
| `hr_employees` | 1 per employee | W2/1099, salary/hourly, manager chain, department |
| `marketing_spend` | 1 per campaign line | channel, spend, reach/impressions/CPM/CPC |

The curated knowledge (`sports/.setoku/context/`) ships entity docs, canonical
metric SQL, and gotchas — so `find_context` has something real to return and the
demo shows off definition management, not just raw SQL.

### Good demo questions

- "What was our ticket revenue this season, and which games sold best?"
- "What's our sell-through rate by game? Do promo nights actually fill more seats?"
- "Break down sponsorship sold value vs rate card — how deep are our discounts?"
- "What's per-cap food & beverage spend, and which stands drive the most margin?"
- "How much are we spending on gameday labor per game?"
- "Show marketing spend by channel and blended CPM."
- "Which fans have the highest concession spend?" (ties F&B → CRM)

## Scale

Defaults are tuned to load in well under a minute and stay snappy:
`SEATS_PER_GAME=6000` → ~486k tickets, ~60k fans, ~100k concessions. Crank ticket
volume to a full MLB house with `DEMO_SEATS_PER_GAME=38000` (~3M ticket rows).
Generation is deterministic (seeded PRNG) — same `SEED` ⇒ identical data.

## Boot it on the box (recommended)

The box already runs production Setoku and has the `setoku-server` image built, so
the demo reuses it. From this directory on the box (e.g. `/opt/setoku/demo`):

```bash
./boot.sh
```

First run generates `.env.demo` (tokens + Postgres password), starts a demo
Postgres, seeds the data, and starts the demo gateway on `127.0.0.1:8788`. It
auto-joins the production Caddy network if present.

Then expose it publicly (one deliberate step — appends a site block to the prod
Caddyfile and graceful-reloads, which is validated and zero-downtime):

```bash
cat caddy-demo.snippet >> /opt/setoku/Caddyfile
docker compose -p setoku exec caddy caddy reload --config /etc/caddy/Caddyfile
```

The demo hostname uses **sslip.io** (`demo.<dash-ip>.sslip.io`) so it needs no DNS
change — Caddy issues a real cert automatically. Share the link `boot.sh` prints:

```
https://demo.51-81-222-176.sslip.io/mcp/<token>
```

Your cofounder pastes that URL into Claude.ai → Settings → Connectors → Add custom
connector (no header field; the token rides in the URL), then asks questions in
plain language.

## Tear down

```bash
docker compose -p setoku-demo -f docker-compose.demo.yml -f docker-compose.edge.yml down -v
# then remove the demo block from /opt/setoku/Caddyfile and reload caddy
```

This leaves production untouched.

## Run it standalone (local / another box)

If there's no production stack, `boot.sh` drops to standalone mode (gateway on
`127.0.0.1:8788`, no Caddy). To build the image yourself instead of reusing
`setoku-server`, set `DEMO_IMAGE` or build from the repo's `deploy/Dockerfile`.
Re-seed in place anytime with `./boot.sh` (the schema drops and recreates).

## End-to-end tests (subscription-driven, no API keys)

`demo/e2e/run.ts` drives the **real Claude** — via the Claude **Max subscription**
(the `claude` CLI in print mode) — against the **live box** connectors, exactly how
a prospect uses it. No Anthropic API keys: the runner strips `ANTHROPIC_API_KEY` so
the CLI must use the logged-in subscription. Each golden question asserts the answer
reflects the curated knowledge (dedupe, cents-vs-dollars, comps excluded, multi-season
renewal, the merch coverage caveat) rather than a naive guess.

```bash
claude            # once, to log in to your subscription (if you haven't)
bun run test:demo-e2e            # both instances (realistic + lite)
bun run demo/e2e/run.ts realistic   # just one
```

It prints a scorecard and exits non-zero on failure. Targets default to the live
sslip aliases; override with `DEMO_MCP_REALISTIC` / `DEMO_MCP_LITE`. Because it spends
real subscription turns and depends on a logged-in account, it is **not** in the
pre-push gate — run it before a demo or after changing a dataset or its knowledge.
