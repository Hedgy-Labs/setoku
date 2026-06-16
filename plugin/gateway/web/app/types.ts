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
  content: string;
  relatesTo: string | null;
  status: string;
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

export interface SourceTable {
  source: string;
  rows: number | null;
  last: string | null;
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
