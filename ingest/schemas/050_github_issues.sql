-- SPDX-License-Identifier: Apache-2.0
-- GitHub issues AND pull requests (the REST API returns both from the issues
-- endpoint; is_pr distinguishes them — PR-only fields live in github_pulls).
-- An issue is MUTABLE (open → closed, labels/bodies edited), so the poller
-- re-emits anything updated since its cursor and this is a ReplacingMergeTree
-- keyed by (repo, number) with ingested_at as the version — newest wins.
--
-- ⚠ Merges are async: query with FINAL (or argMax/LIMIT 1 BY) for current state,
-- same as mercury_transactions. Counts without FINAL can double-count.
CREATE TABLE IF NOT EXISTS setoku.github_issues
(
    repo            LowCardinality(String)  COMMENT 'owner/repo',
    id              UInt64                  COMMENT 'GitHub global issue id',
    number          UInt32                  COMMENT 'issue/PR number within the repo',
    is_pr           UInt8                   COMMENT '1 = this row is a pull request (details in github_pulls)',
    title           String                  COMMENT 'title (untrusted free text)',
    body            String                  COMMENT 'description body, capped at 50k chars (untrusted free text)',
    state           LowCardinality(String)  COMMENT 'open / closed',
    state_reason    LowCardinality(String)  COMMENT 'completed / not_planned / reopened / empty',
    author          LowCardinality(String)  COMMENT 'GitHub login of the opener',
    labels          String                  COMMENT 'JSON array of label names',
    assignees       String                  COMMENT 'JSON array of assignee logins',
    milestone       String                  COMMENT 'milestone title if any',
    comments_count  UInt32                  COMMENT 'comment count as of last observation',
    created_at      DateTime64(3)           COMMENT 'when opened',
    updated_at      DateTime64(3)           COMMENT 'last activity on the issue (GitHub-side)',
    closed_at       Nullable(DateTime64(3)) COMMENT 'when closed (null while open)',
    html_url        String                  COMMENT 'deep link to the issue on GitHub',
    raw             String                  COMMENT 'full issue JSON as observed (body capped)',
    ingested_at     DateTime64(3)           COMMENT 'observation time — ReplacingMergeTree version (newest wins)'
)
ENGINE = ReplacingMergeTree(ingested_at)
-- toYear, not toYYYYMM: the first-run backfill spans the repo's whole history
-- in one Vector insert block, and ClickHouse rejects blocks touching >100
-- partitions — yearly keeps a decades-old repo well under the limit.
PARTITION BY toYear(created_at)
ORDER BY (repo, number)
COMMENT 'GitHub issues + PRs (poll-based). Mutable rows → query with FINAL. is_pr=1 rows have PR detail in github_pulls.';
