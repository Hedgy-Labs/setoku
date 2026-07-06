-- SPDX-License-Identifier: Apache-2.0
-- Monarch investment portfolio breakdown: one row per (investment account,
-- security) captured each poll (the Web_GetHoldings / portfolio.aggregateHoldings
-- query). Append-only time series like monarch_accounts — the latest snapshot per
-- (account_id, security_id) is the current position; trend the series for value
-- over time. Query the latest cut with argMax(...) GROUP BY, or
-- ORDER BY snapshot_ts DESC LIMIT 1 BY (account_id, security_id).
--
-- `value` is market value (totalValue), `basis` is cost basis, `gain` = value −
-- basis (unrealized). `price` is the latest close. Values move with the market
-- but only actually update when Monarch syncs the account (see the daily
-- force-refresh). Schema verified against Web_GetHoldings (2026).
CREATE TABLE IF NOT EXISTS setoku.monarch_holdings
(
    snapshot_ts        DateTime64(3)           COMMENT 'when this position was observed (poll time)',
    account_id         String                  COMMENT 'owning investment account (→ monarch_accounts.id)',
    account_name       String                  COMMENT 'account display name at observation time',
    security_id        String                  COMMENT 'Monarch security id',
    ticker             LowCardinality(String)  COMMENT 'ticker symbol (empty for some manual/other holdings)',
    name               String                  COMMENT 'security name',
    type               LowCardinality(String)  COMMENT 'security type (equity, etf, mutual_fund, cryptocurrency, …)',
    type_display       LowCardinality(String)  COMMENT 'human display of the type',
    quantity           Float64                 COMMENT 'shares/units held',
    value              Float64                 COMMENT 'market value of the position, USD (totalValue)',
    basis              Float64                 COMMENT 'cost basis, USD',
    gain               Float64                 COMMENT 'unrealized gain = value − basis, USD',
    price              Float64                 COMMENT 'latest price per share (closing, falls back to current)',
    day_change_dollars Float64                 COMMENT 'position value change on the day, USD',
    day_change_pct     Float64                 COMMENT 'position value change on the day, percent',
    is_manual          UInt8                   COMMENT '1 = manually tracked holding',
    raw                String                  COMMENT 'full aggregateHoldings node JSON as observed'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(snapshot_ts)
ORDER BY (account_id, security_id, snapshot_ts)
TTL toDateTime(snapshot_ts) + INTERVAL 1095 DAY
COMMENT 'Monarch investment holdings (poll-based snapshots). Latest per (account_id, security_id) = current portfolio. value=market, basis=cost, gain=unrealized. Total portfolio = sum(value) over the latest snapshot.';
