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
paste a credential — the human creates provider tokens and DB roles. **This file
is your runbook, not the human's** — they just answer a few questions; don't make
them read the machinery.

**Tell the human what they'll need before you start** (so nothing ambushes them
mid-flow): for a brand-new box — a fresh Ubuntu VPS they can SSH into (~$12/mo);
for a Postgres source — an admin/owner connection URL to the database they want to
connect, and `psql` available wherever the connect helper runs. Surface this once,
up front, then proceed.

**Setup runs on the analyst connector** — read-only, propose-only. That's all you
need for Phases 0–3: discover the source, query it, verify it. You only set up the
*curator* connector at the moment you've actually confirmed knowledge worth saving
(Phase 3) — don't front-load it. (The why: writing curated knowledge and reading
the untrusted lake are deliberately split across two connectors so an injected log
line can't poison the store. Full model lives in Phase 3, where it matters.)

## 0 — Is there a box?

A box is one small VPS running the gateway + knowledge store + connectors. Three
states, not two — figure out which:

1. **Tools work** (a context tool like `list_entities` answers) → box exists and
   this Claude is connected. Continue to Phase 1.
2. **No Setoku tools available here, but the human already has a box** (ask: "do
   you already have a Setoku box? what's its domain?"). Don't provision a new one
   — just connect this Claude: `claude mcp add --transport http setoku https://<domain>/mcp --header "Authorization: Bearer <analyst-token>"`. The token is the analyst `SETOKU_TOKENS` value from the box's `.env` (which is
formatted `token=identity` — use the part before the `=`). Then continue.
3. **No box at all** → stand one up:
   - Provision a cheap Ubuntu VPS (~$12/mo). Buying it is the human's step.
   - `git clone https://github.com/Hedgy-Labs/setoku /opt/setoku && cd /opt/setoku && SETOKU_ADMIN_USER=<you> ./deploy/bootstrap.sh` — installs Docker, generates secrets, gets real HTTPS (sslip.io if no domain), brings the stack up, prints the connect command + tokens. Setting `SETOKU_ADMIN_USER` keeps it fully non-interactive (otherwise it pauses once to ask for an admin username — the `/admin` login used later to approve knowledge). Safe to run over SSH; if the human pastes SSH access, run it for them, otherwise hand them the command.
   - Connect this Claude with the printed `claude mcp add …` (analyst connector). That's enough to start — no second connector needed yet.

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
becomes knowledge. The simplest path — you're already on the analyst connector —
is `report_correction`: propose it, and a human accepts it at `https://<domain>/admin`
or via `/setoku:curate`. That's the whole loop for most setups; you don't need
anything else.

**Only if the human wants to commit knowledge directly during this session** do
you set up the **curator** connector. It's a separate connector on purpose:

| | **analyst** (setup default) | **curator** |
|---|---|---|
| reads business DB / lake | ✅ | DB ✅, **lake ❌ hard-blocked** |
| `report_correction` (propose) | ✅ | ✅ |
| `upsert_context` (commit knowledge) | ❌ | ✅ |

The split is the membrane (I2/I9): a session that can commit knowledge can't read
the untrusted lake, so an injected log line can't poison the store. **Never hold
both connectors in one session.** To enable curator, on the box:

```
cd /opt/setoku && docker compose exec server bun gateway/admin-cli.ts create-curator-token <your-identity>
```

It prints the `SETOKU_CURATOR_TOKENS` line to append to `/opt/setoku/.env` and the
`claude mcp add … setoku-curator …` command. Append, `docker compose up -d server`,
add the connector, switch to it, then `upsert_context`. (For finance/lake
knowledge you stay on analyst and `report_correction` — curator can't read the lake.)

If the source has a codebase that explains its semantics, offer `/setoku:generate`
to derive context from the code.

## 4 — Prove the *difference*, then share it

The person doing this is usually an engineer who **already has Claude on their
Postgres.** "Setoku can run a SELECT" impresses no one. The magic is the
annotation: the agent now answers *correctly* because it knows what the data
means. So don't just prove it queries — prove the curated knowledge **changes the
answer**:

- Pick a question where naive column-guessing gets it wrong but the captured gotcha
  gets it right (the "active user" excludes test accounts; spend excludes internal
  transfers; a status column is current-state so you count from the event log).
  Show the contrast out loud: "without the note you'd get X; the right answer is Y,
  because <gotcha>." *That* is the moment the engineer feels it.

Then go for the two bigger wins — this is where Setoku beats Claude-on-Postgres:

- **Share it with the team.** The knowledge you just captured is now everyone's.
  Mint a teammate connector: `docker compose exec server bun gateway/admin-cli.ts add-teammate <their-email>` — it prints a one-line installer for devs and
  claude.ai connector steps for everyone else. Offer to add a couple of teammates.
- **The non-technical magic moment.** For a founder/PM/ops teammate this may be the
  *first time they can query and visualize their own data in plain language* — and
  get the right number, because your annotations ride along. Tee it up: have them
  ask something like "show me signups by week" on claude.ai and watch Claude chart
  it. Name this explicitly when you hand off; it's the highest-value demo.

Then summarize:

- **What's connected** + what you changed on the box (env/profile/schema).
- **What you learned** (the definitions, metrics, gotchas you wrote down) — and the
  one where the annotation changed the answer.
- **Who you shared it with**, and the open questions worth a human's attention.
- **Where to promote proposals:** any `report_correction` you filed is pending
  until a human accepts it — at `https://<domain>/admin` (the approval page) or by
  running `/setoku:curate` on the curator connector. Tell them which.

Close on the note the safety story opened with — state it plainly once it's true,
e.g.: "Connected, read-only confirmed. Queries can't write, and nothing on your
box can change what Setoku knows without your approval."

## Recipes (known sources)

For all of these: the human creates the provider credential; you wire the box and
restart. Profiles are **off by default** (`bootstrap` seeds only `lake,ingest`),
so enabling a source means adding its profile — see the cheat-sheet below.

- **Postgres (business DB).** **Default to a dev/staging DB — never point at
  production unless the human explicitly chooses it.** Then one command does the
  role + URL (ask the human for an admin/owner connection URL to that DB; have
  them pass it via the `ADMIN_URL` env var so it stays out of shell history):

  ```
  ADMIN_URL='postgresql://owner:…@host:5432/yourdb' deploy/connect-postgres.sh --env-file /opt/setoku/.env
  ```

  It creates a least-privilege read-only role `setoku_ro`, **verifies it can read
  and that writes are refused**, and writes `SETOKU_DATABASE_URL` into the box's
  `.env` (idempotent — safe to re-run). Then restart: `docker compose up -d server`.
  (No `--env-file`? It just prints the line to set yourself. MySQL: no helper yet —
  create a read-only user by hand and set the URL.)

  Last, set the table allow-list in the **repo's** `.setoku/config.json` (scaffold
  it if missing — `dataSource.urlEnv` is the env-var name, `allowTables` the
  globs):

  ```json
  { "dataSource": { "kind": "postgres", "urlEnv": "SETOKU_DATABASE_URL" },
    "allowTables": ["public.*"], "denyTables": ["public._prisma_migrations"],
    "rowCap": 200, "statementTimeoutMs": 15000 }
  ```

  Verify with `get_schema`.
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

# connect a Postgres business DB in one shot (role + read-only URL + verify)
ADMIN_URL='postgresql://owner:…@host:5432/db' deploy/connect-postgres.sh --env-file /opt/setoku/.env

# apply config / restart the gateway
docker compose up -d server

# share with a teammate — prints dev one-liner + claude.ai connector steps (Phase 4)
docker compose exec server bun gateway/admin-cli.ts add-teammate <email>

# mint a curator connector token (Phase 3 — only when committing knowledge directly)
docker compose exec server bun gateway/admin-cli.ts create-curator-token <identity>

# create an /admin login
docker compose exec server bun gateway/admin-cli.ts create-user <username> --role admin
```
