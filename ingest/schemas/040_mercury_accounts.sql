-- SPDX-License-Identifier: Apache-2.0
-- Mercury bank account balance snapshots. The poller records every account's
-- balances on each tick, so this is an append-only time series — query the
-- latest row per account for "current balance", or trend the series for runway.
--
-- ⚠ Data minimization: the full account number is a sensitive identifier and is
-- NEVER stored. The poller redacts it to the last 4 digits before sending, and
-- strips it from `raw`. Routing numbers are public-on-checks and kept as-is.
-- Schema verified against the live GET /api/v1/accounts response (June 2026).
CREATE TABLE IF NOT EXISTS setoku.mercury_accounts
(
    snapshot_ts          DateTime64(3)           COMMENT 'when this balance was observed (poll time)',
    id                   String                  COMMENT 'Mercury account id (stable)',
    name                 String                  COMMENT 'account nickname',
    legal_business_name  String                  COMMENT 'legal entity name on the account',
    kind                 LowCardinality(String)  COMMENT 'checking / savings / etc.',
    type                 LowCardinality(String)  COMMENT 'Mercury account type',
    status               LowCardinality(String)  COMMENT 'active / archived / …',
    account_number_last4 String                  COMMENT 'last 4 of the account number ONLY (full PAN never stored)',
    routing_number       String                  COMMENT 'ABA routing number (public on checks)',
    available_balance    Float64                 COMMENT 'available balance, account currency (USD)',
    current_balance      Float64                 COMMENT 'current/ledger balance, account currency (USD)',
    created_at           DateTime64(3)           COMMENT 'account open date',
    raw                  String                  COMMENT 'full account JSON with accountNumber redacted to last4'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(snapshot_ts)
ORDER BY (id, snapshot_ts)
TTL toDateTime(snapshot_ts) + INTERVAL 730 DAY
COMMENT 'Mercury account balance snapshots (poll-based). Latest row per id = current balance: argMax(current_balance, snapshot_ts) GROUP BY id, or ORDER BY snapshot_ts DESC LIMIT 1 BY id.';
