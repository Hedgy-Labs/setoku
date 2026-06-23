# Setoku sports demo

A self-contained Setoku instance pointed at a **synthetic professional-baseball
dataset** — the fictional **Riverside Stags** (not based on any real team). Use it
to demo Setoku end-to-end to a sports-team prospect: connect Claude, ask business
questions in plain language, watch curated "tribal knowledge" steer the answers.

It models what a real club's data **actually** looks like: several **disconnected
vendor systems** (one Postgres schema each), **no foreign keys between them**, mixed
money units (cents in ticketing, dollars everywhere else), **3 seasons** of history,
and real mess — duplicate CRM contacts, dirty emails, refunds/exchanges,
secondary-market resale, vendor-staffed labor, partial (online-only) merch. ~6M rows.
This is where Setoku's curated knowledge (identity resolution, code maps, exclusions,
coverage caveats) earns its keep. It runs **alongside** production on the same box
without touching it — its own compose project, network, volumes, and Postgres.

## Live instance

Deployed on the hedgy box:

| | URL |
|---|---|
| **Claude connector (MCP)** | `https://stags.setoku.com/mcp/28e53fdf11bd086f665064beea5f7d0f6c59292183af96d8` |
| **Admin / approval surface** | https://stags.setoku.com/admin |
| **Health** | https://stags.setoku.com/health |

(`stags.51-81-222-176.sslip.io` serves the same endpoints — a stable alias.)

That token is a shareable bearer credential for the demo. It only grants read +
propose-only access to **synthetic** data (no real PII), so it's fine to hand out;
rotate it anytime by editing `DEMO_TOKENS` in `/opt/setoku/demo/.env.stags` and
restarting the gateway, or mint per-person tokens (see "Inviting people" below).

### Connect Claude (the prospect experience)

1. In **Claude.ai** (or the desktop app): **Settings → Connectors → Add custom connector**.
2. Paste the full MCP URL above as the *Remote MCP server URL*. There is **no header
   field** — the token rides in the URL, so leave OAuth blank. (Treat the URL like a password.)
3. Ask in plain language. This is the instance to show when a prospect says *"but our
   data is a mess across a dozen systems"* — because it is, and Setoku still answers right:
   - **"How many unique fans do we have?"** — naive `COUNT(*)` overcounts (CRM has duplicates);
     Setoku dedupes by normalized email and excludes test records (~129k rows → ~98k fans).
   - **"What's our season-ticket renewal rate?"** — needs the 3-season ticketing data; ~85%.
   - **"Link our CRM to the ticketing system — how many fans can we match?"** — email-normalization
     identity resolution (no shared key); ~80% match.
   - **"What's our total ticket revenue?"** — handles cents-vs-dollars, excludes refunds /
     exchanges / comps / test accounts.
   - **"F&B per-cap, and how much do we spend on gameday labor?"** — POS is in dollars; labor
     includes vendor staff who aren't in the HR system.
   - **"What's our total merchandise revenue?"** — Setoku flags that `merch` is only the online
     store (most merch is Fanatics, not in the data) instead of giving a wrong total.

`find_context` runs first and feeds Claude the curated definitions + gotchas, so it computes
things the way the business does instead of guessing from column names.

### Admin login

`/admin` is the human approval surface — where pending knowledge (an analyst's
`report_correction`) gets promoted into curated context, outside the agent loop.

- **URL:** https://stags.setoku.com/admin  ·  **Username:** `peter`  ·  **Password:** `stags-demo-2026`
- Demo credentials over synthetic data. Rotate on the box:
  `docker exec -it -e SETOKU_NEW_PASSWORD='…' setoku-stags-demo-server-1 bun gateway/admin-cli.ts set-password peter`.
- Demo flow to show a prospect: ask a question → correct a definition in chat
  (`report_correction`) → it lands **pending** → approve it in `/admin` → the next answer uses it.

### Inviting people (fresh token per person)

```bash
# on the box
docker exec -e SETOKU_TOKENS_FILE=/data/teammates.json \
  setoku-stags-demo-server-1 bun gateway/admin-cli.ts add-teammate alice@example.com
# then restart the gateway so the new token loads:
docker compose -p setoku-stags -f /opt/setoku/demo/docker-compose.demo.yml \
  -f /opt/setoku/demo/docker-compose.edge.yml --env-file /opt/setoku/demo/.env.stags \
  up -d demo-server
```

## The data model — 7 vendor systems (Postgres schemas)

There are **no foreign keys between schemas**; the shared keys are `event_no` (games) and a
**normalized email** for people. Money is **cents in `ticketing`, dollars everywhere else**.

| Schema | Vendor-style system | Holds | Money |
|---|---|---|---|
| `ticketing` | Archtics/Tickets.com-style | events, accounts, the seat manifest & sales ledger | cents |
| `crm` | Salesforce-style | marketing contacts (has duplicates) | — |
| `sponsorship` | KORE-style | partners, contracted deals, deal assets | dollars |
| `pos` | concessions point-of-sale | F&B transactions + line items | dollars |
| `merch` | team online store feed | online merch orders only (**partial** — Fanatics not here) | dollars |
| `hr` | Workday/ADP-style | workers, comp, gameday shifts (mostly vendor-staffed) | dollars |
| `marketing` | ad-platform exports | spend & delivery by platform (no sales attribution) | dollars |

The curated knowledge (`stags/.setoku/context/`) ships entity docs, canonical
metric SQL, an identity-resolution recipe, and the gotchas (mixed units, dedupe, code maps,
coverage caveats) — so `find_context` has something real to return.

## Boot / re-seed on the box

The box already runs production Setoku and has the `setoku-server` image built, so the demo
reuses it. From `/opt/setoku/demo`:

```bash
./boot.sh            # first run generates .env.stags (tokens + PG password), seeds, starts the gateway
```

It starts a demo Postgres, seeds the data (deterministic — same `SEED` ⇒ identical data),
and starts the gateway on `127.0.0.1:8789`, auto-joining the production Caddy network if
present. Re-seed in place anytime by re-running `./boot.sh` (schema drops and recreates).

Public routing (one deliberate step): append `caddy-stags.snippet` to
`/opt/setoku/Caddyfile`, then — because the Caddyfile bind-mount is inode-pinned — recreate
(not reload) Caddy:

```bash
cat caddy-stags.snippet >> /opt/setoku/Caddyfile
docker compose -p setoku up -d --force-recreate --no-deps caddy
```

### Scale

`DEMO_SEATS_PER_GAME` controls volume (default 10000 ≈ 2.4M seat rows across 3 seasons; the
F&B/attendance figures derive from it). Push toward a full MLB house with
`DEMO_SEATS_PER_GAME=38000` (~9M seat rows, ~30-min reseed). The box has the headroom; query
latency stays sub-second-to-~1s.

## Tests (subscription-driven — no API keys)

All three drive the **real Claude via the Max subscription** (the `claude` CLI / its MCP
client), never an Anthropic API key — the runners strip `ANTHROPIC_API_KEY`.

```bash
claude                       # once, to log in to your subscription
bun run test:demo-e2e        # golden questions → asserts answers use the curated knowledge; exits non-zero on fail
bun run test:knowledge-lint  # runs each doc's canonical SQL against live data, flags errors/absurd values
bun run demo/e2e/probe.ts    # adversarial probe — full answers, no pass/fail, for finding gaps
```

`test:demo-e2e` and the probe spend real subscription turns and need a logged-in account, so
they're **not** in the pre-push gate — run them before a demo or after changing the dataset or
its knowledge. Override the target with `DEMO_MCP_URL`.

## Tear down

```bash
docker compose -p setoku-stags -f docker-compose.demo.yml -f docker-compose.edge.yml down -v
# then remove the demo block from /opt/setoku/Caddyfile and recreate caddy
```

This leaves production untouched.
