// SPDX-License-Identifier: Apache-2.0
// Thin fetch wrapper over the gateway's /admin/api/* JSON endpoints. The session
// rides in the cookie (same-origin); mutations echo the CSRF token in a header.
import type {
  Me,
  Invite,
  NewLogin,
  Correction,
  CorrectionDraft,
  KnowledgeDoc,
  KnowledgeView,
  AuditRow,
  SourcesData,
  TeamData,
  Role,
  PublishedMeta,
  AppData,
} from "./types";

let csrf = "";
/** Stash the CSRF token after login / session fetch; sent on every mutation. */
export function setCsrf(token: string): void {
  csrf = token;
}

let onUnauthorized: (() => void) | null = null;
/**
 * Register a callback fired on ANY 401 from /admin/api/*. The auth layer uses it
 * to drop to the login screen when a session expires mid-use — otherwise the app
 * keeps rendering signed-in chrome over a dead session (a confusing dead-end).
 */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
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
    if (res.status === 401) onUnauthorized?.();
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
  rejected: () => req<Correction[]>("rejected"),
  // On accept, an optional edited draft is the doc-edit committed into context.
  resolve: (
    id: number,
    action: "accepted" | "rejected",
    reason?: string,
    draft?: CorrectionDraft,
  ) => req<MutationResult>("resolve", { method: "POST", body: { id, action, reason, draft } }),
  unreject: (id: number) => req<MutationResult>("unreject", { method: "POST", body: { id } }),
  knowledge: () => req<KnowledgeDoc[]>("knowledge"),
  knowledgeView: () => req<KnowledgeView>("knowledge_view"),
  sources: () => req<SourcesData>("sources"),
  audit: () => req<AuditRow[]>("audit"),
  team: () => req<TeamData>("team"),
  invite: (identity: string, rotate = false) =>
    req<MutationResult>("invite", { method: "POST", body: { identity, rotate } }),
  users: (op: string, username: string, role?: string) =>
    req<MutationResult>("users", { method: "POST", body: { op, username, role } }),
  apps: () => req<PublishedMeta[]>("published"),
  appData: (id: string, force = false) =>
    req<AppData>(`app_data?id=${encodeURIComponent(id)}${force ? "&force=1" : ""}`),
  rename: (id: string, title: string) =>
    req<MutationResult & { title?: string }>("rename", { method: "POST", body: { id, title } }),
  archive: (id: string) => req<MutationResult>("archive", { method: "POST", body: { id } }),
  unarchive: (id: string) => req<MutationResult>("unarchive", { method: "POST", body: { id } }),
  setVisibility: (id: string, visibility: "team" | "public") =>
    req<MutationResult>("set_visibility", { method: "POST", body: { id, visibility } }),
  // Per-app private state — read/write an app's OWN sandbox (never a business
  // source). Used by the AppView postMessage bridge, not pages directly.
  appStateList: (id: string, scope: "app" | "viewer") =>
    req<{ entries: { key: string; value: unknown; updatedAt: string }[] }>(
      `app_state?id=${encodeURIComponent(id)}&scope=${scope}`,
    ),
  appStateSet: (id: string, scope: "app" | "viewer", key: string, value: unknown) =>
    req<{ ok: boolean; entry: { key: string; value: unknown; updatedAt: string } }>("app_state", {
      method: "POST",
      body: { id, op: "set", scope, key, value },
    }),
  appStateDelete: (id: string, scope: "app" | "viewer", key: string) =>
    req<{ ok: boolean; deleted: boolean }>("app_state", {
      method: "POST",
      body: { id, op: "delete", scope, key },
    }),
};
