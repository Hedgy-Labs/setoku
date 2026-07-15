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
   — just connect this Claude (see **Name the connector** below): `claude mcp add --transport http <name>-setoku https://<domain>/mcp --header "Authorization: Bearer <analyst-token>"`. Mint the token on the box: `docker compose exec server bun gateway/admin-cli.ts add-person <email>` (or the human clicks **Invite** on `/admin/team`). On an older box the token may instead live as `SETOKU_TOKENS=token=identity` in `.env` — use the part before the `=`. Then continue.
3. **No box at all** → stand one up:
   - Provision a cheap Ubuntu VPS (~$12/mo). Buying it is the human's step.
   - `git clone https://github.com/Hedgy-Labs/setoku /opt/setoku && cd /opt/setoku && SETOKU_ADMIN_USER=<email> ./deploy/bootstrap.sh` — installs Docker, generates secrets, gets real HTTPS (sslip.io if no domain), brings the stack up, and creates the operator: ONE identity that is both the `/admin` login (used later to approve knowledge) and the agent connector, with the connect command + generated password printed at the end. Setting `SETOKU_ADMIN_USER` keeps it fully non-interactive (otherwise it pauses once to ask for the operator's email). Safe to run over SSH; if the human pastes SSH access, run it for them, otherwise hand them the command.
   - Connect this Claude (see **Name the connector** below). That's enough to start — no second connector needed yet.

**Name the connector.** Don't use the bare name `setoku` — a person doing this a
second time (a demo box, another deployment) already has a `setoku` connector, and
Claude Code's `mcp add` would collide or the wrong box wins. Ask the human for a
**short name for this setoku** — whatever identifies the box to them (a handle,
a team, a project — `campsh`) — slugify it, and use
`<name>-setoku` as the connector name everywhere (`campsh-setoku`). Persist the
name so the box's own installer links match: add `"name": "<name>"` to the repo's
`.setoku/config.json` (create/extend, never clobber). Then **verify it actually
connected** — run `claude mcp list` (or call a context tool like `list_entities`)
and confirm `<name>-setoku` answers before continuing; if it doesn't, fix the
token/domain and re-add. This connector name is also the tool prefix onboarding
allowlists (`mcp__<name>-setoku`), so keep them identical.

## 1 — Pick a source  *(analyst connector)*

See what's already connected, then offer a menu. (Lake discovery needs the
analyst connector — on curator it's blocked.)

- Business DB: `get_schema` (no args) lists the mirrored business tables (`biz.*`), if any.
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
> `.setoku/config.json` (`allowTables` / `denyTables`) — it scopes what pg-mirror
> mirrors into `biz.*`. "Set the config" can mean either — say which.

**Unknown source — improvise, carefully:**

1. **Research** the API against its *official* docs (don't trust memory — vendor
   facts churn): base URL, auth, the read-only endpoints you need, rate limits.
2. **Choose the shape:** a live read-only connection (if it's a queryable DB or
   warehouse) or a **pull-bridge** (poll the API → Vector → the lake), modeled on
   `ingest/mercury-poller/` (the reference pattern; `provisioner/sources/*.ts`
   shows the push/drain variants). Minimize sensitive fields at ingest.
3. **Draft** the connector and wire it. A pull-bridge modeled on
   `ingest/mercury-poller/` is **6 coordinated touchpoints** — miss one and it
   fails *silently* (no error, data just never lands):
   1. `ingest/<name>-poller/poll.ts` + its `Dockerfile`;
   2. a compose **service block** for the poller;
   3. `ingest/schemas/0XX_<name>.sql` — the typed lake table. ⚠ **initdb runs this
      only once, on a fresh `ch_data` volume.** On an existing box apply it by hand:
      `docker compose exec -T clickhouse clickhouse-client < ingest/schemas/0XX_<name>.sql`;
   4. add the new profile to the **`clickhouse` (and `vector`) service `profiles:` list**
      in `docker-compose.yml` — else `--profile <name>` starts the poller but not the
      lake/Vector it pushes to;
   5. three edits to `deploy/vector/vector.yaml`: a `router` route, a `*_parse` remap,
      and a `lake_*` ClickHouse sink;
   6. an inbound *webhook* connector (not a poller) also needs a `handle /ingest/<name>/*`
      block in the `Caddyfile` with token-path auth + a Caddy reload.
   Show the human the plan. They provide the credential and approve the apply. Remember
   `bun run deploy` rebuilds only `server` — rebuild the poller (`up -d --build <poller>`)
   and reload Vector (`up -d vector`) yourself.
4. Keep an improvised connector **box-local first**; once it's run clean for a
   while, PR it to the repo so it becomes a proven recipe. (You build what the
   customer needs; we harden what recurs.)

**Record what you applied.** There's no provisioning-log tool yet, so write a
short note of what you changed (which env vars, which profile, which schema) into
your Phase 4 summary, and — if it's a durable operational fact — as a knowledge
note so a re-run or a teammate doesn't redo it. Never print a secret back.

## 3 — Verify it understands the data  *(do not skip)*

Now interrogate the source until your model of it matches the human's. Use your
read access on the analyst connector (it reads the lake, business tables
included as `biz.*`; curator reads neither):

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
is `report_correction` (required args: `kind` ∈ {gotcha, metric, entity, other}
and `fact` — the single concise claim; optional `context` for supporting
evidence; **set `relates_to`** to the entity/metric it's about), e.g.
`report_correction {"kind":"gotcha","fact":"Active companies exclude Company.isInternal=true (internal/test tenants).","context":"isInternal flags our own test tenants; saw it in src/models/company.ts","relates_to":"Company"}`.
Propose it, and a human accepts it at `https://<domain>/admin`.
**This is the moment to introduce the approval page** if you haven't: it's the
curation surface — the *only* place knowledge is committed, by a human, outside
the agent's loop. Have them sign in now with the login `bootstrap` printed (reset
with `admin-cli set-password <user>` if lost). Everything you propose lands there
as pending until they accept. That's the whole loop for most setups; you don't
need anything else (`/setoku:curate` is the same accept step from the CLI).

**Only if the human wants to commit knowledge directly during this session** do
you set up the **curator** connector. It's a separate connector on purpose:

| | **analyst** (setup default) | **curator** |
|---|---|---|
| reads the lake (incl. `biz.*` business tables) | ✅ | **❌ hard-blocked** |
| `report_correction` (propose) | ✅ | ✅ |
| `upsert_context` (commit knowledge) | ❌ | ✅ |

The split is the membrane (I2/I9): a session that can commit knowledge can't read
the untrusted lake, so an injected log line can't poison the store. **Never hold
both connectors in one session.** To enable curator, on the box:

```
cd /opt/setoku && docker compose exec server bun gateway/admin-cli.ts create-curator-token <your-identity>
```

It prints the `SETOKU_CURATOR_TOKENS` line to append to `/opt/setoku/.env` and the
`claude mcp add … <name>-setoku-curator …` command (the box's connector name plus
`-curator`). Append, `docker compose up -d server`,
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
  Easiest: the human clicks **Invite** on `https://<domain>/admin/team` — it mints
  a read-only connector and shows the dev one-liner + claude.ai steps right there.
  From the CLI it's `docker compose exec server bun gateway/admin-cli.ts add-teammate <identity>` (the identity is conventionally their email; it creates their web login too — one person, one connector). Offer to add a couple of teammates either way.
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
  production unless the human explicitly chooses it.**

  *Finding the admin URL is the tricky part — don't assume `DATABASE_URL`.* Many
  real apps don't have it. Look in this order, and **grep out only the one URL you
  need — never read or echo the rest of `.env`** (it holds API keys, tokens, session
  cookies):
  - **Prisma:** the datasource URL is usually injected via `prisma.config.ts` /
    `schema.prisma` from an env var — commonly `POSTGRES_PRISMA_URL` (a **pooler**)
    and `POSTGRES_URL_NON_POOLING` (**direct**). Read those files to learn which var
    actually feeds the DB.
  - **Prefer a `localhost`/`127.0.0.1` URL.** Treat any `*.supabase.co`,
    `*.pooler.supabase.com`, `*.rds.amazonaws.com` host as remote production —
    confirm with the human before using it; the script will also gate it.
  - **Supabase/pgbouncer:** use the **DIRECT / non-pooling** URL (`...NON_POOLING`,
    or `db.<ref>.supabase.co:5432`), NOT the `pgbouncer=true` / `:6543` pooler — role
    creation and the read-only setting don't work through a transaction pooler (the
    script refuses poolers for this reason).

  Then one command does the role + URL (pass the admin URL via `ADMIN_URL` so it
  stays out of shell history):

  ```
  ADMIN_URL='postgresql://owner:…@localhost:5432/yourdb' deploy/connect-postgres.sh --env-file /opt/setoku/.env
  ```

  It creates a least-privilege read-only role `setoku_ro`, **verifies writes are
  refused**, and writes `SETOKU_DATABASE_URL` into the box's `.env`. That URL is
  consumed by **pg-mirror** (the mirror step below), not the gateway — the server
  container gets no DB URL. Re-running is safe — it **reuses** the role's password
  (won't knock a running mirror offline); `--rotate` forces a new one;
  `--allow-remote` is required for a non-local host. (No `--env-file`? It prints
  the line. MySQL: no helper yet — create a read-only user by hand and set the URL.)

  Last, set the table allow-list in the **repo's** `.setoku/config.json` — it
  scopes what pg-mirror mirrors into `biz.*`, which is exactly what the agent
  can query (scaffold it if missing — `dataSource.urlEnv` is the env-var *name*,
  `allowTables` the globs):

  ```json
  { "dataSource": { "kind": "postgres", "urlEnv": "SETOKU_DATABASE_URL" },
    "allowTables": ["public.*"], "denyTables": ["public._prisma_migrations"],
    "rowCap": 200, "statementTimeoutMs": 15000 }
  ```

  The config holds only the *name*; pg-mirror resolves the actual URL from
  `process.env[urlEnv]`. So keep the secret on the box
  (`/opt/setoku/.env`) and out of git. `allowTables: ["public.*"]` is a good default
  — it also scopes away Supabase system schemas (`auth`, `storage`, …); keep
  `_prisma_migrations` in `denyTables`. Verify with `get_schema` after the first
  mirror run (business tables appear as `biz.<table>`).

  **Finally, enable the mirror (required — it IS the read path).** The
  `pg-mirror` container full-reloads every allowlisted table into ClickHouse
  `biz.*` on a loop; the gateway holds no pg client or DB URL, so business
  tables are queryable only as their `biz.*` mirror copies (issue #47). It
  reuses `SETOKU_DATABASE_URL` (the read-only role — the allow-list is
  inherited, a denied table never leaves the DB) and needs no extra secrets:
  add `mirror` to `COMPOSE_PROFILES`, then `docker compose --profile mirror up
  -d --build pg-mirror`. Watch the first reload land (`list_sources` grows a
  BUSINESS-DB MIRROR section with per-table "data as of"; `/healthz` gains a
  `mirror` field), then verify against the mirror: run counts and shape queries
  on `biz.<table>` (`SELECT count() FROM biz.<t>` — clickhouse is the default
  and only `run_query` dialect; postgres statements are rejected with the
  `biz.*` rewrite) and reconcile them with the human's expectations plus the
  table's "data as of". The live source is not reachable from the gateway, so
  all verification happens via `biz.*` after the first mirror run. If the box
  has legacy postgres-dialect metric/query docs, run the "Migrating knowledge
  to the mirror" pass in /setoku:generate. Poolers are fine here (plain
  SELECTs, no replication prereqs). ⚠ The allow/deny list is **baked into the
  pg-mirror image** — after editing `.setoku/config.json`, rebuild:
  `docker compose up -d --build pg-mirror`.
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
- **Monarch Money (personal finance).** No API key, and Monarch **blocks
  automated password logins** (CAPTCHA + an app-version gate; datacenter IPs also
  hit a Cloudflare wall) — so don't try to log in from the box. Auth is a **browser
  session**: have the human copy `session_id` + `csrftoken` from a logged-in Monarch
  browser (DevTools → Network → an `api.monarch.com/graphql` request → Cookie header),
  then run `deploy/set-monarch-cookie.sh --env-file /opt/setoku/.env`. Enable the
  `monarch` profile (`ingest/monarch-poller`), restart. Pulls accounts, transactions,
  net worth, budgets, and the investment portfolio; forces a daily institution
  refresh at 1pm Pacific. The session expires in days-to-weeks — freshness signal is
  `max(monarch_accounts.snapshot_ts)`.

## Box command cheat-sheet

Everything runs from `/opt/setoku` on the box (use `deploy/dc.sh` if `docker
compose` v1/v2 differ on the host).

```
# edit secrets / profiles
$EDITOR /opt/setoku/.env          # SETOKU_DATABASE_URL, RENDER_*, SLACK_*, MERCURY_*, COMPOSE_PROFILES

# enable a source's profile: add it to COMPOSE_PROFILES (comma-separated) in .env, then
docker compose --profile <name> up -d <service>   # e.g. --profile mercury up -d mercury-poller

# connect a Postgres business DB in one shot (read-only role + URL for pg-mirror)
ADMIN_URL='postgresql://owner:…@host:5432/db' deploy/connect-postgres.sh --env-file /opt/setoku/.env

# mirror the business DB into the lake (biz.* — THE read path; the gateway gets no DB URL)
docker compose --profile mirror up -d --build pg-mirror   # + add `mirror` to COMPOSE_PROFILES

# apply config / restart the gateway (picks up .env + profile changes)
docker compose up -d server

# deploy a CODE change to the box (git-clone deploys — the bootstrap default)
cd /opt/setoku && git pull && docker compose up -d --build server
#   then verify:  curl -s https://<domain>/health   → check the "version" field
#   (rsync-based box, or a deeper deploy / rollback: see docs/deploy.md)

# add a person — web login + analyst connector under ONE identity (their email);
# prints the temp password + dev one-liner + claude.ai connector steps
docker compose exec server bun gateway/admin-cli.ts add-person <email>
#   (add-teammate is the member alias; --role admin for another approver)

# mint a curator connector token (Phase 3 — only when committing knowledge directly)
docker compose exec server bun gateway/admin-cli.ts create-curator-token <identity>

# create an /admin login WITHOUT a connector (repair/escape hatch — prefer add-person)
docker compose exec server bun gateway/admin-cli.ts create-user <username> --role admin
```
