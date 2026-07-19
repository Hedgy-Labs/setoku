-- SPDX-License-Identifier: Apache-2.0
-- Personal Gmail messages (poll-based, format=full → plain-text body).
-- A message is MUTABLE (labels change: read/unread, archived, recategorized), so
-- the poller re-emits anything the History API reports and this is a
-- ReplacingMergeTree keyed by (account, message_id) with ingested_at as the
-- version — newest observation wins.
--
-- ⚠ subject / snippet / body / from_name are UNTRUSTED free text — anyone can
-- email you, so this is the single highest prompt-injection surface in the lake.
-- Treat as hostile downstream (same posture as slack_messages / github bodies).
-- SPAM + TRASH are never listed by the poller; auth/2FA/password-reset mail is
-- dropped at the poller BEFORE it lands here (zero query value, high liability).
--
-- ⚠ Merges are async: query with FINAL (or argMax / LIMIT 1 BY) for current
-- state — a message re-observed after a label change would otherwise appear twice.
--
-- Retention: an 18-month TTL on received_at self-prunes the archive so a family
-- box never hoards a lifetime of mail. Adjust the window here, not via a cron.
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
-- monthly partitions: the 18-month TTL caps this at ~19 live partitions, and a
-- 90-day backfill inserts across only ~4 — well under ClickHouse's 100-partitions
-- -per-insert-block limit even if the backfill window is later widened to years.
PARTITION BY toYYYYMM(received_at)
ORDER BY (account, message_id)
TTL toDateTime(received_at) + INTERVAL 18 MONTH
COMMENT 'Personal Gmail (poll-based). Mutable rows → query with FINAL. Untrusted free text; spam/trash & auth mail excluded; marketing flagged is_bulk; 18-mo retention.';
