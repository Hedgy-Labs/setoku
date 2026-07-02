<!-- SPDX-License-Identifier: Apache-2.0 -->
# github-poller

GitHub → Setoku ingest bridge (pull-based). Polls issues, pull requests,
default-branch commits, and issue/review comments for the repos in
`GITHUB_REPOS`, and POSTs NDJSON to Vector's `/ingest/github/*` on the
internal network. Modeled on `ingest/mercury-poller` (see its README for the
pull-bridge rationale).

## Why poll instead of webhooks

- Backfill: the first tick pulls the full issue/PR/comment history (commits
  bounded by `GITHUB_BACKFILL_DAYS`); a webhook only sees events after setup.
- No public endpoint: the poller runs on the compose network and talks
  outbound only, so there's no Caddy route or webhook secret to manage.
- Mutability: issues/PRs/comments change after creation (state, labels,
  edits). The poller re-emits anything updated since its cursor and the lake
  tables are `ReplacingMergeTree` — the newest observation wins. **Query with
  `FINAL`.**

Cursors overlap by 10 minutes on purpose (a fetch racing an update would
otherwise lose it); the ReplacingMergeTree absorbs the duplicate emits. Each
page is pushed to Vector as it's fetched (bounded memory), and a cursor only
advances after a fully-clean pass — a mid-walk failure keeps the cursor and the
next tick re-covers the window. State lives on the `github_state` volume so
restarts don't re-backfill.

Two API quirks worth knowing (both verified against the official REST docs,
2026-07): the `pulls` list endpoint has no `since` parameter, so PRs are walked
sorted by `updated desc` and the walk stops at the cursor; and the commits
`since` filter is by *committer date*, so a merge that lands old-dated commits
after the cursor passed won't ingest them — `github_pulls` (merge events) is
the reliable "what shipped" record.

## Credential

A **fine-grained personal access token**, read-only, scoped to just the
watched repos: Contents (read), Issues (read), Pull requests (read),
Metadata (read). It lives only in the box's `/opt/setoku/.env`, never in a
repo. Rate limits are a non-issue: 5,000 requests/hour vs. a handful per tick.

## Env

| var | default | |
|---|---|---|
| `GITHUB_TOKEN` | — | required, fine-grained read-only PAT |
| `GITHUB_REPOS` | — | required, comma-separated `owner/repo` list |
| `GITHUB_VECTOR_URL` | `http://vector:8080` | base; ingest paths appended |
| `GITHUB_POLL_INTERVAL_MS` | `300000` | 5 min |
| `GITHUB_BACKFILL_DAYS` | `730` | first-run commit lookback |
| `GITHUB_STATE_DIR` | `/state` | cursor file location |

## Enable on a box

```bash
# /opt/setoku/.env
GITHUB_TOKEN=github_pat_…
GITHUB_REPOS=acme/widgets,acme/api
COMPOSE_PROFILES=lake,ingest,…,github   # append github

# apply the lake schemas by hand (initdb only runs on a fresh volume)
for f in ingest/schemas/05*_github_*.sql; do
  docker compose exec -T clickhouse clickhouse-client < "$f"
done

docker compose up -d vector                      # pick up the new routes/sinks
docker compose --profile github up -d --build github-poller
docker compose logs -f github-poller             # watch the backfill tick
```
