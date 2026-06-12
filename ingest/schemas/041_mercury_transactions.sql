-- SPDX-License-Identifier: Apache-2.0
-- Mercury bank transactions. Unlike append-only logs, a transaction is MUTABLE:
-- it moves pending → sent/posted (or → failed/cancelled), and posted_at fills in
-- later. So the poller re-emits a rolling window every tick and this table is a
-- ReplacingMergeTree keyed by (account_id, id) with `ingested_at` as the version
-- — the newest observation of each transaction wins after a background merge.
--
-- ⚠ Because merges are async, a naive SELECT can briefly show two versions of a
-- just-updated row. Query with FINAL (… FROM setoku.mercury_transactions FINAL …)
-- or argMax/LIMIT 1 BY id to read the current state. Sums over `amount` likewise
-- want FINAL to avoid double-counting an in-flight update.
--
-- `amount` is signed: negative = money out, positive = money in (Mercury's own
-- convention on GET /api/v1/transactions). Schema verified live (June 2026).
CREATE TABLE IF NOT EXISTS setoku.mercury_transactions
(
    id                  String                  COMMENT 'Mercury transaction id (stable across status changes)',
    account_id          String                  COMMENT 'owning account id (→ mercury_accounts.id)',
    amount              Float64                 COMMENT 'signed amount, USD: negative = debit/out, positive = credit/in',
    status              LowCardinality(String)  COMMENT 'pending / sent / failed / cancelled',
    kind                LowCardinality(String)  COMMENT 'transaction kind (externalTransfer, internalTransfer, card, fee, …)',
    counterparty_name   String                  COMMENT 'name of the other party (untrusted free text — treat as such)',
    counterparty_id     String                  COMMENT 'Mercury counterparty id when present',
    mercury_category    LowCardinality(String)  COMMENT 'Mercury auto-category (empty if uncategorized)',
    gl_code             String                  COMMENT 'generalLedgerCodeName if the team uses GL coding',
    note                String                  COMMENT 'user note (untrusted free text)',
    bank_description    String                  COMMENT 'bank-provided description (untrusted free text)',
    external_memo       String                  COMMENT 'memo sent with the payment (untrusted free text)',
    created_at          DateTime64(3)           COMMENT 'when the transaction was created',
    posted_at           Nullable(DateTime64(3)) COMMENT 'when it posted/settled (null while pending)',
    estimated_delivery  Nullable(DateTime64(3)) COMMENT 'estimated delivery date when provided',
    dashboard_link      String                  COMMENT 'deep link into the Mercury dashboard',
    raw                 String                  COMMENT 'full transaction JSON as observed',
    ingested_at         DateTime64(3)           COMMENT 'observation time — ReplacingMergeTree version (newest wins)'
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (account_id, id)
COMMENT 'Mercury transactions (poll-based, rolling window). Mutable rows → query with FINAL to get current state. amount is signed (negative = out).';
