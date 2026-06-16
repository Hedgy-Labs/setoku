-- SPDX-License-Identifier: Apache-2.0
-- Liveness heartbeats from the long-running ingest connectors we operate (the
-- Slack Socket-Mode listener today; future pollers/listeners reuse this). A beat
-- proves the pipeline is ALIVE even when no data happens to be flowing — so a
-- quiet-but-healthy source reads "flowing", not a false "stale". This is distinct
-- from a table's own data recency (max(event_ts), max(ingested_at), …), which
-- tracks business activity, not whether the connector is up.
--
-- A connector beats periodically *while connected*; it stops beating when it
-- dies or loses its connection, so the beat going stale is a real alarm. The
-- /admin Sources page reads liveness from here (see plugin/gateway/lib/sources.ts
-- → LakeSource.connector) and shows data recency separately.
CREATE TABLE IF NOT EXISTS setoku.ingest_heartbeats
(
    connector  LowCardinality(String)  COMMENT 'connector name, e.g. slack-listener',
    beat_at    DateTime64(3)           COMMENT 'last liveness beat (UTC) — ReplacingMergeTree version (newest wins)',
    detail     String                  COMMENT 'optional status detail (e.g. "connected")'
)
ENGINE = ReplacingMergeTree(beat_at)
ORDER BY connector
COMMENT 'Ingest-connector liveness heartbeats — proves a pipeline is alive even when idle.';
