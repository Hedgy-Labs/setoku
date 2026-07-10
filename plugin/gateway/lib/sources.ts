// SPDX-License-Identifier: Apache-2.0
/**
 * Lake tables Setoku knows how to surface — a friendly label, the column to read
 * freshness from, and a one-line description of what each holds. Shared by the
 * /admin Sources page (http.ts) and the `list_sources` MCP tool (app.ts) so the
 * agent and the operator see the same capability list.
 */
export interface LakeSource {
  table: string;
  source: string; // friendly label (also used by the /admin Sources page)
  ts: string; // freshness column (data recency — when business activity last landed)
  blurb: string; // what it holds — so the agent knows when to reach for it
  // Long-running connector that emits liveness beats into `ingest_heartbeats`.
  // When set, the Sources page reads "flowing" from the beat (pipeline is up)
  // rather than data recency — so a quiet-but-healthy source isn't false-"stale".
  // Omit for passive drains (log/webhook sinks) where data recency IS liveness.
  connector?: string;
}

export const LAKE_SOURCES: LakeSource[] = [
  { table: "logs_vercel", source: "Vercel logs", ts: "ts", blurb: "Vercel platform logs — HTTP requests, build & runtime errors, status codes, latency (level=error/fatal are problems)" },
  { table: "logs_render", source: "Render logs", ts: "ts", blurb: "Render service logs — app stdout/stderr, deploy & runtime errors", connector: "render-poller" },
  { table: "slack_messages", source: "Slack", ts: "event_ts", blurb: "Slack message archive — team chat history", connector: "slack-listener" },
  { table: "app_events", source: "First-party events", ts: "ts", blurb: "First-party product / analytics events emitted by the app" },
  { table: "mercury_accounts", source: "Mercury · accounts", ts: "snapshot_ts", blurb: "Bank account balances over time — cash on hand, runway (finance)", connector: "mercury-poller" },
  { table: "mercury_transactions", source: "Mercury · transactions", ts: "ingested_at", blurb: "Bank transactions — spend, vendor/payroll payments, income (finance, runway, burn)", connector: "mercury-poller" },
  { table: "mercury_events", source: "Mercury · webhooks", ts: "received_at", blurb: "Mercury webhook events" },
  { table: "github_issues", source: "GitHub · issues", ts: "ingested_at", blurb: "GitHub issues + PRs — titles, bodies, labels, state (mutable rows: query with FINAL)", connector: "github-poller" },
  { table: "github_pulls", source: "GitHub · pull requests", ts: "ingested_at", blurb: "Pull request detail — merge state, branches, draft (merged = merged_at IS NOT NULL; FINAL)", connector: "github-poller" },
  { table: "github_commits", source: "GitHub · commits", ts: "ingested_at", blurb: "Default-branch commits — authors, messages, timing (query with FINAL)", connector: "github-poller" },
  { table: "github_comments", source: "GitHub · comments", ts: "ingested_at", blurb: "Issue/PR discussion + code-review comments (query with FINAL)", connector: "github-poller" },
  { table: "monarch_accounts", source: "Monarch · accounts", ts: "snapshot_ts", blurb: "Monarch account balance snapshots — every linked bank/card/investment account over time (latest row per id = current balance)", connector: "monarch-poller" },
  { table: "monarch_transactions", source: "Monarch · transactions", ts: "ingested_at", blurb: "Personal-finance transactions — spend by category / merchant / account (mutable: query with FINAL)", connector: "monarch-poller" },
  { table: "monarch_net_worth", source: "Monarch · net worth", ts: "ingested_at", blurb: "Daily net-worth history — assets vs. liabilities per day (query with FINAL)", connector: "monarch-poller" },
  { table: "monarch_budgets", source: "Monarch · budgets", ts: "ingested_at", blurb: "Monthly budget vs. actual by category (query with FINAL)", connector: "monarch-poller" },
  { table: "monarch_holdings", source: "Monarch · holdings", ts: "snapshot_ts", blurb: "Investment holdings snapshots — positions and value per account over time", connector: "monarch-poller" },
  { table: "pg_mirror_runs", source: "Business-DB mirror", ts: "finished_at", blurb: "Reload history of the biz.* business-DB mirror — the mirrored tables themselves live in the biz database (query biz.<table>, clickhouse dialect)", connector: "pg-mirror" },
  { table: "ingest_raw", source: "Unrouted (raw)", ts: "ingested_at", blurb: "Raw ingest that didn't match a known schema (rarely queried directly)" },
];
