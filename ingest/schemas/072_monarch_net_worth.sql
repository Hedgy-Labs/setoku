-- SPDX-License-Identifier: Apache-2.0
-- Monarch Money daily net worth history (the aggregateSnapshots query — the same
-- series that drives Monarch's Net Worth chart). `balance` is already assets minus
-- liabilities with all sign conventions resolved by Monarch, so this is the
-- authoritative net-worth number — prefer it over summing monarch_accounts by hand.
--
-- Monarch REVISES history when an institution back-fills or a manual balance is
-- edited, so the poller re-emits a rolling window each tick and this is a
-- ReplacingMergeTree keyed by date with `ingested_at` as the version. The first
-- run backfills years; query with FINAL for the current value of each day.
--
-- One row per calendar day. Schema verified against GetAggregateSnapshots (2026).
CREATE TABLE IF NOT EXISTS setoku.monarch_net_worth
(
    date         Date          COMMENT 'calendar day',
    balance      Float64       COMMENT 'net worth on that day, USD (assets − liabilities; Monarch-computed)',
    ingested_at  DateTime64(3) COMMENT 'observation time — ReplacingMergeTree version (newest wins)'
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(date)
ORDER BY (date)
COMMENT 'Monarch daily net worth (assets − liabilities, Monarch-computed). One row per day; query with FINAL. Latest day = current net worth.';
