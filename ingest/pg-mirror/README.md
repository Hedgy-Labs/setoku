# pg-mirror

Full-reload mirror of allowlisted business-Postgres tables into the bundled
ClickHouse lake (issue #47). App panels that aggregate big business tables
should read the mirror (`clickhouse` dialect, tables named `biz_*`) instead of
seq-scanning prod — ClickHouse does that workload natively, and prod stays
untouched by dashboard load. Prod Postgres remains the source of truth and the
right venue for ad-hoc queries and point lookups.

## How it works

Every `PG_MIRROR_INTERVAL_MS` (default 1h), for each allowed table:

1. **Derive DDL from the Postgres catalog** — the mirror's shape always matches
   the current table; schema drift is a non-event, not a stall. The type map is
   explicit and an unmapped type fails that table loudly (never a silent
   coercion). `numeric` lands as `Float64` (documented lossiness, fine for
   analytics).
2. **Copy into `biz_<table>__staging`** in keyset-paginated batches on the
   primary key (bounded memory at millions of rows). Tables without a PK load
   in one pass up to `PG_MIRROR_NO_PK_ROW_CAP` (default 200k), beyond which
   they fail loudly — add a PK or deny them.
3. **Verify the staged row count, then `EXCHANGE TABLES`** — the live table is
   never empty or partial; a failed run leaves the previous copy serving.

Each row carries `_mirrored_at`, the "data as of" stamp surfaced on the
Sources page. Liveness beats into `ingest_heartbeats` as `pg-mirror`, with
per-table failures in the beat detail.

## Access + allowlist

Reads Postgres with `SETOKU_DATABASE_URL` — the **same read-only role the
gateway uses**, so the engine-enforced grants bound what can ever leave
Postgres. On top of that, `PG_MIRROR_TABLES` / `PG_MIRROR_DENY_TABLES` are
`schema.table` globs with the same semantics as `.setoku/config.json`
`allowTables` — **keep them in sync with the project config**: the mirror must
never widen what the gateway's postgres path allows.

Writes ClickHouse as the full-privilege ingest user (`CLICKHOUSE_USER`), like
every other connector; the gateway still reads only as `setoku_ro`.

Mirrors are re-derivable from Postgres, so they are NOT part of the lake's
precious-data backup story (I4) — a lost mirror is one reload away.

## Enable

```bash
# .env on the box
COMPOSE_PROFILES=...,pg-mirror
PG_MIRROR_TABLES=public.*            # match .setoku allowTables
docker compose up -d --build pg-mirror
```
