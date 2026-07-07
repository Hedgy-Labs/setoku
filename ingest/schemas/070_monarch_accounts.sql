-- SPDX-License-Identifier: Apache-2.0
-- Monarch Money account balance snapshots. The poller records every account's
-- balances on each tick, so this is an append-only time series — query the
-- latest row per account for "current balance", or trend the series over time.
--
-- Net worth = SUM(current_balance) across accounts — current_balance is SIGNED:
-- liability accounts (credit cards, loans) are NEGATIVE (verified: a mortgage
-- reads -664038). So DON'T compute assets-minus-liabilities (that double-counts
-- debt) and DON'T sum display_balance (it flips liability signs positive for the
-- UI). SUM(current_balance) reconciles to Monarch's own net-worth aggregate
-- (monarch_net_worth) within ~0.2% (investment-account valuation timing).
-- `is_asset` = 1 for assets, 0 for liabilities. `include_in_net_worth` = 1 when
-- the account counts toward net worth (hidden/excluded accounts are 0).
--
-- ⚠ No full account number is exposed by the API; `mask` is the last 4 only.
-- Schema verified against the GetAccounts GraphQL query (2026).
CREATE TABLE IF NOT EXISTS setoku.monarch_accounts
(
    snapshot_ts          DateTime64(3)           COMMENT 'when this balance was observed (poll time)',
    id                   String                  COMMENT 'Monarch account id (stable)',
    display_name         String                  COMMENT 'account name as shown in Monarch',
    type                 LowCardinality(String)  COMMENT 'account type name (depository, credit, brokerage, loan, …)',
    type_display         LowCardinality(String)  COMMENT 'human display of the type',
    subtype              LowCardinality(String)  COMMENT 'account subtype (checking, savings, credit_card, …)',
    institution          String                  COMMENT 'linked institution name (empty for manual accounts)',
    mask                 String                  COMMENT 'last 4 digits of the account (no full number exists in the API)',
    is_asset             UInt8                   COMMENT '1 = asset, 0 = liability',
    is_manual            UInt8                   COMMENT '1 = manually tracked (not institution-synced)',
    is_hidden            UInt8                   COMMENT '1 = hidden in the Monarch UI',
    include_in_net_worth UInt8                   COMMENT '1 = counts toward net worth',
    current_balance      Float64                 COMMENT 'signed balance, USD: assets positive, liabilities NEGATIVE. Net worth = SUM(current_balance).',
    display_balance      Float64                 COMMENT 'UI balance: liability signs FLIPPED positive — do NOT sum for net worth; use current_balance',
    transactions_count   UInt32                  COMMENT 'number of transactions Monarch has for this account',
    created_at           DateTime64(3)           COMMENT 'account creation time in Monarch',
    updated_at           DateTime64(3)           COMMENT 'last update time in Monarch',
    raw                  String                  COMMENT 'full account JSON as observed'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(snapshot_ts)
ORDER BY (id, snapshot_ts)
TTL toDateTime(snapshot_ts) + INTERVAL 1095 DAY
COMMENT 'Monarch account balance snapshots (poll-based). Latest row per id = current balance: argMax(current_balance, snapshot_ts) GROUP BY id, or ORDER BY snapshot_ts DESC LIMIT 1 BY id.';
