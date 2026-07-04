-- SPDX-License-Identifier: Apache-2.0
-- Business-DB mirror (pg-mirror connector, issue #47).
--
-- `biz` holds full-reload mirrors of allowlisted business-DB tables — the
-- default read path for heavy app panels (clickhouse dialect). It is a
-- SEPARATE database on purpose: mirrored tables are re-derivable from prod, so
-- `biz` is excluded from clickhouse-backup and the Parquet export (I4) — only
-- the genuinely precious lake data (setoku.*) is backed up. Table DDL inside
-- `biz` is owned entirely by ingest/pg-mirror (derived from the pg catalog per
-- run); nothing else creates tables there.
CREATE DATABASE IF NOT EXISTS biz;

-- Per-table reload history: freshness ("data as of") for /healthz, the /admin
-- Sources page, and the app frame chrome — and failure legibility when a
-- reload dies mid-run (the previous good copy stays live; the error lands
-- here). The mirror self-heals this table on startup too (existing boxes never
-- re-run these numbered files).
CREATE TABLE IF NOT EXISTS setoku.pg_mirror_runs
(
    started_at   DateTime64(3)           COMMENT 'reload start (UTC)',
    finished_at  DateTime64(3)           COMMENT 'reload end (UTC) — the mirror''s "data as of"',
    target_table LowCardinality(String)  COMMENT 'mirror table name in biz (e.g. ticketing_seat_txn)',
    source_table String                  COMMENT 'source pg table (e.g. ticketing.seat_txn)',
    rows         UInt64                  COMMENT 'rows loaded (0 on error)',
    status       LowCardinality(String)  COMMENT 'ok | error',
    error        String                  COMMENT 'failure detail (empty on ok)'
)
ENGINE = MergeTree
ORDER BY (finished_at, target_table)
TTL toDateTime(finished_at) + INTERVAL 90 DAY;
