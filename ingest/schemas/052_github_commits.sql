-- SPDX-License-Identifier: Apache-2.0
-- GitHub commits on the default branch (the poller doesn't pass a sha, so the
-- commits API lists the default branch only). ⚠ The poller's `since` filter is
-- by COMMITTER date, so a merge/rebase that lands old-dated commits after the
-- cursor passed will miss them here — their PR is still in github_pulls, which
-- is the reliable "what shipped" record. Commits are immutable, but a force-push can
-- re-observe a sha, and cursor overlap re-emits recent ones — ReplacingMergeTree
-- keyed by (repo, sha) absorbs both. Query with FINAL for exact counts.
CREATE TABLE IF NOT EXISTS setoku.github_commits
(
    repo          LowCardinality(String)  COMMENT 'owner/repo',
    sha           String                  COMMENT 'commit sha',
    author_login  LowCardinality(String)  COMMENT 'GitHub login of the author (empty if unmapped)',
    author_name   String                  COMMENT 'git author name',
    author_email  String                  COMMENT 'git author email',
    message       String                  COMMENT 'commit message, capped at 50k chars (untrusted free text)',
    committed_at  DateTime64(3)           COMMENT 'committer date',
    html_url      String                  COMMENT 'deep link to the commit on GitHub',
    raw           String                  COMMENT 'full commit JSON as observed (message capped)',
    ingested_at   DateTime64(3)           COMMENT 'observation time — ReplacingMergeTree version (newest wins)'
)
ENGINE = ReplacingMergeTree(ingested_at)
-- toYear for consistency with the other github tables (and the same >100-
-- partitions-per-insert-block headroom if BACKFILL_DAYS is ever raised)
PARTITION BY toYear(committed_at)
ORDER BY (repo, sha)
COMMENT 'GitHub default-branch commits (poll-based). Query with FINAL for exact counts (cursor overlap re-emits).';
