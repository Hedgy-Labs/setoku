# Setoku sports demo

A self-contained Setoku instance pointed at a **synthetic professional-baseball
dataset** — the fictional **Bonita Bulldogs** (not based on any real team). Use it
to demo Setoku end-to-end to a sports-team prospect: connect Claude, ask business
questions in plain language, watch curated "tribal knowledge" steer the answers.

It models what a real club's data **actually** looks like: several **disconnected
vendor systems** (one Postgres schema each), **no foreign keys between them**, mixed
money units (cents in ticketing, dollars everywhere else), **3 seasons** of history,
and real mess — duplicate CRM contacts, dirty emails, refunds/exchanges,
secondary-market resale, vendor-staffed labor, partial (online-only) merch, a gameday incident
log, and broadcast media-rights contracts. ~13M rows.
This is where Setoku's curated knowledge (identity resolution, code maps, exclusions,
coverage caveats) earns its keep. It runs **alongside** production on the same box
without touching it — its own compose project, network, volumes, and Postgres.

## Live instance

Deployed on the hedgy box:

| | URL |
|---|---|
| **Claude connector (MCP)** | `https://demo.setoku.com/mcp/fdb6bb54d746ba8e00d698ff2183228b682b8272bfef78e0` |
| **Admin / approval surface** | https://demo.setoku.com/admin |
| **Health** | https://demo.setoku.com/health |

(`demo.51-81-222-176.sslip.io` serves the same endpoints — a stable alias.)

That token is a shareable bearer credential for the demo. It only grants read +
propose-only access to **synthetic** data (no real PII), so it's fine to hand out;
rotate it anytime by editing `DEMO_TOKENS` in `/opt/setoku/demo/.env.bulldogs` and
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
     exchanges / comps / test accounts (~$67M/completed season).
   - **"What's our total annual revenue, and how much is media rights?"** — combines five
     systems with reconciled units (~$180–200M total; media rights ~$90M, the biggest line).
   - **"F&B per-cap, and how much do we spend on gameday labor?"** — POS is in dollars; labor
     includes vendor staff who aren't in the HR system.
   - **"What's our total merchandise revenue?"** — Setoku flags that `merch` is only the online
     store (most merch is Fanatics, not in the data) instead of giving a wrong total.
   - **"How many gameday incidents did we log last season, by type?"** — the `ops` system; cleanups
     and lost-and-found dominate, ejections/medical mid-pack, security breaches rare.

`find_context` runs first and feeds Claude the curated definitions + gotchas, so it computes
things the way the business does instead of guessing from column names.

### Admin login

`/admin` is the human approval surface — where pending knowledge (an analyst's
`report_correction`) gets promoted into curated context, outside the agent loop.

- **URL:** https://demo.setoku.com/admin  ·  **Username:** `peter`  ·  **Password:** `bulldogs-demo-2026`
- Demo credentials over synthetic data. Rotate on the box:
  `docker exec -it -e SETOKU_NEW_PASSWORD='…' setoku-bulldogs-demo-server-1 bun gateway/admin-cli.ts set-password peter`.
- Demo flow to show a prospect: ask a question → correct a definition in chat
  (`report_correction`) → it lands **pending** → approve it in `/admin` → the next answer uses it.

### Inviting people (fresh token per person)

```bash
# on the box
docker exec -e SETOKU_TOKENS_FILE=/data/teammates.json \
  setoku-bulldogs-demo-server-1 bun gateway/admin-cli.ts add-teammate alice@example.com
# then restart the gateway so the new token loads:
docker compose -p setoku-bulldogs -f /opt/setoku/demo/docker-compose.demo.yml \
  -f /opt/setoku/demo/docker-compose.edge.yml --env-file /opt/setoku/demo/.env.bulldogs \
  up -d demo-server
```

## The data model — 9 vendor systems (Postgres schemas)

There are **no foreign keys between schemas**; the shared keys are `event_no` (games) and a
**normalized email** for people. Money is **cents in `ticketing`, dollars everywhere else**.

| Schema | Vendor-style system | Holds | Money |
|---|---|---|---|
| `ticketing` | Archtics/Tickets.com-style | teams, events (start time + promo pricing), accounts, seat manifest & sales ledger (with scan-in times) | cents |
| `crm` | Salesforce-style | marketing contacts (duplicates; messy `cs_notes`) | — |
| `sponsorship` | KORE-style | partners, contracted deals, deal assets | dollars |
| `pos` | concessions point-of-sale | F&B transactions + line items (promo pricing on some games) | dollars |
| `merch` | team online store feed | online merch orders only (**partial** — Fanatics not here) | dollars |
| `hr` | Workday/ADP-style | workers, comp, gameday shifts (mostly vendor-staffed) | dollars |
| `marketing` | ad-platform exports | spend & delivery by platform (no sales attribution) | dollars |
| `ops` | incident-management system | gameday incident log (cleanups, ejections, medical, …) | — |
| `media` | broadcast/media-rights contracts | annual rights fees (RSN, national, streaming, radio) — the **biggest** revenue line | dollars |

The club plays in a 30-team league (`ticketing.team` holds the 29 opponents; ~22 appear per season).
Total annual revenue lands ~$180–200M, of which media rights are ~$90M.

The curated knowledge (`bulldogs/.setoku/context/`) ships entity docs, canonical
metric SQL, an identity-resolution recipe, and the gotchas (mixed units, dedupe, code maps,
coverage caveats) — so `find_context` has something real to return.

## Boot / re-seed on the box

The box already runs production Setoku and has the `setoku-server` image built, so the demo
reuses it. From `/opt/setoku/demo`:

```bash
./boot.sh            # first run generates .env.bulldogs (tokens + PG password), seeds, starts the gateway
```

It starts a demo Postgres, seeds the data (deterministic — same `SEED` ⇒ identical data),
and starts the gateway on `127.0.0.1:8789`, auto-joining the production Caddy network if
present. Re-seed in place anytime by re-running `./boot.sh` (schema drops and recreates).

Public routing (one deliberate step): append `caddy-bulldogs.snippet` to
`/opt/setoku/Caddyfile`, then — because the Caddyfile bind-mount is inode-pinned — recreate
(not reload) Caddy:

```bash
cat caddy-bulldogs.snippet >> /opt/setoku/Caddyfile
docker compose -p setoku up -d --force-recreate --no-deps caddy
```

### Scale

`DEMO_SEATS_PER_GAME` controls volume (default **26000** ≈ 6.3M seat rows across 3 seasons,
~3–4 min reseed; sized so attendance is a realistic mid-market gate ~16.5k/game and total revenue
lands ~$180–200M/season). The F&B/attendance figures derive from it. Drop it (e.g. `=10000`) for a
faster, lighter reseed, or push toward a full MLB house with `DEMO_SEATS_PER_GAME=38000`. The box
has the headroom; query latency stays sub-second-to-~1s.

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
docker compose -p setoku-bulldogs -f docker-compose.demo.yml -f docker-compose.edge.yml down -v
# then remove the demo block from /opt/setoku/Caddyfile and recreate caddy
```

This leaves production untouched.
