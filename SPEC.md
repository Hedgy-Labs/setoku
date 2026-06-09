# Setoku — Spec (v0.5)

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

- Read-only Postgres gateway: `get_schema`, `run_query` (read-only, row cap, statement timeout, audit log).
- Per-user bearer token → identity for audit + table-level allow-list. (No RLS/masking in v0 — contract supports adding them.)
- Generator pass over a repo (Prisma schema + key business logic + existing gotchas) → context artifact, grounded in `file:line`, user-reviewed.
- Context tools: `list_entities`, `find_context`, `describe_entity`, `get_metric`, `report_correction`.
- `bi-analyst` skill (retrieve-before-infer, ask-don't-guess) + plugin packaging.
- Run against **hedgy** as test case #1; then a second, different business/codebase.
- An **eval skill**: golden questions + expected answers per business, stored in the artifact repo; the subscription agent runs the eval inline (Mode A — no programmatic harness needed) and reports a scorecard.

Out (for now): Mode B harnesses (Slack/UI), multi-source federation / Cube, RLS/column masking enforcement, write actions, embeddings (unless retrieval recall forces it), Cowork-specific polish.

## Tech choices (v0)

- **Skip Wren.** It bundled a text-to-SQL pipeline (replaced by Claude) and a UI (unused); it does **not** provide per-tenant access control (our core value). Build the thin gateway instead.
- **Data sources:** Postgres (v0) → **BigQuery next** (Google Analytics exports). Open lean: rather than federating connectors, **form a small datalake in DuckDB** — ingest/sync sources into DuckDB and point the gateway at one engine (one dialect for the agent, cheap local analytics, BigQuery/Postgres both readable via DuckDB extensions). Decide when BigQuery lands.
- **Graduation path:** thin gateway (+ DuckDB lake) → (if shared semantic layer at scale) **Cube** behind the same gateway → never Wren.
- MCP server: HTTP transport, language TBD (likely TS or Python).
- Retrieval: keyword/BM25 to start.

## Decisions

| #   | Question             | Decision                                                                                                                                                                                   |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Identity/auth        | Per-user bearer token issued by the gateway; SSO/OIDC later.                                                                                                                               |
| D2  | Access control depth | Defer enforcement; v0 = read-only + caps + audit + **table-level** allow-list. Architecture (tool contracts, token→identity) must support roles/RLS/masking without rework.                |
| D3  | Context freshness    | **Ambient regeneration**: dev-machine Claude Code sessions detect stale context vs. code and propose updates as a side effect of dev work (repo skill/hook); manual full pass as backstop. |
| D4  | Eval                 | Needed before tuning. Run **inline by the subscription agent via an eval skill** (golden questions in the artifact repo) — no programmatic harness.                                        |
| D5  | Data sources         | Postgres v0; **BigQuery next** (GA exports). Leaning toward a **DuckDB datalake** as the single engine the gateway queries.                                                                |
| D6  | Curation ownership   | **Users own it.** Conversational: agent asks clarifying questions during use, remembers answers as artifact candidates, human accepts diffs.                                               |
| D7  | Business model       | **Product, not services-with-tooling.** All workflows self-serve / agent-driven.                                                                                                           |
| D8  | Semantic layer       | Skip Wren; thin gateway; Cube only if scale demands.                                                                                                                                       |

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
