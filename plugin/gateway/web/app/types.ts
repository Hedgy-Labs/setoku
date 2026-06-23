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

/** A report published to the box. `body` is present only on a single-report
 *  fetch; the list omits it. Mirrors lib/store.ts. */
export interface PublishedMeta {
  id: string;
  title: string;
  format: "html";
  visibility: ReportVisibility;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
}
export interface PublishedReport extends PublishedMeta {
  body: string;
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
