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
  flags: string[];
  updatedBy: string | null;
  updatedAt: string | null;
  proposedBy: string | null;
  uses: number;
}

export interface SubjectGroup {
  key: string;
  label: string;
  primaryType: string;
  members: KnowledgeMember[];
  flags: string[];
}

export interface KnowledgeView {
  docs: number;
  subjects: SubjectGroup[];
  health: { contradictions: number; duplicates: number; verbose: number; stale: number };
  contradictions: { kind: "contradiction"; subject: string; a: string; b: string; reason: string }[];
  merges: { kind: "merge"; a: string; b: string; subject: string; similarity: number; reason: string }[];
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

/** A dashboard panel's data binding (mirrors lib/store.ts DashboardPanel). */
export interface DashboardPanel {
  key: string;
  title?: string;
  sql: string;
  dialect: PanelDialect;
  metricId?: string | null;
}

/** A dashboard/report published to the box (list metadata; no body). A "dashboard"
 *  has live `panels`; a legacy "html" report has none. Mirrors lib/store.ts. */
export interface PublishedMeta {
  id: string;
  title: string;
  format: "html" | "dashboard";
  panels: DashboardPanel[] | null;
  refreshSeconds: number | null;
  visibility: ReportVisibility;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
}

/** One panel as the provenance drawer / viewer sees it (server: dashboardProvenance).
 *  `sql` is present only on the authenticated team surface. */
export interface PanelProvenance {
  key: string;
  title: string | null;
  dialect: PanelDialect;
  metricId: string | null;
  metric: { name: string; summary: string; body: string } | null;
  sql?: string;
  columns: string[];
  rowCount: number;
  computedAt: string | null;
  error: string | null;
  refreshError: string | null;
}

/** The team viewer's data: dashboard meta + freshly-rendered panel provenance.
 *  The panel ROWS render in the sandboxed /admin/frame/<id>; this is the chrome. */
export interface DashboardData {
  id: string;
  title: string;
  format: "html" | "dashboard";
  visibility: ReportVisibility;
  refreshSeconds: number | null;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
  updatedAt: string | null;
  panels: PanelProvenance[];
}

export interface SourceTable {
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
