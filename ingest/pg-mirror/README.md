# pg-mirror — the business DB, mirrored into the lake

Full-reloads every allowlisted Postgres table into the bundled ClickHouse on a
poller-style loop (issue #47). The mirror (`biz.*`, clickhouse dialect) is the
**default read path for heavy app panels**: prod Postgres stays for ad-hoc
`run_query`, point lookups, and verifying the mirror against source.

## Why full reload

No CDC, no replication slots pointed at prod, no replica-identity footguns.
Schema drift is a non-event — the next run picks up the new shape — and a table
dropped from prod or from the allowlist is **pruned** from the mirror on the
next pass, so revoking a grant removes the lake copy too. Incremental cursors
are a later optimization for append-only tables only if size demands.

## How a run works (per table, staged swap)

1. DDL is derived from the pg catalog through an **explicit type map**
   (`PG_TO_CH` in `mirror.ts`); an unmapped type fails that table loudly.
2. `biz.<table>__staging` is created (`ENGINE = MergeTree`, `ORDER BY` = the pg
   primary key — that's the entire tuning story) and rows are SELECT-streamed
   in through a cursor using the **same read-only role the gateway queries
   with**, so the allow/deny list and the role's grants are inherited; a table
   denied to `run_query` never leaves prod.
3. The staged row count is verified, then the table is atomically
   `EXCHANGE`d/`RENAME`d into place — readers never see a half-loaded table. A
   failed reload keeps the previous good copy live.
4. The reload lands in `setoku.pg_mirror_runs` (per-table freshness + failure
   detail — powers the "data as of" stamps in /healthz, /admin, and the app
   frame) and the loop beats `ingest_heartbeats` as connector `pg-mirror`.

Naming: `public.orders` → `biz.orders`; other schemas prefix,
`ticketing.seat_txn` → `biz.ticketing_seat_txn`. Every mirrored row carries
`_mirrored_at` (stamped at load), so "data as of" is queryable inline —
`SELECT max(_mirrored_at) FROM biz.<t>` — without reading `pg_mirror_runs`.

The copy streams through one READ ONLY cursor per table (a consistent
snapshot, and it works through transaction-pooling proxies). For very large
tables where holding a snapshot for the copy duration is a concern,
keyset-pagination on the PK is the known alternative (short statements, no
pinned snapshot, fuzzy reads) — not implemented until a table needs it.

## Type notes

- `numeric(p,s)` → `Decimal(p,s)`; bare `numeric` → `Decimal(38,9)` (exact for
  money-scale values; out-of-range fails loudly rather than rounding through
  Float64).
- Timestamps/dates leave pg as **text** (offset included) and are parsed by
  ClickHouse with `best_effort`, so the mirror never depends on a driver's
  timezone interpretation. `infinity` timestamps are unsupported (fail loudly).
- Floats stream as pg **text** too (shortest-exact, round-trips precisely), so
  `NaN`/`±Infinity` survive into real ClickHouse Float specials instead of
  collapsing in the driver; a `null` reaching a NOT NULL column fails the
  reload loudly (`input_format_null_as_default=0`) instead of silently
  becoming 0.
- pg enums → `LowCardinality(String)`; arrays → `Array(T)` (a NULL array lands
  as `[]` — ClickHouse arrays can't be Nullable); `json`/`jsonb` → `String`.

## Backups (I4)

Mirrored tables are re-derivable from prod, so `biz` is a **separate ClickHouse
database**, excluded from `clickhouse-backup` (`CLICKHOUSE_SKIP_TABLES`) and
from the weekly Parquet export (which walks `setoku` only). The precious lake
data — Slack/GitHub history, logs — keeps exactly the backup story it had.

## Run it

```bash
# .env: COMPOSE_PROFILES=…,mirror  and SETOKU_DATABASE_URL must be set
docker compose up -d --build pg-mirror
```

Env: `SETOKU_DATABASE_URL` (required, the read-only role),
`SETOKU_MIRROR_INTERVAL_MS` (default 900000 = 15 min), `CLICKHOUSE_*` (like
every connector).

The allow/deny list comes from the baked `.setoku/config.json` (same
`deploy/project-template` bake as the gateway image) and **fails closed**: a
missing or corrupt config skips the run rather than mirroring with defaults.
After editing `allowTables`/`denyTables`, rebuild **both** images so the lists
can't drift: `docker compose up -d --build server pg-mirror`.

Tests: `bun test ingest/pg-mirror/` (real local Postgres + a fake ClickHouse;
set `SETOKU_E2E_CH_URL` to also run the real-engine e2e, same gate as
`test/lake.test.ts`).

## The mirror is the read path

With the mirror up, the gateway **requires** it: postgres-dialect `run_query`
and app panels that touch mirrored tables are rejected with the `biz.*`
rewrite. `run_query force_postgres: true` reads the live source (verifying the
mirror, row-level freshness); `.setoku/config.json` `"mirrorPolicy": "prefer"`
softens the whole policy to an advisory nudge.
