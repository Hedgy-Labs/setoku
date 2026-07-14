# Setoku — Spec (v0.6)

> Status: **draft / starting point for iteration.** Names, scope, and decisions here are provisional and meant to be argued with.

## One-liner

Setoku turns a company's **codebase into a governed, queryable business-context layer** that a Claude agent uses — running on the user's own Claude subscription — to answer data questions accurately and safely across heterogeneous data sources.

## Why

Two observations from prototyping:

1. **A company's codebase is the richest, most accurate source of business semantics that exists** — it's what the business actually does, not a hand-drawn model of it. An agent with the code understands the business far better than one without.
2. But raw code as live context is **expensive** (token-heavy, re-read every session), **ephemeral** (each user re-derives it), and **lossy** (the agent's on-the-fly inferences from code are sometimes wrong).

Setoku fixes the _when_ and _how_: do the expensive codebase comprehension **once, offline**, into a **curated, human-verified, versioned context artifact**, then serve only the relevant slices to the agent on demand — token-efficiently, shared across all users, and improvable over time.

## Core insight

A **code-derived, human-verified semantic layer** is:

- more accurate than a hand-built model (code is the source of truth), and
- far cheaper than raw-code-in-context (curated + retrieved, not re-derived).

The agent supplies intelligence; Setoku supplies **governed data access** + **verified business context**.

## Principles / hard constraints

1. **Subscription-native runtime (non-negotiable for v0).** All reasoning happens inside the user's **interactive** Claude Code / Cowork session, billed to their seat. Setoku never makes the LLM call itself, so it stays out of the metered/programmatic path (post the June 15 2026 change) and out of the LLM-billing path entirely. → _We do not ship a UI that drives Claude._ Our product is tools + context + instructions that a human-driven Claude consumes.
2. **Governed access is the long-term differentiator — architecture supports it from day 1, enforcement comes later.** The agent gets tools, never raw credentials; every call flows through the gateway and is audited. v0 ships read-only + caps + audit + table-level allow-listing; richer policy (roles, RLS, masking) layers on without changing the tool contracts.
3. **Context is built from code, then verified by users.** Generation is grounded in `file:line`; corrections live in the artifact and are shared with everyone, forever.
4. **Users own the context; the system earns it conversationally.** Curation is not an FDE service. The agent iteratively asks users clarifying questions during real use, remembers the answers, and builds a conceptual understanding of the business over time.
5. **Token efficiency via retrieval + progressive disclosure**, not wall-of-text context.
6. **Provider- and source-flexible.** Claude on the seat for v0; the same gateway must be swappable to an API/DeepSeek harness later (Mode B). Postgres first; the data layer must generalize to other sources.
7. **Runs in the customer's environment.** Data and code never transit our servers.
8. **Product, not services-with-tooling.** Every workflow (generation, curation, freshness, eval) must be self-serve and agent-driven; FDE involvement per deployment should trend to zero.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  RUNTIME (customer seats)                                      │
│  Human ⇄ Claude Code / Cowork   ← interactive, billed to seat  │
│            │ loads skill, calls MCP tools                      │
└────────────┼───────────────────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────────────────┐
│  SETOKU MCP SERVER  (runs in customer infra — the choke point) │
│                                                                │
│  Context tools          │  Data tools (access-control gateway) │
│  • list_entities        │  • get_schema   (permission-scoped)  │
│  • find_context(q)      │  • run_query    (read-only, capped,  │
│  • describe_entity      │                  masked, audited)    │
│  • get_metric           │                                      │
│  • report_correction    │  per-tenant creds held server-side   │
│                          │  RLS / column masking / allow-list  │
│                          │  audit log of every call             │
└───────────┬───────────────────────────────┬────────────────────┘
            ▼                                 ▼
   Context Artifact (versioned)      Customer data source(s)
   schema facts · semantics ·        Postgres (v0) → Snowflake,
   metrics · canonical queries ·     BigQuery, … (later, or via
   gotchas — grounded in file:line   a federation/semantic layer
                                      like Cube behind the gateway)
            ▲
            │ generated + kept fresh continuously (see Freshness)
   ┌────────┴─────────┐
   │  GENERATOR        │  Claude Code reads the repo (ORM schema +
   │  (initial build + │  business logic) → emits structured context →
   │   ambient refresh)│  user reviews/corrects → committed to repo.
   └───────────────────┘  Freshness: Claudes already running on dev
                          machines detect stale context vs. current
                          code and propose updates as a side effect
                          of normal dev work (skill/hook).
```

### Components

| Component            | What it is                                                                                                                                                                                | Ships as                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Context Artifact** | Versioned, structured, human-verified business context derived from code                                                                                                                  | YAML/MD files in a per-customer repo   |
| **Generator**        | Claude Code pass that reads the codebase and emits the artifact, grounded in `file:line` — initial build, then **ambient refresh** from dev-machine Claudes when context drifts from code | Skill + hook in the customer repo      |
| **MCP Server**       | The gateway: governed **data tools** + **context tools** in one server                                                                                                                    | HTTP MCP server in customer infra      |
| **Skill**            | `SKILL.md` teaching Claude the analyst workflow — _retrieve context before inferring; use only gateway tools_                                                                             | Claude Code/Cowork skill (in a plugin) |
| **Runtime**          | Claude Code / Cowork on the user's seat                                                                                                                                                   | (not ours)                             |

Distribution: package **skill + MCP config** as a **Claude Code plugin**; enterprises push it to seats via managed settings / managed MCP. (Full flow: see _Installation & onboarding_.)

## Installation & onboarding

**Delivery constraint:** MCP servers cannot install skills — the MCP protocol exposes tools/resources/prompts at runtime; skills are client-side files. The **Claude Code plugin** is the delivery vehicle: one package bundling `skills/` (bi-analyst, eval, onboarding), `.mcp.json` (gateway connection), and the optional ambient-freshness hook for dev repos.

**Fallback layer (bare-MCP clients):** tool descriptions and tool _results_ carry workflow guidance ("call `find_context` before writing SQL"), and the server exposes MCP prompts (e.g. an onboard prompt). A client without the plugin gets a degraded-but-sane experience; the plugin gets the full one.

### Company setup (once, technical owner — target: an afternoon, no FDE)

1. **Deploy the gateway** — single container in their infra: DB connection string + tokens file in, health check out.
2. **Generate the artifact** — in their repo, in Claude Code (their seat): install plugin, run `/setoku:generate`; review the emitted context diff; commit. _Generation is self-onboarding._
3. **Issue tokens** — `setoku token create <user>` (v0; OIDC later).
4. _(Enterprise)_ **Push to seats** — admins force-install plugin + MCP server via managed settings / managed MCP; analysts do nothing.

### End user (minutes)

```bash
claude plugin marketplace add <org>/setoku
claude plugin install setoku
```

Then `/setoku:onboard` (the **onboarding skill**) runs conversationally:

1. Prompts for their token (stored locally; sent as the HTTP auth header).
2. Calls `get_schema` to verify the connection and show what they can access.
3. Runs one golden question end-to-end so they see the loop work.
4. **Starts the curation interview** — asks who they are and what questions they care about, seeding their first context clarifications. Onboarding _is_ the first turn of the conversational-curation loop (D6), not a separate wizard.

Experience: install plugin → paste token → answer two questions → ask a real business question. Everything heavier lives with the company admin.

**Cowork (non-technical analysts):** verified 2026-06 — Cowork supports **plugins** (since 2026-01-30) bundling skills + MCP connectors + slash commands, with a marketplace and enterprise private marketplaces. So the same distribution model holds on both surfaces. Remaining verification (open question #7): packaging parity (one artifact for both, or two packagings), per-user token entry UX for an HTTP MCP connector in Cowork, and hooks (Cowork likely lacks them — fine, the freshness hook targets dev machines, which are Claude Code anyway).

### Team topology (where data lives — revised v0.6)

> v0.5 made git the system of record for knowledge with PR review as the gate. **Falsified by pilot profiles** (a 100-person Shopify company has no relevant codebase; a 2-dev/10-person company makes devs a bottleneck for business knowledge, contradicting D6). Revision: **the gateway owns the knowledge**; code is one source among several; review is non-blocking.

Three kinds of data, three homes:

| Data                                                           | Home                              | Notes                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Business data (rows)                                           | Customer's data sources only      | Gateway never stores/caches results; audit logs record SQL, not rows                                                                         |
| **Knowledge (context artifact)**                               | **The gateway's versioned store** | Every change attributed + revertible (the properties git gave us, kept without git). v0 local profile: the `.setoku/` files _are_ that store |
| Operational state (tokens, central audit, pending corrections) | Deployed gateway (v1)             |                                                                                                                                              |

**Knowledge sources (importers into the store, by company shape):**

1. **Codebase** — where one exists, `/setoku:generate` mines it, grounded in `file:line`. An importer, not the home.
2. **Canonical SaaS packs** — Shopify/HubSpot/GA4 etc. have standardized schemas identical across customers: ship pre-built context packs (entities, metrics, gotchas), so Setoku arrives already knowing the platform. Per-company knowledge layers on top. (Key unlock for low-code companies.)
3. **The curation interview + usage corrections** — everything tribal, captured conversationally.

**Non-blocking review — trust tiers, not gates.** `report_correction` knowledge goes live **immediately as "unverified team knowledge"** (attributed, labeled as such by `find_context`). A **curator — a business user, not a dev** — reviews asynchronously via `/setoku:curate` (conversational), promoting to verified, editing, or rejecting. Nobody waits; review upgrades confidence rather than gating existence.

**Profiles:** Local (v0, now): stdio gateway, `.setoku/` files in a folder (a repo if the team has one — then git sharing works as a bonus; config references DB credential by env var name). Deployed (v1): one HTTP gateway container per company; knowledge store on its volume; repo-less users connect with URL + token; code-derived and pack updates are _pushed into_ the store by `/setoku:generate` / the FDE.

**Division of labor:** FDE (us) does one-time deployment + source sync; **the customer's business users own the knowledge day-to-day** (curator role); devs only matter when code-derived context refreshes.

**Pilot mapping:** 100-person e-commerce (Shopify/HubSpot/GA, no real dev team) → deployed gateway + SaaS packs + DuckDB-lake sync (pulls D5 forward), ops lead curates. 10-person all-technical → local profile as-is. 10-person/2-devs → local or deployed; the 8 non-devs curate.

### The context model (layers, cheap → rich)

1. **Schema facts** — tables, columns, types, FKs, enums. Deterministic (introspection + ORM schema). _Never inferred._
2. **Semantic annotations** — what entities/columns mean, join semantics, status/lifecycle meanings, soft-delete & filtering conventions.
3. **Metric definitions** — canonical logic for business terms ("active company", "paid trial"), each with exact SQL.
4. **Canonical queries** — known-good SQL for common questions (few-shot, retrieved by relevance).
5. **Gotchas** — non-obvious traps that cause wrong answers (e.g. "`Company.platform` null → filtered out"; "`billingModel=PLACEMENT_FEE` counts as paying"). The highest-value, lowest-token layer.

### Token efficiency

- Comprehension cost is paid **once** (generation), not per session.
- The agent retrieves **only relevant slices** per question via `find_context` (keyword/BM25 first; embeddings only if recall lags — run locally for privacy).
- Stable index (`list_entities`) is prompt-cache friendly.
- The **skill** instructs: _"Before writing SQL, call `find_context`; trust its semantics/gotchas over your own inference from column names."_ This is what converts guessing into verified retrieval.

### Access control / identity

**Decided (v0):** per-user bearer token over the MCP HTTP transport — issued by the gateway, swappable for SSO/OIDC later. Enforcement is deliberately thin in v0; the contract is what matters.

- v0 enforces: **read-only, row/time caps, table-level allow-listing, audit record per call** keyed to the token's identity.
- Later (no contract change): roles, row-level security, column masking, policy mapped from the customer's existing permissions model.
- **Per-user data-source access (shipped):** admins can limit which lake source families (Slack, GitHub, Mercury, logs, …) a person's agent can query, via the "Data access…" dialog on the Team page. Default: everyone sees everything, including future connectors. Enforcement is by the ClickHouse engine (one role per source family, activated per request); denied families vanish from `list_sources`/`get_schema` and their queries are refused by the engine. The `biz.*` mirror and the knowledge store are not per-user restricted.
- Credentials for the underlying data source are held **server-side only**; the model never sees them.

### Curation & clarification loop (users own the context)

Curation is **user-owned and conversational** — not an FDE workflow, not a YAML-editing chore:

- **Ask:** when the agent hits ambiguity during real use ("does _active company_ include success-fee accounts?"), the skill tells it to **ask the user a clarifying question** instead of guessing.
- **Remember:** the answer is captured via `report_correction` / `propose_context` as a candidate artifact change (new gotcha, metric definition, annotation edit), attributed to the user who said it.
- **Review:** candidates land as artifact diffs (PR-style) for a human owner to accept — the agent never self-edits ground truth.
- **Compound:** every accepted answer makes every future query, for every user, correct. The system _interviews its way_ to a conceptual understanding of the business.

### Freshness (ambient regeneration)

The context must track the **live code**. Mechanism: the Claudes **already running on dev machines** (subscription-native, like everything else):

- A repo skill/hook in the codebase lets a dev's Claude Code session detect that the artifact is stale relative to code it just touched (schema migration, changed eligibility logic) and **propose the context update as a side effect of normal dev work**.
- Backstop: a manual `setoku generate --diff` pass (also run interactively in Claude Code) for periodic full refreshes.
- All updates flow through the same review gate as curation.

## Billing & licensing model

| Mode                | Surface                              | LLM call made by         | Billing                                                                   | v0?        |
| ------------------- | ------------------------------------ | ------------------------ | ------------------------------------------------------------------------- | ---------- |
| **A — interactive** | Claude Code / Cowork on a seat       | the human-driven session | seat subscription (free at margin)                                        | ✅ primary |
| **B — own harness** | Slack bot, scheduled reports, our UI | our code                 | API key (Claude / DeepSeek / customer BYO) or metered subscription credit | later      |

The **MCP gateway is identical in both modes** — only the harness on top changes. Build the gateway first; it's the durable IP.

> ⚠️ Confirm commercial/distribution terms with Anthropic for shipping a product consumed inside customers' Claude Code/Cowork seats. Billing mechanics are clear; resale/embedding terms are a contract question.

## Generalization (this is a prototype meant for several businesses)

What's **shared code** vs **per-tenant config/artifact**:

- **Shared:** MCP server, tool contracts, generator framework, skill template, retrieval engine.
- **Per-tenant:** the context artifact, data-source connection + credentials, access-control policy (roles/RLS/masking), and any stack-specific generator adapter.

v0 generator targets **Postgres + an ORM/schema source** (Prisma first, via `hedgy`); the artifact format is stack-agnostic so other stacks (other ORMs, dbt models, raw SQL) plug in as additional generator adapters.

## Prototype scope (v0)

**Goal:** prove the loop end-to-end on real data, on a subscription, across ≥2 codebases.

In:

- Read-only query gateway: `get_schema`, `run_query` against the box's ClickHouse engine — the `biz.*` mirror of the business Postgres (filled by `ingest/pg-mirror`, which holds the read-only pg credential; the gateway holds none) plus the ingested lake (read-only, row cap, statement timeout, audit log).
- Per-user bearer token → identity for audit + table-level allow-list. (No RLS/masking in v0 — contract supports adding them.)
- Generator pass over a repo (Prisma schema + key business logic + existing gotchas) → context artifact, grounded in `file:line`, user-reviewed.
- Context tools: `list_entities`, `find_context`, `describe_entity`, `get_metric`, `report_correction`.
- `bi-analyst` skill (retrieve-before-infer, ask-don't-guess) + plugin packaging.
- Run against **hedgy** as test case #1; then a second, different business/codebase.
- An **eval skill**: golden questions + expected answers per business, stored in the artifact repo; the subscription agent runs the eval inline (Mode A — no programmatic harness needed) and reports a scorecard.

Out (for now): Mode B harnesses (Slack/UI), multi-source federation / Cube, RLS/column masking enforcement, write actions, embeddings (unless retrieval recall forces it), Cowork-specific polish.

## Tech choices (v0)

- **Skip Wren.** It bundled a text-to-SQL pipeline (replaced by Claude) and a UI (unused); it does **not** provide per-tenant access control (our core value). Build the thin gateway instead.
- **Data sources:** Postgres first (now mirror-fed: `pg-mirror` copies it into the ClickHouse lake as `biz.*`, and the gateway queries only the mirror) → **BigQuery next** (Google Analytics exports). Open lean: rather than federating connectors, **form a small datalake in DuckDB** — ingest/sync sources into DuckDB and point the gateway at one engine (one dialect for the agent, cheap local analytics, BigQuery/Postgres both readable via DuckDB extensions). Decide when BigQuery lands.
- **Graduation path:** thin gateway (+ DuckDB lake) → (if shared semantic layer at scale) **Cube** behind the same gateway → never Wren.
- MCP server: HTTP transport, language TBD (likely TS or Python).
- Retrieval: keyword/BM25 to start.


## Onboarding surfaces (verified 2026-06-10 against a real Max account)

How a user connects to a *deployed* gateway, by surface — learned empirically (the enterprise `3p/extensions` docs misled us twice; these are the real consumer behaviors):

| Surface | Path | Auth | Notes |
| --- | --- | --- | --- |
| **Claude Code** | `claude mcp add --transport http setoku <url>/mcp --header "Authorization: Bearer <tok>"` (the `/i/<token>` installer does this) | header | works; user-scope config in ~/.claude.json |
| **Cowork / Claude desktop (Max/Pro)** | Settings → Connectors → **Add custom connector (BETA)** → paste `<url>/mcp/<token>` as the URL, OAuth blank | **token in URL path** | ✅ the real path for non-technical teammates; no terminal, no marketplace |
| Enterprise/MDM | `org-plugins/` or `managedMcpServers` | header | **personal plans IGNORE `org-plugins/`** (verified via app logs) — enterprise/Team only |

- The custom-connector dialog offers only URL + optional OAuth (no static-header field) → gateway accepts `/mcp/<token>` so the credential rides in the URL. Token-in-URL is credential-grade (share via password manager).
- **Tool annotations** (`readOnlyHint` on read tools) are required so clients auto-approve reads instead of prompting every call.
- **Connector *directory* listing** (curated, Connect-button discovery) needs **OAuth user-consent** (static bearer / client-credentials rejected) + privacy policy + annotations + Streamable-HTTP. → roadmap item; OAuth is the unlock. Not needed for pilots (custom-connector URL covers Max users).

## Decisions

| #   | Question             | Decision                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Identity/auth        | Per-user bearer token issued by the gateway; SSO/OIDC later.                                                                                                                                                                                                                                                                  |
| D2  | Access control depth | Defer enforcement; v0 = read-only + caps + audit + **table-level** allow-list. Architecture (tool contracts, token→identity) must support roles/RLS/masking without rework.                                                                                                                                                   |
| D3  | Context freshness    | **Ambient regeneration**: dev-machine Claude Code sessions detect stale context vs. code and propose updates as a side effect of dev work (repo skill/hook); manual full pass as backstop.                                                                                                                                    |
| D4  | Eval                 | Needed before tuning. Run **inline by the subscription agent via an eval skill** (golden questions in the artifact repo) — no programmatic harness.                                                                                                                                                                           |
| D5  | Data sources         | Three engine roles (v0.6): **(a) direct Postgres adapter** when the customer's data already lives in Postgres (software-co pilots — today's gateway, no lake); **(b) DuckDB as the lake** for SaaS-stack customers — zero-ops file on the gateway volume, synced from Shopify/HubSpot/GA4 via **dlt** (first-class DuckDB destination + verified sources for all three), OLAP-fast, and `postgres_scanner` can attach any Postgres so the agent sees one dialect; **(c) the knowledge store is never the analytics DB** — SQLite owned by the gateway (shipped in v0; `~/.setoku/projects/<slug>/knowledge.db`, override via config.knowledgeDb / SETOKU_DB_PATH); `.setoku/context/` markdown is a seed/interchange format imported on first boot.                                                                                                                                                                                                   |
| D6  | Curation ownership   | **Business users own it** (curator role — not devs, not FDE). Conversational: agent asks clarifying questions during use, remembers answers as candidates, curator promotes via `/setoku:curate`.                                                                                                                             |
| D7  | Business model       | **Product, not services-with-tooling.** All workflows self-serve / agent-driven. FDE does one-time deployment only.                                                                                                                                                                                                           |
| D8  | Semantic layer       | Skip Wren; thin gateway; Cube only if scale demands.                                                                                                                                                                                                                                                                          |
| D9  | Knowledge store      | **The gateway owns the knowledge** (versioned, attributed, revertible store; `.setoku/` files in v0). Git demoted from system-of-record to one importer among several: codebase generation, **canonical SaaS packs** (Shopify/HubSpot/GA4), curation interview. (Revised v0.6 — git-PR topology falsified by pilot profiles.) |
| D10 | Review model         | **Non-blocking trust tiers.** Corrections go live immediately as _unverified team knowledge_ (labeled + attributed in `find_context`); curator promotes/rejects asynchronously. Review upgrades confidence, never gates existence.                                                                                            |

## Open questions (to answer as we iterate)

1. **Source-of-truth on drift:** ORM schema vs actual DB vs views vs dbt — which wins when they disagree, and how do we detect it? (Undecided; v0 will surface this empirically via `get_schema`-vs-artifact mismatch warnings.)
2. **DuckDB lake mechanics:** if we adopt it — what does ingestion/sync from Postgres/BigQuery look like (frequency, ownership, where it runs), and is querying-in-place via DuckDB extensions enough for v0 instead of true ingestion?
3. **Ambient-freshness mechanics:** what exactly triggers the dev-machine update proposal (hook on migration files? skill instruction? `git diff` scan on session start), and how noisy is acceptable?
4. **Clarification UX:** when should the agent interrupt the user with a question vs. answer-with-stated-assumption? How do we avoid interrogation fatigue while still compounding context?
5. **Eval rubric:** what counts as "correct" (exact rows? semantically-equivalent SQL? judge-graded answer)? Per-business golden sets — who writes the first 20 questions?
6. **PII/compliance:** masking policy (post-v0), audit retention, data-handling expectations per customer.
7. **Cowork parity details** _(mostly retired — Cowork supports plugins bundling skills + MCP since 2026-01-30)_: one plugin artifact for both surfaces or two packagings? Per-user token entry UX for an HTTP MCP connector in Cowork? Hooks absent there (acceptable — freshness hook targets dev machines).
8. **Mode B provider strategy** (when it comes): customer BYO-key vs our key; Claude vs DeepSeek by tier.
9. **Anthropic commercial terms** for distributing a product consumed inside customer seats (contract question — ask their partnerships team).

## Out of scope (v0)

Custom UI that drives Claude · Slack/automation harnesses · multi-source federation · write-back / actions · multi-tenant SaaS hosting (gateway runs per-customer).

## Glossary

- **Setoku** — **set** (math) × **oku** (奥 innermost / 億 vast number) — "the innermost set": the deep intelligence layer that makes the AI understand the business. Coined. Domain: setoku.com.
- **Context artifact** — the versioned, human-verified business context derived from code. (The "setoku" itself — the innermost set the agent consults.)
- **Gateway** — the MCP server mediating governed data access.
- **Mode A / B** — interactive (subscription) vs harness (API) runtime.
- **Gotcha** — an encoded non-obvious business rule that prevents wrong inferences.

## Iteration log

- v0.1 — initial spec from prototyping conversation; `hedgy` as first test case.
- v0.2 — folded in first decision round (D1–D8): token auth, defer access-control enforcement (table-level v1), ambient context freshness via dev-machine Claudes, inline eval-via-skill, Postgres→BigQuery with DuckDB-lake lean, user-owned conversational curation, product-not-services.
- v0.3 — added _Installation & onboarding_: plugin as delivery vehicle (MCP can't install skills), bare-MCP fallback layer, company-setup vs end-user flows, onboarding-as-curation-interview. Cowork risk mostly retired: verified Cowork supports plugins (skills + MCP connectors + marketplace, incl. enterprise private marketplaces) since 2026-01-30; open question #7 narrowed to packaging parity / token-entry UX / hooks.
- v0.4 — renamed **Strata → Loremir** (~150 names checked at that point). Rationale then: names the value, Palantir-register without trademark risk.
- v0.5 — renamed **Loremir → Setoku** (set × oku 奥 "innermost"; ~420 names checked total; finalists in NAMES.md; setoku.com available 2026-06-09 — register it). v0 prototype build begins: monorepo = Claude Code plugin (marketplace + skills + stdio MCP gateway in plain Node ESM). Pragmatic deviation from D1: v0 gateway runs as a **local stdio MCP server** launched by the plugin (zero deploy, works in any repo); the HTTP + bearer-token deployment is the v1 hardening step — tool contracts identical.
- v0.6 — **topology revision from pilot profiles** (100p Shopify co with no dev team; 10p co with 2 devs): git-PR knowledge flow falsified — devs can't be the gate for business knowledge and low-code companies have no repo. New: D9 (gateway owns the knowledge; code + **canonical SaaS packs** + interviews are importers), D10 (**non-blocking trust tiers** — corrections live immediately as labeled *unverified team knowledge*; business-user curator promotes via `/setoku:curate`), D5 finalized (direct Postgres adapter OR DuckDB lake synced via dlt for SaaS stacks; knowledge store never the analytics DB). v0 code: find_context now surfaces unverified corrections; new curate skill.
- v0.7 — knowledge moved **into the service**: gateway-owned SQLite store (docs + corrections lifecycle + revisions + audit), write-through tools `upsert_context`/`list_corrections`/`resolve_correction`; generate/curate skills write via tools, not files; markdown demoted to seed/interchange. 21-test e2e incl. restart-persistence. Next: pressure-test retrieval→answer quality on hedgy.
- v0.8 — **deployed profile shipped**: gateway refactored into shared `app.ts` tool surface + two entries (stdio `server.ts`, HTTP `http.ts` with Streamable-HTTP transport, bearer-token→identity auth, stateless per-request servers over the shared SQLite store). Deploy artifacts: `deploy/` (Dockerfile + project template + read-only role SQL + Fly/Cowork connector instructions). Verified: 5-test HTTP e2e (auth, per-token audit attribution, cross-user shared knowledge) + real container build/run smoke (seed import, 401, retrieval + read-only SQL through Docker). Cowork verified to support both local stdio MCP (developer setting) and admin-managed remote connectors + same plugin model.
- v0.9 — onboarding reality mapped across Claude Code / Cowork(Max) / enterprise; gateway accepts token-in-URL-path for the Cowork custom-connector dialog; tool annotations added (readOnly/non-destructive); one-line `/i/<token>` installer; connector-directory submission documented (needs OAuth → roadmap). Live pilot: hedgy prod, Peter + cofounder, both surfaces verified.
- v0.10 — **one gateway, one store.** Removed the local stdio profile entirely (`server.ts` + plugin `.mcp.json` deleted; the plugin is now skills-only). The curator write-path moved onto the box: a separate **curator token** class (`SETOKU_CURATOR_TOKENS`) carries `canWrite` but is blocked from reading the lake (`denyLakeRead`), so the commit-knowledge and read-untrusted-bulk-text capabilities never coexist on one session (I2/I9). `/setoku:generate` + `/setoku:curate` use a `setoku-curator` connector; analyst tokens stay propose-only. e2e + lake test suites migrated to the HTTP harness. (docs/curator-write-path.md.)
- v0.11 — **live apps supersede static Reports** (then called "dashboards"; renamed at v0.20). A report was frozen HTML (data photographed at publish time); an app splits **presentation** (frozen, agent-authored template) from **data** (named **panels**, each a saved `sql`+`dialect` the box re-runs through the governed `run_query` path, TTL-cached, every run audited). Rendered as **trusted outer shell + sandboxed inner frame**: data is *injected* not fetched, so the frame runs under `default-src 'none'` (no network) — closing the exfil-via-author-JS hole static reports had. Tools `publish_report`/`list_published`/`unpublish_report` → `publish_app` (dry-runs + cache-seeds panels at publish), `list_apps`, `unpublish_app`, `get_app`. **Inspection** ("how is this calculated"): a provenance drawer in the shell shows SQL (team-only) / metric definition + as-of; public `/p/<id>/data` omits raw SQL. Public promotion stays a human web-console click (membrane intact — an app is a publish artifact, never a curated-knowledge write). Storage extends `published` in place (`panels`, `refresh_seconds`) + an `app_cache` table; legacy `format='html'` reports keep rendering. (docs/apps.md.)
- v0.20 — **Dashboards → Apps; apps gain private state.** Renamed the publish surface Dashboards → **Apps** (tools `publish_dashboard`→`publish_app`, `get_dashboard`→`get_app`, `list_dashboards`→`list_apps`, `update_dashboard`→`update_app`, `unpublish_dashboard`→`unpublish_app`; UI nav/routes, `app_cache`/`app_data`, `lib/app-runtime.ts`). "Dashboard" survives only as the informal name for the read-only kind. New: each app gets a **private per-app datastore** (`lib/app-store.ts`, a separate `app_state` table). An app **reads** governed company data but can never **write** a business source (the read-only GRANT stays absolute, I1); it instead persists its own state via `window.Setoku.state.get/set/list/del(scope, key)` with two scopes — `app` (shared) and `viewer` (private: the signed-in identity on the team surface, an anonymous per-browser id on public links). State crosses no membrane (it's neither the lake nor curated knowledge), so it needs **no per-write human gate** — the only gate stays publishing the app. Reached from the no-network frame via a `postMessage` bridge the **trusted shell mediates** (it injects the app id, so a template can only touch its own state), calling session-gated `/admin/api/app_state` (team) or credential-free `/p/<id>/state` (public-visibility apps only). Unlocks the **overlay** pattern — annotate prod rows (a "reviewed" flag, a note) keyed by row id, without writing prod. Frame sandbox now `allow-scripts allow-forms` (safe: the frame CSP pins `form-action 'none'`). Also: in-place app rename from the app detail page (author/admin), and a full-screen app view. **Viewer params SHIPPED** (`lib/params.ts`): an app declares typed inputs (date/int/text/bool/enum); a panel binds one as `:name`; `renderApp` resolves the viewer's value (or default) and compiles+binds it — `$n` (Postgres) / `{name:Type}` (ClickHouse), passed as a bound value, never string-interpolated, so injection-safe and unable to name a table or drive a write. A **control bar** renders the declared params as stone widgets on **both** surfaces — the server-rendered public shell and the React `AppView` — and re-requests the frame with `?p.<name>=…` on change; publish dry-runs panels with the defaults bound (rejecting an undeclared `:token` or an uncoercible default). **Panel-less apps render natively**: an app uses the runtime path on `format='app'` with or without panels (a state-only todo/poll has none), so the old dummy-panel workaround is gone — `publish_app` marks a zero-panel fragment as `app`, only a zero-panel full HTML doc stays legacy `html`; the list badges a panel-less app "interactive". **Upgrade-safe**: a one-time `UPDATE published SET format='app' WHERE format='dashboard'` backfills pre-rename rows so dashboards keep rendering, and the per-panel cache keys each param variant separately but is **capped per app** (newest ~256, oldest evicted) so an open-domain param on a public link can't grow it unbounded. (docs/apps.md.)
- v0.21 — **The business DB is mirrored into the lake; the mirror is the read path (issue #47).** From the Fan LTV slowness investigation: stop trying to make prod Postgres fast for analytics. New `ingest/pg-mirror` container full-reloads every allowlisted table into ClickHouse `biz.*` on a poller loop (DDL derived from the pg catalog through an explicit type map that fails loudly; staging table + atomic `EXCHANGE` swap; `ORDER BY` = the pg PK — the whole tuning story; prune on allowlist exit so revocation removes the lake copy; per-table freshness in `setoku.pg_mirror_runs` + `pg-mirror` heartbeats). Alternatives rejected in the issue: index advisor (can't apply), per-app snapshots (unnecessary once panels run on CH), shadow-pg logical replication (WAL-pileup liability aimed at prod), shadow-pg dump/restore (once freshness is cron-shaped, CH wins). **Policy is hard, not advisory** (`mirrorPolicy`, default `require`): `run_query` postgres statements and app panels touching mirrored tables are REJECTED with the `biz.*` rewrite; `force_postgres:true` (audited) reads the live source for mirror verification / row-level freshness; `"prefer"` softens to a nudge. Docs carry `meta.dialect` (I5, machine-read) and knowledge-lint routes each doc's SQL to its engine. Mirrored tables are re-derivable → `biz` is its own database, excluded from clickhouse-backup and the Parquet export (I4); `setoku_ro` gains `SELECT ON biz.*` only (analysts could already read these tables via pg — no new authority). Surfaces: `list_sources` BUSINESS-DB MIRROR section with per-table "data as of" (postgres presented as the mirror's *source*), `/healthz mirror{asOf,tables}`, app chrome shows "source data as of" beside the cache stamp; connect/onboard wire the mirror at DB-connect time (no pre-mirror era); site/README reframe Postgres as one more lake connector. Acceptance (demo box, bulldogs 15.8M rows / 18 tables): prospect-scoring + Fan LTV + sponsorship + attendance + revenue apps (21 panels) migrated with row-identical verification — 8–12s/panel on pg → 1–3s on the mirror, param toggles live; all 9 metric/query docs re-dialected. Deferred: incremental cursors for append-only tables (only if size demands), stale-while-revalidate in renderApp, per-panel run-duration telemetry.
- v0.22 — **The direct business-Postgres read path is retired; data access goes per-user.** The gateway container holds no pg client and no `SETOKU_DATABASE_URL`: business tables are read only via the `biz.*` ClickHouse mirror (`ingest/pg-mirror` keeps the read-only pg role/credential — `deploy/readonly-role.sql` and `connect-postgres.sh` now serve the mirror, not the gateway). `run_query` defaults to `clickhouse` and it is the only runnable dialect; `postgres` is rejected with the `biz.*` rewrite, and `force_postgres` / `mirrorPolicy` are gone. `get_schema` describes ClickHouse metadata (biz.* + setoku.* tables, column types, ORDER BY key) instead of live pg introspection, and the gateway table allow-list is gone (scope = what pg-mirror mirrors). App panels default to `clickhouse`; publishing/updating a postgres panel is rejected, legacy stored ones surface a "retired" error at render until re-authored, and legacy postgres-dialect metric/query docs are flagged by knowledge-lint for migration to biz.* (never executed). Same release: **per-user data-source access control** — admins limit which lake source families (Slack, GitHub, Mercury, Monarch, Vercel/Render logs, first-party events, unrouted raw) a person's agent can query via the Team page's "Data access…" dialog; default is everyone-sees-everything, future connectors included. Enforced by the ClickHouse engine, not our code: one role per source family, activated per request via the HTTP `role` parameter — denied families vanish from `list_sources`/`get_schema` and their queries are refused by the engine. `biz.*` and the knowledge store stay team-wide.
