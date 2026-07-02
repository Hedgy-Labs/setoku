-- SPDX-License-Identifier: Apache-2.0
-- GitHub pull requests — the PR-specific fields (merge state, branches, draft)
-- that the issues endpoint doesn't carry. Join to github_issues on (repo, number)
-- for labels/body/comments. Mutable (open → merged/closed, draft → ready), so
-- ReplacingMergeTree keyed by (repo, number), ingested_at version — query with
-- FINAL for current state.
--
-- "Merged" = merged_at IS NOT NULL. A closed PR with null merged_at was
-- closed WITHOUT merging — don't count it as shipped.
CREATE TABLE IF NOT EXISTS setoku.github_pulls
(
    repo         LowCardinality(String)  COMMENT 'owner/repo',
    id           UInt64                  COMMENT 'GitHub global PR id',
    number       UInt32                  COMMENT 'PR number within the repo (joins github_issues.number)',
    title        String                  COMMENT 'title (untrusted free text)',
    state        LowCardinality(String)  COMMENT 'open / closed (closed includes merged — check merged_at)',
    draft        UInt8                   COMMENT '1 = draft PR',
    author       LowCardinality(String)  COMMENT 'GitHub login of the PR author',
    base_ref     String                  COMMENT 'target branch (e.g. main)',
    head_ref     String                  COMMENT 'source branch',
    created_at   DateTime64(3)           COMMENT 'when opened',
    updated_at   DateTime64(3)           COMMENT 'last activity on the PR (GitHub-side)',
    closed_at    Nullable(DateTime64(3)) COMMENT 'when closed (null while open)',
    merged_at    Nullable(DateTime64(3)) COMMENT 'when merged — null means not merged (even if closed)',
    html_url     String                  COMMENT 'deep link to the PR on GitHub',
    raw          String                  COMMENT 'full PR JSON as observed (body capped)',
    ingested_at  DateTime64(3)           COMMENT 'observation time — ReplacingMergeTree version (newest wins)'
)
ENGINE = ReplacingMergeTree(ingested_at)
-- toYear: full-history backfill in one insert block vs ClickHouse's 100-
-- partitions-per-block limit (see 050_github_issues.sql)
PARTITION BY toYear(created_at)
ORDER BY (repo, number)
COMMENT 'GitHub pull requests (poll-based). Mutable rows → query with FINAL. merged = merged_at IS NOT NULL.';
