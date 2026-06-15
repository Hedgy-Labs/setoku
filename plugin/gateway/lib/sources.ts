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
  ts: string; // freshness column
  blurb: string; // what it holds — so the agent knows when to reach for it
}

export const LAKE_SOURCES: LakeSource[] = [
  { table: "logs_vercel", source: "Vercel logs", ts: "ts", blurb: "Vercel platform logs — HTTP requests, build & runtime errors, status codes, latency (level=error/fatal are problems)" },
  { table: "logs_render", source: "Render logs", ts: "ts", blurb: "Render service logs — app stdout/stderr, deploy & runtime errors" },
  { table: "slack_messages", source: "Slack", ts: "event_ts", blurb: "Slack message archive — team chat history" },
  { table: "app_events", source: "First-party events", ts: "ts", blurb: "First-party product / analytics events emitted by the app" },
  { table: "mercury_accounts", source: "Mercury · accounts", ts: "snapshot_ts", blurb: "Bank account balances over time — cash on hand, runway (finance)" },
  { table: "mercury_transactions", source: "Mercury · transactions", ts: "created_at", blurb: "Bank transactions — spend, vendor/payroll payments, income (finance, runway, burn)" },
  { table: "mercury_events", source: "Mercury · webhooks", ts: "received_at", blurb: "Mercury webhook events" },
  { table: "ingest_raw", source: "Unrouted (raw)", ts: "ingested_at", blurb: "Raw ingest that didn't match a known schema (rarely queried directly)" },
];
