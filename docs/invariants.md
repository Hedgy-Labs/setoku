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
  `/setoku:curate` use the curator token (they read the customer's own code and the
  business Postgres, never the lake).
- **I3 — No pilot-tenant data in the repo.** No real metric definitions, gotchas,
  channel names, or log samples. CI greps a denylist (terms in the private overlay,
  fed via the `SETOKU_DENYLIST` secret).
- **I4 — Lake data is durable user data.** Setoku may hold the *only* copy of a
  user's logs. Backups to off-provider object storage are part of setup; Vector
  buffers to disk so a ClickHouse restart drops nothing.
- **I5 — Dialect-routed, engine-portable knowledge.** Metric SQL declares its
  dialect (`postgres` | `clickhouse` | future `bigquery`/`snowflake`); `run_query`
  routes accordingly. The context layer is storage-agnostic.
- **I6 — Single-tenant by architecture.** One deploy = one org. No tenancy layer —
  isolation as a feature.
- **I7 — Verify vendor facts at build time.** Slack rate limits, Vercel/Render plan
  gating and APIs, and prices churn; re-verify against official docs before encoding
  behavior around them.
- **I8 — No *external* inference; zero AI keys required.** Setoku never calls an
  LLM or a hosted embedding API, and never sends business data off the box for
  inference. `find_context` works fully on keyword + synonym retrieval with no AI
  credentials. **Opt-in upgrade (default off): a bundled, local, CPU-only, non-LLM
  embedding model** (`SETOKU_EMBEDDINGS=1`) that runs *in-process on the box* for
  hybrid retrieval — data never leaves the machine, no network at query time, no
  key. It must **degrade gracefully**: if the model can't load, the gateway falls
  back to keyword retrieval and keeps serving. The next rung (bring-your-own-key
  hosted embeddings) stays external and opt-in.
  *Amended (experiment/llm-wiki): the original wording already named a "bundled
  local CPU embedding model" as an upgrade; this makes the local-vs-external line
  explicit, since a local model is technically on-box inference. The load-bearing
  guarantee — no business data to an external service, no required keys — is
  unchanged. Evidence: cross-domain recall held 88% with embeddings vs 13% for a
  hand-tuned synonym table (docs/llm-wiki.md).*
- **I9 — Authority changes pass through a human, outside the agent loop.** No MCP
  tool may create users, change roles, grant data access, or commit curated
  knowledge — the defense is a human action the agent *cannot perform* (a click on
  the approval surface), not a permission the agent holds. Access is enforced by the
  database engines (per-role users + GRANTs), never by SQL parsing in our code — the
  gateway's lake user is a SELECT-only, settings-constrained ClickHouse role
  ([`deploy/clickhouse/lake-users.xml`](../deploy/clickhouse/lake-users.xml)), and
  the business-DB role is read-only ([`deploy/readonly-role.sql`](../deploy/readonly-role.sql)).

## Requires a human (the agent should stop and ask)

- Buying the VPS & object storage; DNS; SSH keys.
- Provider credentials: Vercel token (Pro), Render API key, Slack app install.
- Creating the read-only DB role on the customer's database.
- **Accepting any correction into curated context.**
