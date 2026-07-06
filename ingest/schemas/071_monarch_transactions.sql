-- SPDX-License-Identifier: Apache-2.0
-- Monarch Money transactions. Like Mercury, a Monarch transaction is MUTABLE:
-- it moves pending → posted, gets recategorized, the merchant is renamed, notes
-- change. So the poller re-emits a rolling window every tick and this table is a
-- ReplacingMergeTree keyed by id with `ingested_at` as the version — the newest
-- observation of each transaction wins after a background merge.
--
-- ⚠ Because merges are async, a naive SELECT can briefly show two versions of a
-- just-updated row. Query with FINAL (… FROM setoku.monarch_transactions FINAL …)
-- or argMax/LIMIT 1 BY id to read current state. Sums over `amount` likewise want
-- FINAL to avoid double-counting an in-flight update.
--
-- `amount` is SIGNED (Monarch's convention): negative = money out (expense),
-- positive = money in (income/refund). `hide_from_reports` = 1 marks transactions
-- the user excludes from spend/income reports (transfers, reimbursements) — mirror
-- that exclusion when computing spend. `category`/`merchant`/`notes` are untrusted
-- free text. Schema verified against GetTransactionsList (2026).
CREATE TABLE IF NOT EXISTS setoku.monarch_transactions
(
    id                 String                  COMMENT 'Monarch transaction id (stable across edits)',
    account_id         String                  COMMENT 'owning account id (→ monarch_accounts.id)',
    account_name       String                  COMMENT 'account display name at observation time',
    amount             Float64                 COMMENT 'signed amount, USD: negative = out/expense, positive = in/income',
    date               Date                    COMMENT 'transaction date (accounting date, not post time)',
    pending            UInt8                   COMMENT '1 = still pending',
    category_id        String                  COMMENT 'Monarch category id',
    category           LowCardinality(String)  COMMENT 'category name (untrusted; user-editable)',
    merchant           String                  COMMENT 'merchant name (untrusted free text)',
    merchant_id        String                  COMMENT 'Monarch merchant id when present',
    plaid_name         String                  COMMENT 'raw name from the institution/Plaid feed',
    notes              String                  COMMENT 'user note (untrusted free text)',
    tags               String                  COMMENT 'comma-separated user tag names',
    is_recurring       UInt8                   COMMENT '1 = flagged recurring',
    is_split           UInt8                   COMMENT '1 = a split transaction',
    needs_review       UInt8                   COMMENT '1 = flagged for review',
    hide_from_reports  UInt8                   COMMENT '1 = excluded from spend/income reports (transfers etc.)',
    created_at         DateTime64(3)           COMMENT 'when Monarch created the record',
    updated_at         DateTime64(3)           COMMENT 'last edit time in Monarch',
    raw                String                  COMMENT 'full transaction JSON as observed',
    ingested_at        DateTime64(3)           COMMENT 'observation time — ReplacingMergeTree version (newest wins)'
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(date)
ORDER BY (id)
COMMENT 'Monarch transactions (poll-based, rolling window). Mutable rows → query with FINAL. amount is signed (negative = out); exclude hide_from_reports=1 for spend/income.';
