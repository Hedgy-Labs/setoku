# Invariants (I1–I9)

The load-bearing constraints the system — and any agent working on it — must
preserve. Referenced throughout the codebase as `I1`…`I9`. Kept here (out of the
README) so the references resolve without bloating the front page.

- **I1 — Databases are never public.** Only Caddy binds a public port. Postgres
  and ClickHouse listen on the compose network only.
- **I2 — The corrections queue is the only write path into curated context, and no
  agent that reads untrusted data may hold a tool that commits a write.** The
  accept/commit decision happens **outside the agent loop**: injection attacks the
  agent's *decision*, not its credential. Analyst tokens are **propose-only**
  (`report_correction` → pending); the curated-write tools (`upsert_context`,
  `resolve_correction`) are exposed only to a separate **curator token**, which is
  in turn **blocked from reading the lake** (`denyLakeRead`) — so a session that can
  commit knowledge structurally cannot ingest the untrusted bulk text that would
  weaponize the write tool. The two capabilities never coexist. Acceptance of
  team-proposed knowledge is the web approval surface; `/setoku:generate` /
  `/setoku:curate` use the curator token (they read the customer's own code and
  schema metadata, never lake content).
- **I3 — No pilot-tenant data in the repo.** No real metric definitions, gotchas,
  channel names, or log samples. CI greps a denylist (terms in the private overlay,
  fed via the `SETOKU_DENYLIST` secret).
- **I4 — Lake data is durable user data.** Setoku may hold the *only* copy of a
  user's logs. Backups to off-provider object storage are part of setup; Vector
  buffers to disk so a ClickHouse restart drops nothing. The business-DB mirror
  (`biz.*`, ingest/pg-mirror) is the deliberate exception: re-derivable from prod
  on the next reload, so it lives in its own database and stays OUT of the backup
  and Parquet-export story.
- **I5 — Dialect-routed, engine-portable knowledge.** Metric SQL declares its
  dialect (`clickhouse` today; future `bigquery`/`snowflake`); `run_query` routes
  accordingly. The context layer is storage-agnostic. A metric is canonical in
  exactly **one** dialect — business tables are read via the `biz.*` mirror, so
  metrics are canonical in `clickhouse` and a two-dialect drift problem never
  exists. (`postgres` was a runnable dialect until the direct business-Postgres
  read path was retired; legacy postgres docs are flagged by knowledge-lint for
  migration, and `run_query` rejects the dialect with a pointer to `biz.*`.)
- **I6 — Single-tenant by architecture.** One deploy = one org. No tenancy layer —
  isolation as a feature.
- **I7 — Verify vendor facts at build time.** Slack rate limits, Vercel/Render plan
  gating and APIs, and prices churn; re-verify against official docs before encoding
  behavior around them.
- **I8 — No *external* inference; zero AI keys required.** Setoku never calls an
  LLM or a hosted embedding API, and never sends business data off the box for
  inference. The load-bearing guarantee: **no business data to an external service,
  no required credentials.** Hybrid retrieval uses a **bundled, local, CPU-only,
  non-LLM embedding model** that runs *in-process on the box* — data never leaves
  the machine, no network at query time, no key. It is **on by default and
  required** (not an opt-in); `SETOKU_EMBEDDINGS=0` is a diagnostics/test
  kill-switch only (CI uses it so the suite stays model-free). It still **degrades
  gracefully**: if the model genuinely can't load, the gateway falls back to
  keyword retrieval and keeps serving — that's resilience, not a config choice. A
  future bring-your-own-key *hosted* embedding tier would be the only external,
  opt-in rung.
  *Amended (experiment/llm-wiki, then "require embeddings" follow-up): the original
  wording already named a "bundled local CPU embedding model"; a local model is
  technically on-box inference, so the local-vs-external line is now explicit, and
  embeddings moved from opt-in to default/required. Evidence: cross-domain recall
  held 88% with embeddings vs 13% for a hand-tuned synonym table (docs/llm-wiki.md).*
- **I9 — Authority changes pass through a human, outside the agent loop.** No MCP
  tool may create users, change roles, grant data access, or commit curated
  knowledge — the defense is a human action the agent *cannot perform* (a click on
  the approval surface), not a permission the agent holds. Access is enforced by the
  database engines (per-role users + GRANTs), never by SQL parsing in our code — the
  gateway's lake user is a SELECT-only, settings-constrained ClickHouse user whose
  per-source grants ride on roles
  ([`deploy/clickhouse/lake-users.xml`](../deploy/clickhouse/lake-users.xml)), so
  per-user source access is a role subset the engine enforces. The gateway holds
  **no** business-DB credential at all: the read-only Postgres role
  ([`deploy/readonly-role.sql`](../deploy/readonly-role.sql)) belongs to
  `ingest/pg-mirror`, the one container that reads the source database, and
  business tables reach sessions only as the `biz.*` mirror.

## Per-user source access — scope & known limits

Per-user data-source access (the Team-page "Data access" dialog) fences a
person's **agent queries and curated knowledge** off a denied source, enforced
by the ClickHouse engine (role subset) and, for knowledge, the shared
`lib/access` membrane (docs/corrections tagged `meta.source`). It does **not**
cover **published apps**. A published app is a TEAM-tier artifact: its rendered
data (it runs under the *creator's* access), its panel SQL, its provenance, and
its very existence are visible to every signed-in member and to any analyst
connector, regardless of that person's source denies. This is deliberate and
load-bearing: hiding an app by source would require parsing its panel SQL to
decide which sources it touches, which is exactly the "access by SQL parsing"
I9 forbids. **Consequence:** to fence a source from someone, do not build team
apps over it — the deny governs their agent and their knowledge, not a dashboard
a colleague published. (The built-in "Mirror egress" app is the shipped instance:
it is team-visible even to a business-denied member.)

## Requires a human (the agent should stop and ask)

- Buying the VPS & object storage; DNS; SSH keys.
- Provider credentials: Vercel token (Pro), Render API key, Slack app install.
- Creating the read-only DB role on the customer's database (used by pg-mirror,
  never the gateway).
- Limiting a person's data-source access (the Team page dialog, admin-only).
- **Accepting any correction into curated context.**
