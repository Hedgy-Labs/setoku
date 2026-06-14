# Onboarding via `/setoku:connect`

**Status:** built. The skill is `plugin/skills/connect/SKILL.md`; `onboard` is now
a thin first-run wrapper over it. The decisions below are what shipped (onboard →
wrapper; improvised connectors stay box-local until a human PRs them). This doc
is the design rationale; the skill is the implementation.

The way you get value out of Setoku is: stand up a box, connect your data
sources, and let the agent learn what the data means. Right now that's spread
across `/setoku:onboard` (repo + DB config) and a half-built provisioner idea.
This proposes one front door — **`/setoku:connect`** — that walks you through it,
source by source, and *verifies it actually understands the data* before
declaring victory.

It's the "agentic FDE" made concrete: a skill that uses the agent's own tools
(shell, SSH, web, file edits) plus the box's MCP tools to hook a source up and
write back what it learns as knowledge.

## The experience

```
/setoku:connect              # or /setoku:connect stripe
```

### 0 — Is there a box?
First the skill checks for a reachable gateway (try a context tool like
`list_entities`; connection failure → no box).

- **No box** → explain what it is (one small VPS running the gateway + knowledge
  store + connectors) and walk through standing one up: provision a cheap Ubuntu
  VPS, run `deploy/bootstrap.sh` (Docker + secrets + HTTPS + stack, one command),
  then connect this Claude with the printed `claude mcp add …` / `/i/<token>`
  installer. If you paste SSH access, the agent can run bootstrap for you; buying
  the VPS stays a human step. Loop until the box answers, then continue.
- **Box present** → continue.

### 1 — Pick a source
Show what's already connected (from the Sources view), then offer a menu:
business database (Postgres/MySQL/…), logs/telemetry (Vercel, Render), Slack,
a SaaS/API (Stripe, Shopify, GA4, a bank…), a warehouse (BigQuery/Snowflake,
when adapters land), or **"something else."** You pick one — or name an unknown
one.

### 2 — Connect it (discover → plan → apply → document)
- **Known pattern** → run the proven recipe:
  - *Postgres/MySQL* — create a read-only role (`deploy/readonly-role.sql`), put
    the connection string in the box's `SETOKU_DATABASE_URL`, set the table
    allow-list, restart. The credential lives on the box, never in the repo.
  - *Vercel / Render / Slack / Mercury* — the existing drain / pull-bridge
    patterns (`ingest/*-poller`): create the provider token, set its env on the
    box, enable the compose profile, restart.
- **Unknown source** → the agent figures it out: research the API against
  official docs (base URL, auth, read endpoints, rate limits — verify, don't
  guess), choose the shape (live read-only vs. a poller modeled on
  `ingest/mercury-poller`), draft the connector + lake schema + compose wiring,
  and propose it. You provide the credential and approve the apply.
- **Safety / membrane throughout** — the agent *proposes*; a human approves the
  credential and the actual apply (editing the box `.env`, restarting). Each step
  is recorded in `provisioning_log` (idempotency key → re-runs skip what's done;
  secrets redacted). Connecting a source is inherently human-gated (buying infra,
  provider creds, DB roles — see I9).

### 3 — Verify it understands the data *(the important part)*
Connecting isn't done when bytes flow — it's done when the agent has *checked its
understanding*. Once the source is queryable it explores and interrogates:

- Run shape queries: row counts per key table, date ranges, distinct values of
  categorical columns, null rates, the obvious join keys.
- Form hypotheses and **ask you**: "`status` ∈ {active, trialing, canceled} —
  which count as paying?"; "is `amount` gross or net of refunds?"; "1.2M rows
  from 2024-08 to today — does that match what you expect?"
- **Verify counts against your expectations**: "you said ~500 paying customers;
  I count 487 — the 13 gap is trialing accounts, right?" A mismatch means a
  gotcha is hiding; dig until it reconciles.

Everything confirmed becomes **knowledge**: entity docs, metric definitions, and
gotchas written to the store (via the `setoku-curator` connector — this is a
deliberate, human-driven session reading the customer's own data, not untrusted
lake bulk). Anything still fuzzy goes in as a `report_correction` for later
review.

### 4 — Prove the loop
Ask one real business question end-to-end against the new source
(`find_context` → `run_query` → answer) to prove it works, then summarize: what's
connected, what was learned, and the open questions worth a human's attention.

## How it fits the existing skills

- **`/setoku:connect`** becomes the front door for *data sources*. It absorbs the
  DB-connection + first-question parts of today's `onboard` and generalizes them
  to any source, plus the verify-the-data loop.
- **`/setoku:generate`** stays the *code → knowledge* path; `connect` calls it
  when a source has a codebase (or run it standalone). Curator connector.
- **`/setoku:curate`** stays the human review of proposed knowledge.
- **`/setoku:analyst`** stays everyday Q&A.
- **`onboard`** → retire or make it a thin alias that runs `connect` for the
  first source and offers `generate`. (Open question below.)

## What to build

1. `plugin/skills/connect/SKILL.md` — the orchestration skill (phases 0–4 above).
   Most of the work is here; it leans on the agent's existing shell/SSH/web/file
   tools + the box's MCP tools.
2. A small **connector recipe catalog** the skill references — Postgres, Vercel,
   Render, Slack, generic-API-poller — so known sources are one-shot and unknown
   ones fall back to improvisation. (Largely already encoded in `deploy/` and
   `ingest/`; this just indexes them for the skill.)
3. Optional gateway support, nice-to-have, not required for v1:
   - a `list_sources` MCP tool (reuse the Sources gather logic) so the skill can
     see what's connected without SSH;
   - expose `log_provisioning` as a curator tool so `connect` records steps in
     `provisioning_log` for idempotency + audit (today it's a store method with
     no tool).
4. Reuse as-is: `deploy/bootstrap.sh`, `deploy/readonly-role.sql`, the
   `ingest/*-poller` patterns, compose profiles, the curator write-path.

## Open questions

1. **`onboard` vs `connect`** — fold `onboard` into `connect`, or keep it as a
   first-run wrapper? (Leaning: `connect` is the front door; `onboard` becomes an
   alias.)
2. **How much the agent does vs. instructs** — with SSH access it can edit the
   box `.env` and restart directly; without it, it hands the human exact steps.
   Default to acting when access is given, instructing otherwise.
3. **Unknown-source connectors** — when the agent improvises a poller, does it
   commit that connector back to the repo (so it becomes a proven pattern), or
   keep it box-local until a human promotes it? (Leaning: box-local first, PR to
   the repo once it's run clean for a while — "the agent builds what a customer
   needs; you harden what recurs.")
