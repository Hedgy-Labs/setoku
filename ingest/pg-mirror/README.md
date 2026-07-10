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

## Skip-unchanged: egress scales with change, not size × cadence

Hosted Postgres meters egress, and a naive full reload bills the whole DB every
interval (the 2026-07 Supabase overage: ~15 tables' worth of quiet data
restreamed 96×/day). So each pass first reads the table's cumulative write
counters from `pg_stat_user_tables` (`n_tup_ins/upd/del`, plus `n_live_tup` to
catch TRUNCATE, which moves no counter) and combines them with a hash of the
mirrored shape (columns/types/PK — so DDL-only drift and `denyColumns` edits
still reload). If that signature equals the one the current mirror was built
from (`setoku.pg_mirror_state`), the table is **verifiably unchanged**: the
pass records a status `unchanged` run and streams nothing. Freshness surfaces
treat `unchanged` like `ok` — the mirror provably equals the source at check
time (`_mirrored_at` inside the rows still marks the last actual restream).
Counters are read *before* a reload streams, so a change racing the copy can
only cause one extra reload next pass, never a skipped stale mirror; a missing
stats row disables the skip for that table (reload rather than guess).

## denyColumns: leave the fat columns out

`.setoku/config.json` `"denyColumns": ["public.scrapes.raw_html", …]` excludes
columns from the mirror with the same glob semantics as the table lists (`*`
within a dot-segment). This is an egress/size control, **not** a security
boundary — grants still govern access (I9), and an excluded column stays
readable at the source via `run_query force_postgres: true`. Because every
reload is full, un-excluding is one config edit: the next pass repopulates the
column completely. Excluding a column with an unmappable type also rescues its
table. Real column names are tenant data (I3), so on a template-baked box they
go in `SETOKU_MIRROR_DENY_COLUMNS` (comma-separated, in the box's `.env`,
which deploys don't overwrite) — the env list merges into the config's.

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
`SETOKU_MIRROR_INTERVAL_MS` (default 900000 = 15 min),
`SETOKU_MIRROR_DENY_COLUMNS` (extra per-box `denyColumns`, comma-separated),
`CLICKHOUSE_*` (like every connector).

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
