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
  { table: "logs_render", source: "Render logs", ts: "ts", blurb: "Render service logs — app stdout/stderr, deploy & runtime errors" },
  { table: "slack_messages", source: "Slack", ts: "event_ts", blurb: "Slack message archive — team chat history", connector: "slack-listener" },
  { table: "app_events", source: "First-party events", ts: "ts", blurb: "First-party product / analytics events emitted by the app" },
  { table: "mercury_accounts", source: "Mercury · accounts", ts: "snapshot_ts", blurb: "Bank account balances over time — cash on hand, runway (finance)" },
  { table: "mercury_transactions", source: "Mercury · transactions", ts: "ingested_at", blurb: "Bank transactions — spend, vendor/payroll payments, income (finance, runway, burn)" },
  { table: "mercury_events", source: "Mercury · webhooks", ts: "received_at", blurb: "Mercury webhook events" },
  { table: "github_issues", source: "GitHub · issues", ts: "ingested_at", blurb: "GitHub issues + PRs — titles, bodies, labels, state (mutable rows: query with FINAL)" },
  { table: "github_pulls", source: "GitHub · pull requests", ts: "ingested_at", blurb: "Pull request detail — merge state, branches, draft (merged = merged_at IS NOT NULL; FINAL)" },
  { table: "github_commits", source: "GitHub · commits", ts: "ingested_at", blurb: "Default-branch commits — authors, messages, timing (query with FINAL)" },
  { table: "github_comments", source: "GitHub · comments", ts: "ingested_at", blurb: "Issue/PR discussion + code-review comments (query with FINAL)" },
  { table: "ingest_raw", source: "Unrouted (raw)", ts: "ingested_at", blurb: "Raw ingest that didn't match a known schema (rarely queried directly)" },
];

/** Business-DB mirror tables (the pg-mirror connector, issue #47) can't be a
 *  static list — one `biz_*` table appears per mirrored Postgres table, per
 *  tenant. Callers discover them (SHOW TABLES LIKE 'biz\_%'), drop the
 *  `__staging` work tables, and synthesize a LakeSource per table here so the
 *  Sources page / list_sources treat mirrors like any other connector. */
export const MIRROR_TABLE_PREFIX = "biz_";
export const MIRROR_STAGING_SUFFIX = "__staging";
export const MIRROR_CONNECTOR = "pg-mirror";

export function isMirrorTable(name: string): boolean {
  return name.startsWith(MIRROR_TABLE_PREFIX) && !name.endsWith(MIRROR_STAGING_SUFFIX);
}

export function mirrorLakeSource(table: string): LakeSource {
  const pgName = table.slice(MIRROR_TABLE_PREFIX.length);
  return {
    table,
    source: `Business DB · ${pgName}`,
    ts: "_mirrored_at",
    blurb: `Scheduled full-reload mirror of the business-Postgres table "${pgName}" — the fast venue for big aggregations; freshness in _mirrored_at`,
    connector: MIRROR_CONNECTOR,
  };
}
