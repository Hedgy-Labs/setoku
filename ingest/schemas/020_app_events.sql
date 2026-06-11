-- SPDX-License-Identifier: Apache-2.0
-- First-party structured events (tasks 3.2 + 3.5) — the high-grade ore.
-- Contract: docs/events.md. Applications POST deliberate business events;
-- platform request logs are the low-grade ore.
CREATE TABLE IF NOT EXISTS setoku.app_events
(
    ts          DateTime64(3)           COMMENT 'event time as stated by the producer (`ts`, RFC3339; receive time if absent)',
    event_id    String                  COMMENT 'producer-supplied idempotency key; when absent, a content hash — client retries dedupe on it',
    event_name  LowCardinality(String)  COMMENT 'snake_case event name (e.g. order_placed); "_invalid" = arrived without one',
    actor       String                  COMMENT 'who/what caused the event (user id, system name)',
    properties  String                  COMMENT 'event payload as JSON — query with JSONExtract*()',
    received_at DateTime DEFAULT now()  COMMENT 'lake receive time (also the ReplacingMergeTree version)',
    raw         String                  COMMENT 'full original event JSON'
)
ENGINE = ReplacingMergeTree(received_at)  -- duplicate (event_name, ts, event_id) rows collapse: at-least-once delivery is safe
PARTITION BY toYYYYMM(ts)
ORDER BY (event_name, ts, event_id)
-- no TTL: business events are durable user data (I4)
COMMENT 'First-party structured events (POST /ingest/events, contract in docs/events.md). Use FINAL or GROUP BY for exact counts until parts merge.';
