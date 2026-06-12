# Spec: curator write path (one knowledge store, on the box)

**Status:** draft for review.

## Problem

`/setoku:generate` and `/setoku:curate` write curated knowledge via
`upsert_context` / `resolve_correction`. But the deployed box gateway is
**propose-only** (I2/I9): it exposes no curated-write tool, because an agent
that reads untrusted lake/Slack content is prompt-injectable, and injection
attacks the agent's *decision*, not its credential — so no agent session may
hold a write-commit tool.

The current workaround is `SETOKU_CURATOR_MODE=1` on a **local** stdio gateway,
which writes to a **local SQLite store** — a second store, separate from the
box that analysts query. That's the two-store problem we want gone.

## Goal

`generate`/`curate` write directly to the **box's** store (one source of
truth), without reopening the injection hole.

## The safety principle (unchanged)

> A curated write must be authorized by a credential that an *injectable
> session* does not hold.

Curator operations read **trusted** sources (the customer's own codebase; or
proposals a human is reviewing) — not the lake. Analyst operations read the
**untrusted** lake. The fix makes those two capabilities **mutually exclusive
on a single session**, by enforcement rather than discipline.

## Design

1. **A curator credential, separate from analyst tokens.** Add
   `SETOKU_CURATOR_TOKENS` (same `token=identity` shape as `SETOKU_TOKENS`),
   provisioned by the admin (`admin-cli.ts create-curator-token`, tied to an
   admin account). A request authenticated with a curator token builds the
   server with `canWrite: true` → exposes `upsert_context` + `resolve_correction`
   in addition to the read + propose tools. Analyst tokens never get these.

2. **Mutual exclusion — the load-bearing enforcement.** A curator-token session
   is **blocked from reading the lake**: `run_query` with `dialect: clickhouse`
   is rejected, and lake-derived pending corrections are not surfaced. So a
   curator session reads only the business Postgres (`get_schema` / postgres
   `run_query`, needed to validate metric SQL) and the codebase (via the agent's
   own file tools, outside the gateway entirely). Result: a session that can
   *commit* curated knowledge structurally cannot *read* the bulk
   attacker-controlled free text — there is no injection vector to weaponize the
   write tool. (Conversely, analyst sessions read the lake but hold no write
   tool. The two never coexist.)

3. **Curator credential stays off analyst machines.** It's configured only on
   the operator's machine, as a distinct MCP connector (e.g. `setoku-curator`)
   that `generate`/`curate` use. Analyst connectors (`setoku`) are propose-only,
   as today.

4. **Skills target the box.** `generate`/`curate` connect to the box's
   `setoku-curator` connector. The local stdio store is deprecated for
   box deployments (kept only for fully-offline dev). Onboarding configures the
   curator connector when it sets up the box.

5. **Audit.** Every curator write is already audited with the curator identity;
   surfaced on `/admin`'s audit page alongside approvals.

## Residual risk & mitigation

- The business **Postgres** could itself contain attacker-influenced free text
  (e.g. a malicious user's profile field). Lower risk than the lake (generate
  reads schema + runs aggregate metric SQL, not bulk free-text dumps), and the
  human reviews generate's output. If we want to close it fully: a curator
  session could be restricted to `get_schema` + human-confirmed SQL only, no
  ad-hoc `SELECT` of free-text columns. **Decision:** start with the
  lake-exclusion (high value, simple); revisit Postgres free-text reads if a
  real threat emerges.

## Alternative considered: propose + bulk-approve (rejected as the default)

Have `generate` emit its docs as **pending corrections** to the box, and add a
"bulk-approve this generate batch" action on `/admin`. Membrane-pure (every
write is a human click outside the loop). Rejected as the default because
generate reads the customer's *own* codebase (trusted, human-initiated) — gating
it behind the same approval as Slack-mined corrections is friction without
meaningful safety gain, and re-approving on every iterative re-run is heavy. We
may still offer it as a stricter opt-in mode.

## Open decisions

1. Curator credential = a dedicated token, or derived from an admin login
   (short-lived)? (Token is simpler; admin-derived is tighter.)
2. Does onboard auto-provision the `setoku-curator` connector, or is it a
   separate `setoku admin enable-curator` step?
3. Deprecate the local stdio store entirely, or keep it as an offline-dev
   fallback?

## Rollout

- `app.ts` already gates the write tools on `canWrite`; this adds a third
  caller path (curator token over HTTP) plus the lake-read block on those
  sessions.
- `http.ts`: classify the request's token (analyst | curator), set `canWrite`
  and a `denyLakeRead` flag accordingly.
- `lib/lake.ts` / `app.ts run_query`: reject `dialect: clickhouse` when
  `denyLakeRead`.
- `admin-cli.ts`: `create-curator-token`.
- `generate`/`curate` skills + onboard: use the curator connector.
- Tests: a curator token can `upsert_context` but a `clickhouse` `run_query` on
  it is refused; an analyst token still can't `upsert_context`; the two
  capabilities never coexist.
