-- SPDX-License-Identifier: Apache-2.0
-- Render log-stream rows (task 3.2). ⚠ I7: Render's HTTPS-JSON payload schema
-- is "provider-specific" and NOT publicly documented (render.com/docs/log-streams,
-- checked June 2026) — these typed columns are a defensive guess (service slug,
-- instance id, level are documented as annotations); `raw` always preserves the
-- full event. Confirm against a live stream when wiring the Render provisioner
-- (task 4.3) and tighten then.
CREATE TABLE IF NOT EXISTS setoku.logs_render
(
    ts        DateTime64(3)           COMMENT 'event time (parsed best-effort; falls back to receive time)',
    service   LowCardinality(String)  COMMENT 'Render service slug/name annotation',
    instance  String                  COMMENT 'Render instance id (distinguishes replicas across deploys)',
    level     LowCardinality(String)  COMMENT 'log level (Render maps logfmt/JSON `level`; default info)',
    type      LowCardinality(String)  COMMENT 'log type annotation if present (app/build/system)',
    message   String                  COMMENT 'log line content',
    raw       String                  COMMENT 'full original event JSON — nothing is dropped'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (service, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY
COMMENT 'Render workspace log stream (HTTPS JSON to /ingest/render). Render drops lines beyond ~6k/min/instance — route high-volume telemetry as first-party events instead.';
