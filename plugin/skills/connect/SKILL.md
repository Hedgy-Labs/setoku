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

**Two rules that never bend:**

- **You propose; the human applies anything sensitive.** Buying a VPS, provider
  credentials, creating a read-only DB role, editing the box's `.env`,
  restarting services — walk the human through these, or do them yourself only
  with explicit access (e.g. they paste SSH). Never invent or paste a credential.
- **The membrane (I2/I9).** Curated knowledge enters only through a human. You
  may be on an **analyst** connector (reads everything incl. the lake;
  propose-only) or a **curator** connector (can `upsert_context`, reads the
  business DB, but **cannot read the lake**). Use whichever read access you have;
  write confirmed knowledge with `upsert_context` when curator tools are present,
  otherwise `report_correction` (a human promotes it via `/setoku:curate`).
  **Never try to hold both connectors at once** — that's the injection hole the
  split exists to close.

Act first, narrate briefly. Default to doing the work when you have access;
instruct precisely when you don't.

## 0 — Is there a box?

A box is one small VPS running the gateway + knowledge store + connectors. Check
for it first: call a context tool (e.g. `list_entities`). If the Setoku tools
aren't available or error with a connection failure, there's no box yet.

**No box →** explain what it is, then get one running:

1. Provision a cheap Ubuntu VPS (~$12/mo). Buying it is the human's step.
2. `git clone https://github.com/Hedgy-Labs/setoku /opt/setoku && cd /opt/setoku && ./deploy/bootstrap.sh` — installs Docker, generates secrets, gets real HTTPS (sslip.io if no domain), brings the stack up, prints the connect command + tokens. If the human pastes SSH access, run this for them; otherwise hand them the commands.
3. Connect this Claude with the printed `claude mcp add …` (or the `/i/<token>` one-liner).

Loop until a context tool answers, then continue.

**Box present →** continue.

## 1 — Pick a source

See what's already connected, then offer a menu.

- Business DB: `get_schema` (no args) shows the connected Postgres, if any.
- Lake connectors: `run_query` with `dialect: "clickhouse"`, `SHOW TABLES FROM setoku` (then any per-source tables that exist tell you what's flowing).

Offer: **business database** (Postgres/MySQL/…), **logs/telemetry** (Vercel,
Render), **Slack**, a **SaaS/API** (Stripe, Shopify, GA4, a bank, …), a
**warehouse** (BigQuery/Snowflake — when adapters land), or **something else**.
Let the human pick one, or name an unknown one.

## 2 — Connect it  (discover → plan → apply → document)

**Known source — run the proven recipe** (see Recipes below). Walk the human
through the provider side (creating a token / read-only role), then set the
config on the box and restart. The credential lives on the box, never in a repo.

**Unknown source — improvise, carefully:**

1. **Research** the API against its *official* docs (don't trust memory — vendor
   facts churn): base URL, auth, the read-only endpoints you need, rate limits.
2. **Choose the shape:** a live read-only connection (if it's a queryable DB or
   warehouse) or a **pull-bridge** (poll the API → Vector → the lake), modeled on
   `ingest/mercury-poller/` — that's the reference pattern.
3. **Draft** the connector + a typed lake schema + the compose wiring, and show
   the human the plan. They provide the credential and approve the apply.
4. Keep an improvised connector **box-local first**; once it's run clean for a
   while, PR it to the repo so it becomes a proven recipe. (You build what the
   customer needs; we harden what recurs.)

**Document each step.** Connecting is idempotent: note what you applied so a
re-run skips it, and never print a secret back.

## 3 — Verify it understands the data  *(do not skip)*

Now interrogate the source until your model of it matches the human's. Use your
read access (analyst reads the lake; either connector reads the business DB):

- **Shape it:** row counts per key table, date ranges, distinct values of
  categorical columns, null rates, the obvious join keys.
- **Ask what things mean:** "`status` ∈ {active, trialing, canceled} — which
  count as paying?"; "is `amount` gross or net of refunds?"; "this table is
  1.2M rows from 2024-08 to today — does that match what you expect?"
- **Reconcile counts against the human's expectations:** "you said ~500 paying
  customers; I count 487 — the 13 gap is trialing accounts, right?" A mismatch
  means a gotcha is hiding. Dig until it reconciles; the gotcha is the gold.

**Write down what you learn.** Every confirmed definition / metric / gotcha
becomes knowledge: `upsert_context` (curator session on the business DB) or
`report_correction` (otherwise — the human promotes it). If the source has a
codebase that explains its semantics, offer to run `/setoku:generate` to derive
context from the code.

## 4 — Prove the loop

Ask one real business question end-to-end (`find_context` → `run_query` →
answer) against the new source to prove it works. Then summarize: what's
connected, what you learned, and the open questions worth a human's attention.

## Recipes (known sources)

- **Postgres / MySQL (business DB).** Create a read-only role
  (`deploy/readonly-role.sql`); put the connection string in the box's
  `SETOKU_DATABASE_URL`; set the table allow-list in `.setoku/config.json`;
  restart the server. Verify with `get_schema`.
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
  source's profile, restart. Minimize sensitive fields at ingest.

All of these: the human creates the provider credential; you wire the box and
restart (directly with SSH access, or by handing over the exact steps).
