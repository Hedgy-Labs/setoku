// SPDX-License-Identifier: Apache-2.0
// Client mirrors of the JSON the gateway's /admin/api/* endpoints return. Kept in
// sync by hand with the server shapes in http.ts / lib/approval.ts / lib/store.ts.

export type Role = "admin" | "member";

export interface Me {
  identity: string;
  role: Role;
  csrf: string;
}

export interface Person {
  identity: string;
  hasToken: boolean;
  used: boolean;
  /** Connector is pinned in SETOKU_TOKENS env (legacy — Remove only revokes it
   *  until the next restart). */
  envBacked: boolean;
  role?: Role;
}

export interface TeamData {
  people: Person[];
  adminCount: number;
}

export interface Invite {
  identity: string;
  token: string;
  installerUrl: string;
  mcpUrl: string;
  /** Always true (tokens are DB-backed now); kept for wire compat. */
  persisted: boolean;
}

export interface NewLogin {
  username: string;
  role: string;
  tempPassword: string;
}

/** The exact upsert payload approving a correction would commit (cockpit). */
export interface CorrectionDraft {
  type: string;
  name: string;
  body: string;
  meta: Record<string, string | string[]>;
}

export interface Correction {
  id: number;
  ts: string;
  user: string;
  kind: string;
  /** Supporting context (the fuller text); for legacy proposals, the whole blob. */
  content: string;
  /** The concise claim to store (#10, avenue 1); null for legacy proposals. */
  fact: string | null;
  relatesTo: string | null;
  status: string;
  /** The drafted doc-edit approving this would commit; null = undrafted. */
  draft: CorrectionDraft | null;
  /** Advisory flags: dupe, contradiction, lint, provenance. */
  flags: string[];
  draftedBy: string | null;
  draftedTs: string | null;
  /** True when the auto-reject janitor (not a human) rejected it. */
  rejectedByBot: boolean;
  rejectReason: string | null;
}

export interface KnowledgeMember {
  name: string;
  type: string;
  claim: string;
  body: string;
  verified: boolean;
  /** Per-doc flags: "conflict", "duplicate", "verbose", "orphan". */
  flags: string[];
  updatedBy: string | null;
  updatedAt: string | null;
  proposedBy: string | null;
  uses: number;
  /** Outbound links (doc names this one references). */
  links: string[];
  /** Backlinks (doc names that reference this one). */
  backlinks: string[];
}

export interface SubjectGroup {
  key: string;
  label: string;
  primaryType: string;
  members: KnowledgeMember[];
  flags: string[];
}

export interface KnowledgeHealth {
  contradictions: number;
  duplicates: number;
  verbose: number;
  stale: number;
  /** Canonical docs disconnected from the link graph. */
  orphans: number;
  /** Doc pairs that look like they should link but don't. */
  suggestedLinks: number;
  /** Declared links that point at no existing doc. */
  brokenLinks: number;
}

export interface KnowledgeView {
  docs: number;
  subjects: SubjectGroup[];
  health: KnowledgeHealth;
  contradictions: { kind: "contradiction"; subject: string; a: string; b: string; reason: string }[];
  merges: { kind: "merge"; a: string; b: string; subject: string; similarity: number; reason: string }[];
  orphans: { kind: "orphan"; ref: string; subject: string; reason: string }[];
  connections: { kind: "connection"; a: string; b: string; similarity: number; reason: string }[];
  brokenLinks: { from: string; ref: string }[];
}

export interface KnowledgeDoc {
  type: string;
  name: string;
  meta: Record<string, string | string[]>;
  body: string;
  verified: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface AuditRow {
  ts: string;
  user: string | null;
  tool: string;
  payload: string;
}

export type ReportVisibility = "team" | "public";
export type PanelDialect = "postgres" | "clickhouse";

/** A app panel's data binding (mirrors lib/store.ts AppPanel). */
export interface AppPanel {
  key: string;
  title?: string;
  description?: string;
  sql: string;
  dialect: PanelDialect;
  metricId?: string | null;
}

/** An app published to the box (list metadata; no body). `format` is always
 *  "app" now (the legacy raw-served "html" format is gone); a data app has live
 *  `panels`, a static one has none. Mirrors lib/store.ts. */
export interface PublishedMeta {
  id: string;
  title: string;
  format: "html" | "app";
  panels: AppPanel[] | null;
  refreshSeconds: number | null;
  visibility: ReportVisibility;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
}

/** One panel as the team provenance drawer sees it (server: appProvenance).
 *  Team-only — the public surface exposes no calculations. */
export interface PanelProvenance {
  key: string;
  title: string | null;
  description: string | null;
  dialect: PanelDialect;
  metricId: string | null;
  metricSummary: string | null;
  sql: string;
  rowCount: number;
  computedAt: string | null;
  error: string | null;
  refreshError: string | null;
  /** Serving stale rows while a background refresh runs (SWR). */
  refreshing: boolean;
  /** Wall-clock ms of the run that produced the rows (null on legacy cache). */
  durationMs: number | null;
}

/** A declared interactive input (mirrors lib/params.ts AppParam). The viewer's
 *  value is bound into a panel's SQL; the control bar renders one widget each. */
export interface AppParam {
  name: string;
  label?: string;
  type: "date" | "int" | "text" | "bool" | "enum";
  default: string | number | boolean;
  options?: { value: string; label?: string }[];
  min?: number;
  max?: number;
  maxLength?: number;
}

/** The team viewer's data: app meta + freshly-rendered panel provenance.
 *  The panel ROWS render in the sandboxed /admin/frame/<id>; this is the chrome. */
export interface AppData {
  id: string;
  title: string;
  format: "html" | "app";
  visibility: ReportVisibility;
  refreshSeconds: number | null;
  params: AppParam[];
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
  updatedAt: string | null;
  /** Business-DB mirror freshness ("data as of") when clickhouse panels read biz.* tables. */
  mirrorAsOf?: string | null;
  /** Newest version's editor + timestamp, and total version count (#58). The
   *  header shows "edited by X · Ns ago" once the app has been edited (versions > 1). */
  editedBy?: string;
  editedAt?: string;
  versions?: number;
  panels: PanelProvenance[];
}

/** One saved version of an app (issue #58), newest first. Mirrors the server's
 *  AppRevisionMeta + a `current` flag the /app_history endpoint stamps on the
 *  live (newest) version. Body-less — a restore fetches it server-side. */
export interface AppRevision {
  seq: number;
  editor: string;
  note: string | null;
  ts: string;
  title: string;
  hasPanels: boolean;
  /** Which fields differ from the CURRENT live app ("title" | "content" | "data"
   *  | "inputs" | "refresh") — so a restore isn't blind. Empty for the current
   *  version. */
  changes: string[];
  /** True for the version currently live at the app's link. */
  current: boolean;
}

export interface SourceTable {
  table: string; // lake table name (stable key; labels are display-only)
  source: string;
  rows: number | null;
  last: string | null; // data recency: max(freshness column)
  beat?: string | null; // last connector liveness beat, when the source has a connector
}

export interface SourcesData {
  postgres: {
    configured: boolean;
    envVar?: string;
    ok: boolean;
    tableCount?: number;
    error?: string;
    allow?: string[];
  };
  lake: { configured: boolean; ok: boolean; error?: string; tables: SourceTable[] };
  knowledge: { docs: number; byType: Record<string, number> };
}

// Per-source daily ingestion, last ~30 days — powers the Sources sparklines and
// the /sources/trends chart. Days with zero rows are omitted (sparse); the client
// fills the gaps across each series' own [min, max] day range.
export interface SourceSeriesPoint {
  day: string; // YYYY-MM-DD (UTC)
  rows: number;
}
export interface SourceSeries {
  source: string; // matches SourceTable.source
  points: SourceSeriesPoint[];
}
export interface SourceSeriesData {
  series: SourceSeries[];
}

// The mirror's source-egress ledger (what pg-mirror pulled out of the business
// DB, the thing hosted-Postgres vendors bill) + the daily Slack-alert threshold.
export interface EgressDay {
  day: string; // YYYY-MM-DD (UTC)
  bytes: number;
}
export interface EgressData {
  days: EgressDay[];
  todayBytes: number;
  thresholdBytes: number | null; // null = alerts disabled
  configured: boolean; // false: lake unreachable or the mirror never ran
  appId: string | null; // the built-in "Mirror egress" app, when seeded and live
}
