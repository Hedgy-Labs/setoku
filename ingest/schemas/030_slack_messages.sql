-- SPDX-License-Identifier: Apache-2.0
-- Slack workspace archive (tasks 3.2 + 3.3/3.4). Written by the Socket Mode
-- listener (live) and the backfill job (history) — both insert the same row
-- shape; ReplacingMergeTree dedupes on (channel, ts), so at-least-once
-- delivery and idempotent backfill re-runs are safe by construction.
CREATE TABLE IF NOT EXISTS setoku.slack_messages
(
    channel     LowCardinality(String)  COMMENT 'Slack channel id (C…)',
    ts          String                  COMMENT 'Slack message ts (e.g. "1718000000.123456") — unique per channel, the dedupe key',
    event_ts    DateTime64(6)           COMMENT '`ts` parsed to a real timestamp (UTC)',
    thread_ts   String                  COMMENT 'parent thread ts; empty for top-level messages',
    user        String                  COMMENT 'Slack user id (U…) of the author',
    text        String                  COMMENT 'message text (raw Slack markup)',
    subtype     LowCardinality(String)  COMMENT 'message subtype (message_changed, bot_message, …); empty for plain messages',
    raw         String                  COMMENT 'full original event JSON',
    ingested_at DateTime DEFAULT now()  COMMENT 'lake receive time (ReplacingMergeTree version)'
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(event_ts)
ORDER BY (channel, ts)
-- no TTL: on free Slack plans this archive is the ONLY copy older than ~90 days (I4)
COMMENT 'Slack message archive. History before the backfill start is unavailable (free-plan window) — the archive only accrues forward.';
