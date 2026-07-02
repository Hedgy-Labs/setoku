-- SPDX-License-Identifier: Apache-2.0
-- GitHub discussion: issue/PR conversation comments (comment_type='issue' —
-- the issues comments API covers both, since every PR is an issue) and PR code
-- review comments (comment_type='review', which carry the file `path`).
-- Comments are editable → ReplacingMergeTree keyed by (repo, comment_type, id),
-- ingested_at version. Query with FINAL for current text / exact counts.
CREATE TABLE IF NOT EXISTS setoku.github_comments
(
    repo          LowCardinality(String)  COMMENT 'owner/repo',
    comment_type  LowCardinality(String)  COMMENT 'issue = conversation comment (issues AND PRs); review = PR code-review comment',
    id            UInt64                  COMMENT 'GitHub comment id',
    number        UInt32                  COMMENT 'issue/PR number the comment belongs to (joins github_issues.number)',
    author        LowCardinality(String)  COMMENT 'GitHub login of the commenter',
    body          String                  COMMENT 'comment text, capped at 50k chars (untrusted free text)',
    path          String                  COMMENT 'file the review comment is on (empty for conversation comments)',
    created_at    DateTime64(3)           COMMENT 'when posted',
    updated_at    DateTime64(3)           COMMENT 'last edit (GitHub-side)',
    html_url      String                  COMMENT 'deep link to the comment on GitHub',
    raw           String                  COMMENT 'full comment JSON as observed (body capped)',
    ingested_at   DateTime64(3)           COMMENT 'observation time — ReplacingMergeTree version (newest wins)'
)
ENGINE = ReplacingMergeTree(ingested_at)
-- toYear: full-history backfill in one insert block vs ClickHouse's 100-
-- partitions-per-block limit (see 050_github_issues.sql)
PARTITION BY toYear(created_at)
ORDER BY (repo, comment_type, id)
COMMENT 'GitHub issue/PR comments incl. code-review comments (poll-based). Editable rows → query with FINAL.';
