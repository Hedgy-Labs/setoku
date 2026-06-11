# Backups (invariant I4)

Bundling the lake means Setoku may hold the **only** copy of a user's logs, and
the context store is curated human knowledge — not rebuildable. Backups are part
of setup, not a footnote. **The bucket must live on a different provider than
the box** (the box is disposable; the bucket is not).

| What | How | When | Retention |
|---|---|---|---|
| Knowledge store (SQLite, v0.9) | `VACUUM INTO` snapshot → bucket | nightly | 14 days |
| Postgres context store | `pg_dump | gzip` → bucket | nightly | 14 days |
| ClickHouse lake | `clickhouse-backup create_remote` | nightly | 14 backups |
| Lake → Parquet (portability) | `INSERT INTO FUNCTION s3(..., 'Parquet')` per table | weekly | keep all (cheap, append-only) |

Setup: fill the `SETOKU_BACKUP_*` variables in `.env` (B2 / R2 / Hetzner object
storage all work — S3-compatible, path-style), then install
[`cron.example`](./cron.example) on the host.

The weekly Parquet exports are the no-stranded-data guarantee: any engine that
reads Parquet (clickhouse-local, DuckDB, pandas, Spark) can use them directly —
no Setoku required.

## Restore drill

Run [`restore-drill.sh`](./restore-drill.sh) on a clean VM with only the repo +
a `.env` (backup credentials + fresh secrets). It rebuilds the stack from
bucket contents alone and verifies the gateway and lake. **Run it for real once
after first deploy**, and again after any backup-config change. Expected data
gap: <24 h (nightly cadence).
