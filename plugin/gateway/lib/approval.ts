// SPDX-License-Identifier: Apache-2.0
/**
 * The approval surface's server-side core (Phase 5.5/5.6 — the membrane's human
 * side). Rendering now lives in the React SPA (web/app/*), which talks to the
 * JSON API in http.ts; this module holds the pieces that API needs:
 *
 * AUTH / SESSIONS (Phase 5.1 — local accounts, user/pass only): the human
 * authenticates with a USERNAME + PASSWORD (a local account, lib/accounts) — NOT
 * their MCP bearer token. This is the load-bearing separation: an agent holds a
 * propose-only token and can read it from its own config, but it never holds a
 * human's password, so even a shell-capable injected agent cannot authenticate
 * here and self-approve (I9). Login mints a server-side session bound to an
 * HttpOnly+Secure+SameSite=Strict cookie; the password never appears in a URL.
 * CSRF: SameSite=Strict blocks cross-site posts, and every mutating request also
 * carries a per-session CSRF token (sent by the SPA in an x-csrf-token header).
 *
 * COMMIT (applyApprovalAction): the human's accept/reject decision is applied
 * here, driven by their authenticated POST — outside any agent loop (I2/I9).
 */
import type { KnowledgeStore } from "./store";

/** kebab slug for a gotcha doc name derived from its content. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "gotcha"
  );
}

/* ------------------------------ sessions ------------------------------ */

export interface Session {
  identity: string;
  role: string;
  csrf: string;
  expires: number;
}

/**
 * Session store for the approval surface, backed by the KnowledgeStore (SQLite
 * on the durable volume) — NOT process memory — so a server restart/redeploy
 * does not sign everyone out. The cookie carries an opaque random id; the bearer
 * token never appears here.
 */
export class SessionStore {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly ttlMs = 12 * 60 * 60 * 1000,
  ) {}

  create(identity: string, role: string): { sid: string; csrf: string } {
    const sid = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    const csrf = crypto.randomUUID();
    this.store.createSession({ sid, identity, role, csrf, expires: Date.now() + this.ttlMs });
    return { sid, csrf };
  }

  get(sid: string | undefined): Session | null {
    if (!sid) return null;
    return this.store.getSession(sid);
  }

  destroy(sid: string | undefined): void {
    if (sid) this.store.destroySession(sid);
  }
}

const COOKIE = "setoku_session";

/** Read the session id from a Cookie header. */
export function sessionIdFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

// In production the session cookie is always Secure (HTTPS-only). For LOCAL dev
// over http://localhost, browsers (notably Safari) drop Secure cookies, so login
// would silently loop — `bun run dev:admin` sets SETOKU_COOKIE_INSECURE=1 to omit
// it. Never set this on a real deployment.
const secureAttr = (): string => (process.env.SETOKU_COOKIE_INSECURE === "1" ? "" : " Secure;");

/** Set-Cookie value for a new session (HttpOnly, Secure, SameSite=Strict). */
export function sessionSetCookie(sid: string): string {
  return `${COOKIE}=${encodeURIComponent(sid)}; HttpOnly;${secureAttr()} SameSite=Strict; Path=/admin; Max-Age=43200`;
}

/** Set-Cookie value that clears the session cookie. */
export function sessionClearCookie(): string {
  return `${COOKIE}=; HttpOnly;${secureAttr()} SameSite=Strict; Path=/admin; Max-Age=0`;
}

/* ------------------------------ shared types ------------------------------ */
// Returned by the JSON API and mirrored client-side in web/app/types.ts.

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

/** A freshly-minted invite, returned once so the admin can hand it to the teammate. */
export interface Invite {
  identity: string;
  token: string;
  installerUrl: string; // curl one-liner target, https://<host>/i/<token>
  mcpUrl: string; // https://<host>/mcp  (for the claude.ai custom connector)
  persisted: boolean; // false → lives in memory only, lost on restart
}

/* ------------------------------ action ------------------------------ */

/**
 * Apply a human approve/reject decision. Returns a flash message for the API to
 * relay. The COMMIT happens here, driven by the human's authenticated POST — for
 * an accepted gotcha we fold it straight into curated context (a clean mapping);
 * other kinds are marked accepted and left for a curator session to shape into a
 * metric/entity doc (we don't synthesize structured docs from free text).
 */
export function applyApprovalAction(
  store: KnowledgeStore,
  identity: string,
  params: { id: number; action: "accepted" | "rejected"; reason?: string },
): string {
  const { id, action, reason } = params;
  const pending = store.listCorrections("pending");
  const corr = pending.find((c) => c.id === id);
  if (!corr) return `#${id} is not pending (already resolved?).`;

  const ok = store.resolveCorrection(id, action, identity);
  if (!ok) return `#${id} could not be resolved (already resolved?).`;

  let folded = false;
  if (action === "accepted" && corr.kind === "gotcha") {
    store.upsertDoc(
      {
        type: "gotcha",
        name: slug(corr.content),
        body: corr.content,
        meta: corr.relatesTo ? { relates_to: corr.relatesTo } : {},
      },
      identity,
    );
    folded = true;
  }
  store.audit(identity, `approval_${action}`, {
    id,
    kind: corr.kind,
    folded,
    reason: reason || null,
  });

  if (action === "rejected") return `#${id} rejected.`;
  return folded
    ? `#${id} approved — folded into verified context.`
    : `#${id} approved (recorded; shape it into a doc in a curator session).`;
}
