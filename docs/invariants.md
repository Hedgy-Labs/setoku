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
- **I8 — No server-side inference; zero AI keys required.** Setoku never calls an
  LLM or embedding API. `find_context` works fully on Postgres FTS + trigram alone.
  Opt-in, clearly-labeled upgrades: a bundled local CPU embedding model, then
  bring-your-own-key embeddings. The default deploy needs no AI credentials.
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
