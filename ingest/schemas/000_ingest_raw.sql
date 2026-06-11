-- SPDX-License-Identifier: Apache-2.0
-- Phase 2 catch-all: everything POSTed to /ingest/* lands here raw.
-- Phase 3 (task 3.2) adds typed tables (logs_vercel, logs_render, app_events,
-- slack_messages) and per-source Vector transforms; this table stays as the
-- escape hatch for unknown sources (nothing is ever silently dropped).
CREATE TABLE IF NOT EXISTS setoku.ingest_raw
(
    -- when Vector handed it to ClickHouse (UTC)
    ingested_at DateTime,
    -- which /ingest/* path it arrived on (e.g. /ingest/vercel)
    source_path LowCardinality(String),
    -- the original event, untouched, as JSON
    raw String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (source_path, ingested_at)
TTL ingested_at + INTERVAL 90 DAY; -- default retention; revisit per README open question 3
