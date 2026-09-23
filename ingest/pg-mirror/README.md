# pg-mirror — the business DB, mirrored into the lake

Mirrors every allowlisted Postgres table into the bundled ClickHouse on a
poller-style loop (issue #47): a full reload, or an `xmin` delta for tables
that qualify (see "Incremental pull"). The mirror (`biz.*`, clickhouse dialect) is the
**default read path for heavy app panels**: prod Postgres stays for ad-hoc
`run_query`, point lookups, and verifying the mirror against source.

## Why no CDC

No logical replication, no replication slots pointed at prod, no
replica-identity footguns: the mirror only ever SELECTs through the read-only
role. Schema drift is a non-event (the next run picks up the new shape), and a
table dropped from prod or from the allowlist is **pruned** from the mirror on
the next pass, so revoking a grant removes the lake copy too.

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

## Incremental pull: egress scales with the rows that changed

Skip-unchanged only helps a table with no writes at all. A busy table used to
restream in full on every pass, so a large table with a trickle of inserts cost
its full size many times a day. So a table that changed is pulled
**incrementally** when it qualifies:

- Every Postgres heap row carries `xmin`, the id of the transaction that last
  wrote it. Each pass reads in one `REPEATABLE READ` snapshot and stores that
  snapshot's xmin (the oldest transaction still running) in
  `setoku.pg_mirror_state.cursor`. The next pass fetches only rows with
  `xmin` at or past that boundary. Rows written by transactions still open at
  snapshot time, including rows written under a `SAVEPOINT`, are always above
  it, so nothing slips between passes. (`pg_visible_in_snapshot` is **not**
  used: it misjudges subtransaction ids.) The comparison is modulo 2^32, so
  xid wraparound doesn't matter.
- The rows are upserted into the live mirror, a `ReplacingMergeTree` keyed on
  the pg key and versioned by `_mirrored_at`. Readers see one row per key
  because the gateway's ClickHouse profile sets `final=1`
  (`deploy/clickhouse/lake-users.xml`). There's no staging swap, so a
  multi-batch delta becomes visible batch by batch.
- Deletes, `TRUNCATE` and key changes leave no `xmin` behind. So every
  incremental pass also compares `count(*)` (same snapshot) with the mirror's
  `count() FINAL`; any difference means a full reload in the same pass.
- As a backstop, a mirror that has absorbed deltas since its last full reload
  is rebuilt once a day (`mode = reconcile`). With `SETOKU_MIRROR_QUIET_HOURS`
  set, that happens in the first pass of each quiet window, off-peak. Without
  a window it happens once the last full reload is
  `SETOKU_MIRROR_RECONCILE_HOURS` old (default 24; `0` turns the backstop
  off). It runs even if the table is quiet at that moment, since a table busy
  all day and idle at night is exactly the one to check. Tables that never
  took a delta are never reconciled; they are already an exact full reload.
- Each reconcile also **audits** the incremental path. It first catches the
  mirror up with one last delta, then, before swapping in the fresh full copy,
  diffs the two inside ClickHouse: keys only in the fresh copy (missing), keys
  only in the live mirror (extra: a missed delete), and keys whose rows differ
  (changed: a missed update), comparing a hash of every mirrored column
  (`formatRow`, so NULL stays distinct from '' and separators are escaped).
  The total lands in `setoku.pg_mirror_runs.drift` (NULL when not measured) and
  a non-zero result is logged with the breakdown. The reload fixes it either
  way. On a very busy table a row written in the second between the catch-up
  delta and the full copy can show up as a false positive, so look for drift
  that repeats, not a one-off.

  ```sql
  SELECT finished_at, target_table, drift FROM setoku.pg_mirror_runs
  WHERE mode = 'reconcile' AND drift > 0 ORDER BY finished_at DESC
  ```

This relies on no column names (no `updatedAt` convention) and no extra grants.
A table qualifies when it is a plain heap table (or a partitioned table whose
leaves all are) with a primary key, or else a unique index over `NOT NULL`
columns, whose key types map exactly (ints, text, uuid, dates/timestamps,
enums, bool), on Postgres 13 or later. Everything else (views, FDWs,
Postgres-compatible engines, float keys, PK-less tables) stays on full reload,
exactly as before. `SETOKU_MIRROR_INCREMENTAL=0` turns it off.

The cost on prod is two reads per changed table per pass: a heap scan for the
delta (`xmin` can't be indexed) and a `count(*)`, which is usually an index-only
scan of the key. Neither reads the out-of-line (TOAST) data that dominates fat
tables, so it is much less work than the full reload it replaces there. For a
small, narrow table it can be slightly more; the egress is what drops.
`setoku.pg_mirror_runs.mode` records `full` or `incremental` for every pull.

The cost on the lake side is `FINAL` on reads. Measured on a 16M-row table
(ClickHouse 26.10, laptop): once background merges have folded the table into
one part, `final=1` adds nothing; with a few un-merged delta parts on top, a
full-table aggregate took about 2x as long (65 ms to 120 ms; 100 ms to 250 ms
at 2 threads). Tables of a few hundred thousand rows don't notice. A very large
table that changes constantly pays that 2x on full scans, and
`SETOKU_MIRROR_INCREMENTAL=0` is the escape hatch if it matters more than the
egress.

**Read replicas.** On a hot standby, `pg_stat_user_tables` counts only the
standby's own writes, so the counters never move and the unchanged-skip would
freeze the mirror forever. The mirror checks `pg_is_in_recovery()` and turns the
skip off there. Incremental tables still cost only their delta; full-reload
tables reload every pass.

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
`_mirrored_at`, stamped when that row version was last pulled. It is the
ReplacingMergeTree version for incremental tables. For the table's "data as
of", read `pg_mirror_runs` (an unchanged or zero-row pass stamps no rows).

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
`SETOKU_MIRROR_INCREMENTAL` (default on, `0` = full reloads only),
`SETOKU_MIRROR_RECONCILE_HOURS` (default 24, `0` = never; see "Incremental pull"),
`SETOKU_MIRROR_QUIET_HOURS` / `SETOKU_MIRROR_QUIET_INTERVAL_MS` / `TZ` and
`SETOKU_MIRROR_DAILY_BYTES_CAP` (see "Egress budget" below),
`SETOKU_MIRROR_DENY_COLUMNS` (extra per-box `denyColumns`, comma-separated),
`CLICKHOUSE_*` (like every connector).

## Egress budget

Hosted Postgres meters egress, and the overage bills the moment it happens. Two
knobs keep the mirror inside a plan, on top of the unchanged-table skip:

- **Quiet hours.** `SETOKU_MIRROR_QUIET_HOURS=23-8` runs the mirror every
  `SETOKU_MIRROR_QUIET_INTERVAL_MS` (default 2 h) between 23:00 and 08:00 on the
  wall clock of `TZ` (default UTC; the window wraps past midnight when start >
  end), and every `SETOKU_MIRROR_INTERVAL_MS` the rest of the day. The loop
  re-checks the interval in force every minute, so the window's edges take
  effect within a minute: a pass ending at 07:50 is due at 08:00, not at 09:50.
- **Daily cap.** `SETOKU_MIRROR_DAILY_BYTES_CAP=12000000000` stops streaming
  once today's ledger (`setoku.pg_mirror_runs.bytes`, UTC day) reaches 12 GB:
  the running pass finishes its current table and leaves the rest for later
  (overshoot is bounded by one table's reload, recorded as status `capped`),
  and further passes are skipped until midnight UTC. Ledger bytes are the
  NDJSON the mirror streamed — column names repeated per row — so they
  **overstate** what the vendor bills on the wire by a schema-dependent factor;
  compare a few days of the ledger against the vendor's usage page and size the
  cap from your own ratio. The check fails **open** (a lake error runs the pass
  and logs) — it is a budget guard, not a security boundary. The /admin Slack
  alert fires at the lower of its threshold and the cap, so a pause is never
  silent.

The mirror publishes its effective schedule and state to
`setoku.pg_mirror_settings`; the Postgres card on /admin Sources shows the
cadence, the next pass, the cap, and a yellow "egress capped" chip while paused.

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
