---
name: connect
description: Connect a data source to Setoku end-to-end — ensure a box exists, wire the source up (read-only), verify the agent actually understands the data, and write what it learns back as knowledge. Use when the user says "connect <source>", "hook up <source>", "add a data source", "set up Setoku", or "/setoku:connect".
---

# Setoku connect — the agentic FDE

You are connecting one data source to Setoku and **proving you understand it**.
Connecting isn't done when bytes flow; it's done when you've checked your reading
of the data with the human and written that understanding into the knowledge
store. Work one source at a time. Be conversational — this is a setup session
with a person who knows the business.

Act first, narrate briefly. Default to doing the work when you have access
(e.g. the human pastes SSH); instruct precisely when you don't. Never invent or
paste a credential — the human creates provider tokens and DB roles.

## Two connectors, never both at once (the membrane — I2/I9)

Setoku deliberately splits read access from write access into two MCP
connectors. You will be on exactly one at a time:

| | **analyst** connector | **curator** connector |
|---|---|---|
| reads business DB (`get_schema`, `run_query` Postgres) | ✅ | ✅ |
| reads the lake (`run_query` `dialect:"clickhouse"`) | ✅ | ❌ hard-blocked |
| writes knowledge (`upsert_context`) | ❌ | ✅ |
| `report_correction` (propose only) | ✅ | ✅ |

So **discovery and lake reads happen on analyst; writing confirmed knowledge
happens on curator.** They are different sessions. Switching means telling the
human which connector to select, or doing the explore pass on analyst and the
write pass on curator. **Never try to hold both connectors in one session** —
that's the injection hole the split exists to close. If `upsert_context` isn't
available, you're on analyst: file `report_correction` and a human promotes it
via `/setoku:curate` (curator connector) or the `/admin` approval page.

Bootstrap wires up the **analyst** connector only. The curator connector is a
separate, deliberate step — see Phase 0.

## 0 — Is there a box, and which connectors are wired?

A box is one small VPS running the gateway + knowledge store + connectors. Three
states, not two — figure out which:

1. **Tools work** (a context tool like `list_entities` answers) → box exists and
   this Claude is connected. Continue to Phase 1.
2. **No Setoku tools available here, but the human already has a box** (ask: "do
   you already have a Setoku box? what's its domain?"). Don't provision a new one
   — just connect this Claude: `claude mcp add --transport http setoku https://<domain>/mcp --header "Authorization: Bearer <analyst-token>"`. The token is the analyst `SETOKU_TOKENS` value from the box's `.env`. Then continue.
3. **No box at all** → stand one up:
   - Provision a cheap Ubuntu VPS (~$12/mo). Buying it is the human's step.
   - `git clone https://github.com/Hedgy-Labs/setoku /opt/setoku && cd /opt/setoku && ./deploy/bootstrap.sh` — installs Docker, generates secrets, gets real HTTPS (sslip.io if no domain), brings the stack up, prints the connect command + tokens. **Heads-up: bootstrap is interactive** — it pauses to ask for an admin username (that's the `/admin` login the human uses later to approve knowledge). It can't run on a fully non-interactive pipe; if you're driving over SSH, run it on a TTY or set the admin user separately with `admin-cli create-user`. If the human pastes SSH, run it for them; otherwise hand them the commands.
   - Connect this Claude with the printed `claude mcp add …` (analyst connector).

**Mint the curator connector now** (needed for Phase 3 writes, and not created by
bootstrap). On the box:

```
cd /opt/setoku && docker compose exec server bun gateway/admin-cli.ts create-curator-token <your-identity>
```

It prints the line to append to `SETOKU_CURATOR_TOKENS` in `/opt/setoku/.env`
and the `claude mcp add … setoku-curator …` command. Append, restart the server
(`docker compose up -d server`), add the connector. Now the human can switch
between analyst and curator. Don't add it if you don't intend to write knowledge
this session.

## 1 — Pick a source  *(analyst connector)*

See what's already connected, then offer a menu. (Lake discovery needs the
analyst connector — on curator it's blocked.)

- Business DB: `get_schema` (no args) lists the connected Postgres tables, if any.
- Lake connectors: `run_query` `dialect:"clickhouse"`, `SHOW TABLES` (then
  `DESCRIBE <table>`); the tables that exist tell you what's flowing.

Offer: **business database** (Postgres/MySQL/…), **logs/telemetry** (Vercel,
Render), **Slack**, a **SaaS/API** (Stripe, Shopify, GA4, a bank, …), a
**warehouse** (BigQuery/Snowflake — when adapters land), or **something else**.
Let the human pick one, or name an unknown one.

## 2 — Connect it  (discover → plan → apply → document)

**Known source — run the proven recipe** (see Recipes below). Walk the human
through the provider side (creating a token / read-only role), then set the
config and restart. The credential lives on the box, never in a repo.

> **Box vs. repo — keep them straight.** Credentials and profiles live on the
> box (`/opt/setoku/.env`). The Postgres table allow-list lives in the **repo's**
> `.setoku/config.json` (`allowTables` / `denyTables`), because the gateway reads
> it per-project. "Set the config" can mean either — say which.

**Unknown source — improvise, carefully:**

1. **Research** the API against its *official* docs (don't trust memory — vendor
   facts churn): base URL, auth, the read-only endpoints you need, rate limits.
2. **Choose the shape:** a live read-only connection (if it's a queryable DB or
   warehouse) or a **pull-bridge** (poll the API → Vector → the lake), modeled on
   `ingest/mercury-poller/` (the reference pattern; `provisioner/sources/*.ts`
   shows the push/drain variants). Minimize sensitive fields at ingest.
3. **Draft** the connector + a typed lake schema + the compose wiring, and show
   the human the plan. They provide the credential and approve the apply.
4. Keep an improvised connector **box-local first**; once it's run clean for a
   while, PR it to the repo so it becomes a proven recipe. (You build what the
   customer needs; we harden what recurs.)

**Record what you applied.** There's no provisioning-log tool yet, so write a
short note of what you changed (which env vars, which profile, which schema) into
your Phase 4 summary, and — if it's a durable operational fact — as a knowledge
note so a re-run or a teammate doesn't redo it. Never print a secret back.

## 3 — Verify it understands the data  *(do not skip)*

Now interrogate the source until your model of it matches the human's. Use your
read access (analyst reads the lake; either connector reads the business DB):

- **Shape it:** row counts per key table, date ranges, distinct values of
  categorical columns, null rates, the obvious join keys.
- **Mind the engine.** Lake tables differ: a `ReplacingMergeTree` needs `FINAL`
  (e.g. `mercury_transactions`) to avoid double-counting in-flight updates, but a
  plain `MergeTree` (e.g. `mercury_accounts`) **rejects** `FINAL` (`ILLEGAL_FINAL`).
  `DESCRIBE`/`SHOW CREATE TABLE` first; don't assume. This kind of engine quirk
  is exactly the sort of gotcha worth writing down.
- **Ask what things mean:** "`status` ∈ {active, trialing, canceled} — which
  count as paying?"; "is `amount` gross or net of refunds?"; "this table is
  1.2M rows from 2024-08 to today — does that match what you expect?"
- **Reconcile counts against the human's expectations:** "you said ~500 paying
  customers; I count 487 — the 13 gap is trialing accounts, right?" A mismatch
  means a gotcha is hiding. Dig until it reconciles; the gotcha is the gold.

**Write down what you learn.** Every confirmed definition / metric / gotcha
becomes knowledge. On the **curator** connector: `upsert_context` (deliberate,
human-driven, reading the customer's own data — allowed). On **analyst**:
`report_correction`, then a human promotes it. If the source has a codebase that
explains its semantics, offer `/setoku:generate` to derive context from the code.

## 4 — Prove the loop, then hand off

Ask one real business question end-to-end (`find_context` → `run_query` →
answer) against the new source to prove it works. Then summarize:

- **What's connected** + what you changed on the box (env/profile/schema).
- **What you learned** (the definitions, metrics, gotchas you wrote down).
- **Open questions** worth a human's attention.
- **Where to promote proposals:** any `report_correction` you filed is pending
  until a human accepts it — at `https://<domain>/admin` (the approval page) or by
  running `/setoku:curate` on the curator connector. Tell them which.

## Recipes (known sources)

For all of these: the human creates the provider credential; you wire the box and
restart. Profiles are **off by default** (`bootstrap` seeds only `lake,ingest`),
so enabling a source means adding its profile — see the cheat-sheet below.

- **Postgres / MySQL (business DB).** Create a read-only role
  (`deploy/readonly-role.sql`); put the connection string in the box's
  `SETOKU_DATABASE_URL`; set the table allow-list in the **repo's**
  `.setoku/config.json` (`allowTables`); restart the server. Verify with
  `get_schema`. **Default to a dev/staging DB — never point at production unless
  the human explicitly chooses it.** (Read-only is enforced by the role, but a
  hastily-made role on prod is still a footgun.)
- **Vercel logs.** Create a log drain to `https://<domain>/ingest/vercel` with
  the ingest token; set `SETOKU_VERCEL_VERIFY` to the value Vercel requires;
  enable the `ingest` profile; restart.
- **Render logs.** No push API → pull: set `RENDER_API_KEY` / `RENDER_OWNER_ID` /
  `RENDER_SERVICE_IDS`, enable the `render` profile (`ingest/render-poller`),
  restart.
- **Slack.** Socket-Mode app (app + bot tokens); set `SLACK_APP_TOKEN` /
  `SLACK_BOT_TOKEN`, enable the `slack` profile; backfill once.
- **Mercury / generic SaaS API.** Read-only token → pull-bridge
  (`ingest/mercury-poller` is the template): set the token env, enable the
  source's profile, restart.

## Box command cheat-sheet

Everything runs from `/opt/setoku` on the box (use `deploy/dc.sh` if `docker
compose` v1/v2 differ on the host).

```
# edit secrets / profiles
$EDITOR /opt/setoku/.env          # SETOKU_DATABASE_URL, RENDER_*, SLACK_*, MERCURY_*, COMPOSE_PROFILES

# enable a source's profile: add it to COMPOSE_PROFILES (comma-separated) in .env, then
docker compose --profile <name> up -d <service>   # e.g. --profile mercury up -d mercury-poller

# apply config / restart the gateway
docker compose up -d server

# mint a curator connector token (Phase 0)
docker compose exec server bun gateway/admin-cli.ts create-curator-token <identity>

# create an /admin login
docker compose exec server bun gateway/admin-cli.ts create-user <username> --role admin
```
