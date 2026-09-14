-- SPDX-License-Identifier: Apache-2.0
-- Personal Gmail messages (poll-based, format=full → plain-text body).
-- ReplacingMergeTree keyed by (account, message_id) with ingested_at as the
-- version — newest observation wins.
--
-- ⚠ LABELS ARE AS-OF-INGEST, not live. The incremental sync uses the History API
-- with historyTypes=messageAdded, so a message's `labels` reflect its state when
-- first ingested; a POST-ingest reclassification (INBOX → SPAM/TRASH, archive,
-- read/unread) is NOT re-observed until a full resync (history-cursor expiry).
-- Practical consequence: a message that ARRIVES as spam/trash is excluded (see
-- below), but one that arrives in INBOX and is LATER marked spam stays queryable
-- with its stale labels until the retention TTL. Don't rely on `labels` for current
-- state. (Re-observing label changes is a known follow-up — see the poller README.)
--
-- ⚠ subject / snippet / body / from_name are UNTRUSTED free text — anyone can
-- email you, so this is the single highest prompt-injection surface in the lake.
-- Treat as hostile downstream (same posture as slack_messages / github bodies).
-- SPAM + TRASH are dropped at the poller (by label, on every path) BEFORE they
-- land here, as is auth/2FA/password-reset mail (zero query value, high liability).
--
-- ⚠ Merges are async: query with FINAL (or argMax / LIMIT 1 BY) for current
-- state — a message re-observed (e.g. on resync) would otherwise appear twice.
--
-- Retention: a 20-year TTL on received_at. The TTL exists so the table can never
-- grow without bound, NOT to trim history — a lifetime mailbox is the point, and
-- at ~2.6 KiB/message on disk even 200k messages is well under a gigabyte. Adjust
-- the window here, not via a cron.
--
-- ⚠ This file only runs on a FRESH ClickHouse (it is mounted into
-- /docker-entrypoint-initdb.d). Changing the TTL above does nothing to a box that
-- is already up — that needs an explicit
--   ALTER TABLE setoku.gmail_messages MODIFY TTL toDateTime(received_at) + INTERVAL 20 YEAR
-- against the running server.
--
-- NB: unlike the github/monarch sources there is NO `raw` catch-all column — the
-- raw MIME payload is the full body again (plus attachment bytes metadata), so
-- keeping it would double body storage and re-expose the untrusted text for no
-- repair value the parsed columns don't already give.
CREATE TABLE IF NOT EXISTS setoku.gmail_messages
(
    account         LowCardinality(String)  COMMENT 'mailbox this row came from (email address) — multi-account ready',
    message_id      String                  COMMENT 'Gmail message id (stable within a mailbox)',
    thread_id       String                  COMMENT 'Gmail thread id — groups a conversation',
    received_at     DateTime64(3)           COMMENT 'internalDate — when Gmail received the message',
    from_email      String                  COMMENT 'parsed From address (untrusted)',
    from_name       String                  COMMENT 'parsed From display name (untrusted free text)',
    to_emails       String                  COMMENT 'JSON array of To addresses',
    subject         String                  COMMENT 'Subject, capped 1k (untrusted free text)',
    snippet         String                  COMMENT 'Gmail-provided ~200-char preview (untrusted free text)',
    body            String                  COMMENT 'plain-text body, capped 50k (untrusted free text)',
    labels          String                  COMMENT 'JSON array of Gmail label ids (INBOX, CATEGORY_PROMOTIONS, …)',
    has_attachments UInt8                   COMMENT '1 = message carries a non-inline attachment',
    is_bulk         UInt8                   COMMENT '1 = List-Unsubscribe header present (marketing/newsletter) — filter with WHERE is_bulk = 0',
    ingested_at     DateTime64(3)           COMMENT 'observation time — ReplacingMergeTree version (newest wins)'
)
ENGINE = ReplacingMergeTree(ingested_at)
-- monthly partitions. A lifetime archive is ~200 live partitions, which is fine
-- for MergeTree; what matters is the 100-partitions-PER-INSERT-BLOCK limit, and
-- the poller cannot trip it: it walks history in bounded day-windows (default 30)
-- and flushes 200 rows at a time, so one insert block spans a month or two.
PARTITION BY toYYYYMM(received_at)
ORDER BY (account, message_id)
TTL toDateTime(received_at) + INTERVAL 20 YEAR
COMMENT 'Personal Gmail (poll-based). Mutable rows → query with FINAL. Untrusted free text; spam/trash & auth mail excluded; marketing flagged is_bulk; 20-yr retention.';
