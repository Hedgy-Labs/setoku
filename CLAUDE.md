# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Setoku is a self-hosted MCP server between Claude and a company's data — curated context plus a governed read-only query path; no LLM runs on the server (I8). See the README for the product picture.

This repo is the **dev/test harness**. The installable plugin lives in `./plugin` (its own `package.json`, deps installed on the box by a `SessionStart` hook). Root `package.json` (`setoku-dev`) drives development, build, and deploy.

Runtime is **Bun** throughout (`bun:sqlite`, `Bun.hash`, etc.) — not Node. TypeScript is type-checked but never emitted (`tsc --noEmit`); Bun runs `.ts`/`.tsx` directly.

## Commands

```bash
bun install                  # deps (root); plugin deps are separate (plugin/package.json)
bun run typecheck            # tsc --noEmit — the only "build" for the gateway
bun test                     # fast suite: test/ + ingest/ (~4s) — needs a local Postgres
bun test test/http.test.ts   # a single test file
bun run test:e2e             # browser e2e (e2e/) — slower, needs Chrome; run before deploys
bun run setup:hooks          # install the pre-push hook (gates pushes on the fast suite)

# Admin SPA (React, served by the gateway at /admin)
bun run dev:admin            # local dev server for the admin app
bun run build:admin          # rebuild app.css (Tailwind) + dist/app.js (committed artifacts)

bun run deploy               # rsync this checkout to a box + rebuild the server container
```

The fast `bun test` suite needs a reachable Postgres (defaults to a unix socket in `/tmp`; override with `SETOKU_E2E_PG_HOST`, `SETOKU_E2E_DB_URL`, `SETOKU_E2E_PG_MAINTENANCE_DB`). The browser e2e is deliberately **not** in the pre-push gate.

The admin CSS/JS bundles in `plugin/gateway/web/{app.css,dist/app.js}` are **committed build artifacts** served at startup — re-run `bun run build:admin` and commit them after changing `web/app/` or `web/input.css`.

## Architecture

Everything runs as one `docker compose` on one VPS (single-tenant, I6). Only Caddy (HTTPS edge) faces the internet; Postgres and ClickHouse are never exposed (I1).

**`plugin/gateway/` — the MCP server.**
- `app.ts` — `buildServer()` registers the tool surface. Context tools (`find_context`, `list_entities`, `describe_entity`, `get_metric`), the propose path (`report_correction`, `list_corrections`), curated-write tools (`upsert_context`, `resolve_correction` — registered only when `canWrite`), and data tools (`list_sources`, `get_schema`, `run_query`). `find_context` is documented as "always call FIRST."
- `http.ts` — the deployed entry point. Streamable-HTTP MCP transport with bearer-token auth; **a fresh stateless `McpServer` per request**, identity bound from the token. Also serves the `/admin` React SPA + its session-cookie JSON API (`/admin/api/*`), the `/healthz` aggregate, and the `/i/<token>` one-line installer. Shared state lives in the SQLite store, not the server instance.
- `lib/store.ts` — `KnowledgeStore`, the owned SQLite DB (docs, corrections, append-only revisions + audit log, accounts/sessions). Lives **outside the repo** by default (`~/.setoku/projects/<slug>/knowledge.db`); `.setoku/context/` files seed it once.
- `lib/config.ts` — loads `.setoku/config.json` from the *business* repo, resolves DB/lake URLs from env-var **names** (the credential never reaches the model), enforces the table allow/deny list.
- `lib/db.ts` / `lib/lake.ts` — read-only Postgres and ClickHouse query execution.
- `admin-cli.ts` — bootstraps the first admin account on the box (no authenticated channel exists yet).

**Two identities, one membrane (I2/I9) — the load-bearing security design.**
A token maps to either an **analyst** (`canWrite:false`, may read the lake) or a **curator** (`canWrite:true`, `denyLakeRead:true`). They never coexist on one session:
- Analyst sessions read untrusted bulk text (logs/Slack) but hold **no** tool that commits curated knowledge — they can only `report_correction` (lands as *pending*).
- Curator sessions can commit knowledge (`upsert_context`/`resolve_correction`) but **cannot** read the lake — so a prompt-injectable session can never weaponize the write tool.
- Accepting pending knowledge into curated context is a **human click on the `/admin` approval surface**, outside the agent loop. No MCP tool creates users, grants access, or commits knowledge.

**`provisioner/`** — patterns for wiring sources on demand (`sources/{vercel,render,slack}.ts`, schema inference). A handful of proven patterns, not one connector per vendor (see CONTRIBUTING — new connectors are a maintenance tax).

**`ingest/`** — containers that fill the lake: `slack-listener`, `mercury-poller`, `render-poller`, plus the lake's SQL schemas in `ingest/schemas/`. Liveness is tracked via `ingest_heartbeats` (a "flowing" source reads from a real beat, not data recency).

**`plugin/skills/`** — the user-facing workflows (`SKILL.md` each): `onboard`, `connect`, `generate` (read the business code → propose/commit context), `curate` (review pending), `eval` (golden-question scorecard).

**`deploy/`** — `bootstrap.sh` (one-command VPS setup), Caddy config, ClickHouse/Vector lake, readonly-role SQL. **Deploys are rsync-based** (`scripts/deploy.sh`), not git pull, for the canonical box (`/opt/setoku`); the box target is read from a gitignored `deploy/target.local`.

## Invariants (I1–I9)

`docs/invariants.md` defines nine load-bearing constraints referenced as `I1`…`I9` throughout the code. **Read it before touching auth, ingestion, or the corrections queue.** Highlights: databases never public (I1), the membrane (I2/I9), no pilot-tenant data in the repo (I3 — CI greps a denylist), the lake is durable user data needing backups (I4), dialect-routed metric SQL (I5), no server-side inference (I8), authority changes pass through a human (I9). Access is enforced by the **database engines** (per-role GRANTs), never by parsing SQL in our code.

## Conventions

- **DCO sign-off required** on every commit: `git commit -s`. CI rejects unsigned commits.
- Source files carry `// SPDX-License-Identifier: Apache-2.0`.
- **No real tenant data anywhere** (I3): no real metric definitions, channel names, or log samples in the repo or tests.
- Vendor facts (Slack rate limits, Vercel/Render plan gating, prices) churn — re-verify against official docs before encoding them (I7).
- Architectural changes need a written reason (open an issue); the README's architecture section records decisions. `SPEC.md` is the design/roadmap.
- **Gateway chrome is neutral (stone), never branded.** The admin SPA and gateway-served surfaces (the `/admin` app, the public app shell) use a monochrome **stone** palette and introduce **no accent color of their own**. Color belongs to the user's content — their apps, dashboards, and charts. Defer to how the user's apps look: chrome (buttons, badges, links, toasts) stays stone-family so it never competes with or clashes against whatever a published app renders. When you reach for a teal/blue/etc. accent on a gateway element, that's the smell — make it stone.
- **Use angled/curly apostrophes (’) in all `site/` copy**, not straight ones (`'`).
