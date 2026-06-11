-- SPDX-License-Identifier: Apache-2.0
-- Vercel log-drain rows (task 3.2). Field set verified against
-- https://vercel.com/docs/drains/reference/logs (2025-11 revision; I7 — re-check
-- on Vercel plan changes). Every column is documented: these comments become
-- provisioner-generated context docs in Phase 4 (task 4.6).
CREATE TABLE IF NOT EXISTS setoku.logs_vercel
(
    ts          DateTime64(3)            COMMENT 'log creation time (Vercel `timestamp`, ms epoch, UTC)',
    id          String                   COMMENT 'Vercel unique log entry id',
    source      LowCardinality(String)   COMMENT 'build | edge | lambda | static | external | firewall | redirect',
    level       LowCardinality(String)   COMMENT 'info | warning | error | fatal',
    project_id  String                   COMMENT 'Vercel projectId',
    deployment_id String                 COMMENT 'Vercel deploymentId',
    environment LowCardinality(String)   COMMENT 'production | preview (empty for build logs)',
    host        String                   COMMENT 'request hostname',
    request_path String                  COMMENT '`path` (function/dynamic path) or proxy.path incl. query',
    method      LowCardinality(String)   COMMENT 'HTTP method (proxy.method; empty for non-request logs)',
    status_code Int16                    COMMENT 'statusCode or proxy.statusCode; -1 = lambda crashed / bg revalidation; 0 = n/a',
    user_agent  String                   COMMENT 'first proxy.userAgent entry — REMEMBER: health checks and crawlers pollute traffic metrics',
    message     String                   COMMENT 'log message (truncated by Vercel above 256 KB)',
    raw         String                   COMMENT 'full original drain event JSON — nothing is dropped'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (source, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY  -- request logs are low-grade ore; default 90 d (README open question 3)
COMMENT 'Vercel log drain (POSTs NDJSON to /ingest/vercel). Gaps ≠ traffic dips: drains drop batches when the receiver is down.';
