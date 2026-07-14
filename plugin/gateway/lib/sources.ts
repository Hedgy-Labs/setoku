// SPDX-License-Identifier: Apache-2.0
/**
 * Lake tables Setoku knows how to surface — a friendly label, the column to read
 * freshness from, and a one-line description of what each holds. Shared by the
 * /admin Sources page (http.ts) and the `list_sources` MCP tool (app.ts) so the
 * agent and the operator see the same capability list.
 */
/** A connector beat within this window means "pipeline up" — the liveness
 *  signal shared by the /admin Sources page and list_sources. Pollers re-beat
 *  every ~4 minutes while healthy so long poll intervals stay inside it. */
export const BEAT_LIVE_MS = 10 * 60_000;

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

/** Lake plumbing tables that are NOT a deniable source: heartbeats power the
 *  liveness UI, and pg_mirror_runs is the mirror's run log (the biz.* business
 *  tables it describes are core, readable by every session). Direct grants on
 *  the ClickHouse reader cover these; family roles cover everything else. */
export const CORE_LAKE_TABLES = ["ingest_heartbeats", "pg_mirror_runs"] as const;

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

/* ---------------- source families + per-user access control ---------------- */

/** The family a source belongs to — the label prefix before " · " ("Mercury ·
 *  transactions" → "Mercury"); single-table sources are their own family. The
 *  same grouping the Sources page and list_sources draw. */
export function familyOf(label: string): string {
  return label.split(" · ")[0];
}

/** Stable slug for a family — the unit source_denies stores and the admin API
 *  speaks ("Vercel logs" → "vercel_logs"). */
export function familySlug(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The ClickHouse role that grants SELECT on one family's tables. Role names
 *  are pinned to deploy/clickhouse/lake-users.xml by a lint test — adding a
 *  connector means adding its family role there too. */
export function roleFor(slug: string): string {
  return `setoku_src_${slug}`;
}

/** A role that grants NOTHING, for the every-family-denied identity. The role
 *  parameter's empty-list case is a trap: appending zero `role` params is the
 *  same as omitting the parameter, which activates the DEFAULT roles — i.e.
 *  full access. Activating this empty role instead keeps the engine holding
 *  the line (the direct core grants — heartbeats + the mirror-run log — still
 *  apply; biz.* is a family role now, so it too is denied here). */
export const NO_SOURCES_ROLE = "setoku_src_none";

export interface LakeFamily {
  family: string;
  slug: string;
  role: string;
  /** ClickHouse database the family's tables live in (default "setoku"). The
   *  business-DB mirror family lives in "biz". */
  db: string;
  tables: string[];
}

/** The business-DB mirror as a deniable family. `biz.*` (one Postgres source
 *  per box, mirrored by pg-mirror) is the whole database, so it's a single
 *  all-or-nothing toggle labelled "Postgres". Its role carries `biz.*`; unlike
 *  the always-on core (heartbeats, mirror-run log) it is subsettable, so an
 *  admin can fence off the business data from a person the same way as a lake
 *  source. `db: "biz"` + `tables: ["*"]` → the grant target is `biz.*`. */
export const BUSINESS_FAMILY: LakeFamily = {
  family: "Postgres",
  slug: "business",
  role: roleFor("business"),
  db: "biz",
  tables: ["*"],
};

/** The deniable source families: LAKE_SOURCES grouped by family (minus the core
 *  plumbing in CORE_LAKE_TABLES — the mirror's run log and the heartbeats, which
 *  every session may read), plus the business-DB mirror as one "Postgres"
 *  family. ingest_raw IS deniable on purpose: unrouted rows can carry any
 *  source's payloads, so leaving it always-open would bypass a deny. */
export function lakeFamilies(): LakeFamily[] {
  const out = new Map<string, LakeFamily>();
  for (const s of LAKE_SOURCES) {
    if ((CORE_LAKE_TABLES as readonly string[]).includes(s.table)) continue;
    const family = familyOf(s.source);
    const slug = familySlug(family);
    let f = out.get(slug);
    if (!f) {
      f = { family, slug, role: roleFor(slug), db: "setoku", tables: [] };
      out.set(slug, f);
    }
    f.tables.push(s.table);
  }
  return [...out.values(), BUSINESS_FAMILY];
}

/** The GRANT targets a family's role carries, e.g. `["setoku.slack_messages"]`
 *  or `["biz.*"]` — the drift-lock test pins lake-users.xml to these. */
export function grantTargetsFor(f: LakeFamily): string[] {
  return f.tables.map((t) => `${f.db}.${t}`);
}

/**
 * The ClickHouse roles to activate for a session, from its identity's denied
 * family slugs. `null` = unrestricted → the caller omits the `role` parameter
 * entirely, so the reader's DEFAULT roles apply — which include every family
 * role, also ones added after this code shipped. That is what makes "opted
 * into everything, including new connectors" the durable default: a
 * restriction is an explicit role subset; absence of one is not a snapshot.
 *
 * SETOKU_SOURCE_ACCESS=0 is the rollout kill-switch (a box whose ClickHouse
 * predates the HTTP `role` parameter, 24.5): every session runs unrestricted.
 */
export function lakeRolesFor(denies: string[]): string[] | null {
  if (process.env.SETOKU_SOURCE_ACCESS === "0") return null;
  if (!denies.length) return null;
  const denied = new Set(denies);
  const roles = lakeFamilies()
    .filter((f) => !denied.has(f.slug))
    .map((f) => f.role);
  // Every family denied → NEVER return [] (zero role params = the default
  // roles = full access, the exact inversion of the intent).
  return roles.length ? roles : [NO_SOURCES_ROLE];
}
