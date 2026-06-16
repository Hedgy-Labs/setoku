// SPDX-License-Identifier: Apache-2.0
// Thin fetch wrapper over the gateway's /admin/api/* JSON endpoints. The session
// rides in the cookie (same-origin); mutations echo the CSRF token in a header.
import type {
  Me,
  Invite,
  NewLogin,
  Correction,
  KnowledgeDoc,
  KnowledgeView,
  AuditRow,
  SourcesData,
  TeamData,
  Role,
} from "./types";

let csrf = "";
/** Stash the CSRF token after login / session fetch; sent on every mutation. */
export function setCsrf(token: string): void {
  csrf = token;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = csrf;
  const res = await fetch(`/admin/api/${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (data && typeof data.error === "string" && data.error) || `HTTP ${res.status}`;
    throw new ApiError(message, res.status, data);
  }
  return data as T;
}

export interface LoginResult {
  ok: boolean;
  identity: string;
  role: Role;
  csrf: string;
}
export interface MutationResult {
  ok: boolean;
  flash?: string;
  invite?: Invite;
  newLogin?: NewLogin;
}

export const api = {
  session: () => req<Me>("session"),
  login: (username: string, password: string) =>
    req<LoginResult>("login", { method: "POST", body: { username, password } }),
  logout: () => req<{ ok: boolean }>("logout", { method: "POST" }),
  pending: () => req<Correction[]>("pending"),
  resolve: (id: number, action: "accepted" | "rejected", reason?: string) =>
    req<MutationResult>("resolve", { method: "POST", body: { id, action, reason } }),
  knowledge: () => req<KnowledgeDoc[]>("knowledge"),
  knowledgeView: () => req<KnowledgeView>("knowledge_view"),
  sources: () => req<SourcesData>("sources"),
  audit: () => req<AuditRow[]>("audit"),
  team: () => req<TeamData>("team"),
  invite: (identity: string, rotate = false) =>
    req<MutationResult>("invite", { method: "POST", body: { identity, rotate } }),
  users: (op: string, username: string, role?: string) =>
    req<MutationResult>("users", { method: "POST", body: { op, username, role } }),
};
