-- SPDX-License-Identifier: Apache-2.0
-- Mercury webhook event log (OPTIONAL, append-only). Mercury can POST real-time
-- events (same shape as its Events API, JSON Merge Patch) to a configured URL.
-- We capture them losslessly here rather than merging partial patches into the
-- typed mercury_transactions table (a partial patch would clobber unchanged
-- columns under ReplacingMergeTree). So:
--   • mercury_transactions = source of truth for current state (from the poller)
--   • mercury_events        = real-time stream of change notifications (this table)
-- The poller alone is correct without webhooks; the webhook just lowers latency.
--
-- Auth is via an unguessable token in the URL path (Caddy verifies + strips it),
-- mirroring the Render log-stream route. Mercury HMAC signature verification is a
-- future hardening — see ingest/mercury-poller/README.md.
CREATE TABLE IF NOT EXISTS setoku.mercury_events
(
    received_at     DateTime64(3)           COMMENT 'when Setoku received the webhook',
    event_ts        DateTime64(3)           COMMENT 'event timestamp from the payload (falls back to received_at)',
    event_type      LowCardinality(String)  COMMENT 'event/resource type from the payload when present',
    transaction_id  String                  COMMENT 'referenced transaction id when present (→ mercury_transactions.id)',
    account_id      String                  COMMENT 'referenced account id when present',
    status          LowCardinality(String)  COMMENT 'transaction status carried by the event, if any',
    raw             String                  COMMENT 'full webhook payload JSON — nothing dropped'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(received_at)
ORDER BY (received_at)
TTL toDateTime(received_at) + INTERVAL 365 DAY
COMMENT 'Mercury webhook events (optional real-time stream). Authoritative transaction state lives in mercury_transactions.';
