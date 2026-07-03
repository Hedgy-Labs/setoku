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
import type { Correction, CorrectionDraft, KnowledgeStore } from "./store";

/**
 * Short, word-boundary name for a gotcha doc. Avoids the mid-word truncation of a
 * naive 48-char slice (which produced names like "…c2c-are-exc"). When the
 * proposal says what it relates to, prefix with that so the doc reads cleanly and
 * sorts near its subject; the actual grouping is by `meta.relates_to` (facts.ts).
 */
function gotchaDocName(relatesTo: string | null | undefined, fact: string): string {
  const words = (s: string, n: number): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, n)
      .join("-");
  return [relatesTo ? words(relatesTo, 3) : "", words(fact, 6)].filter(Boolean).join("-") || "gotcha";
}

/**
 * The drafted doc-edit a correction would commit on accept (curation-cockpit
 * piece A/B). Order of precedence: an explicit draft persisted on the row
 * (auto-draft job, piece B) wins; otherwise we synthesize the obvious default —
 * for a `gotcha` that's the long-standing fold (concise fact → a gotcha doc);
 * for other kinds we have no model-free way to synthesize a structured doc, so
 * there is no default draft until the auto-draft job (or a human in the cockpit)
 * supplies one. Returns null when nothing can be drafted yet.
 *
 * Pure + model-free (I8) — it never commits, so it's safe to call when merely
 * RENDERING the pending queue (the cockpit shows this as the editable draft).
 */
export function defaultDraft(corr: Correction): CorrectionDraft | null {
  if (corr.status === "pending" && corr.draft) return corr.draft;
  if (corr.kind === "gotcha") {
    // store only the concise FACT as knowledge (#10, avenue 1); the supporting
    // context stays in the corrections record, not the gotcha doc.
    const knowledge = corr.fact?.trim() || corr.content;
    const meta: Record<string, string | string[]> = { proposed_by: corr.user };
    if (corr.relatesTo) meta.relates_to = corr.relatesTo;
    return {
      type: "gotcha",
      name: gotchaDocName(corr.relatesTo, knowledge),
      body: knowledge,
      meta,
    };
  }
  return null;
}

/* ------------------------------ sessions ------------------------------ */

export interface Session {
  identity: string;
  role: string;
  csrf: string;
  expires: number;
}

// Session lifetime is a SLIDING 14-day window: each authenticated request slides
// the expiry forward, so an active admin stays signed in ("once per device") and
// only a full 14 days of inactivity forces a fresh login. The cookie's Max-Age
// (below) mirrors this so the browser keeps the cookie just as long.
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Don't write a renewal on every single request (the SPA polls): only slide the
// window once it's drifted by more than a day. Cheap, and still effectively
// "infinite while in use" against a 14-day window.
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Session store for the approval surface, backed by the KnowledgeStore (SQLite
 * on the durable volume) — NOT process memory — so a server restart/redeploy
 * does not sign everyone out. The cookie carries an opaque random id; the bearer
 * token never appears here.
 */
export class SessionStore {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly ttlMs = SESSION_TTL_MS,
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

  /**
   * Slide a live session's expiry forward by the full TTL. Throttled — a no-op
   * unless the window has drifted more than RENEW_AFTER_MS. Returns true when it
   * actually renewed, so the caller knows to re-issue the cookie.
   */
  renew(sid: string | undefined, session: Session): boolean {
    if (!sid) return false;
    const freshlyIssuedAt = session.expires - this.ttlMs;
    if (Date.now() - freshlyIssuedAt < RENEW_AFTER_MS) return false;
    this.store.touchSession(sid, Date.now() + this.ttlMs);
    return true;
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
  return `${COOKIE}=${encodeURIComponent(sid)}; HttpOnly;${secureAttr()} SameSite=Strict; Path=/admin; Max-Age=${SESSION_TTL_MS / 1000}`;
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

// Per-source daily ingestion, last ~30 days (Sources sparklines + trends chart).
// Days with zero rows are omitted; the client fills gaps across each series'
// own [min, max] range. Mirrors the client copy in web/app/types.ts.
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
 * relay. The COMMIT happens here, driven by the human's authenticated POST.
 *
 * On ACCEPT we upsert the DRAFTED doc into curated context for ALL kinds, not
 * just gotchas (curation-cockpit piece A.1 — closes the "accept does nothing for
 * a non-gotcha" gap). The draft is, in order of precedence: the one the human
 * edited in the cockpit (params.draft), else the draft the auto-draft job
 * persisted on the row, else the synthesized default (gotcha fold). If no draft
 * exists for a non-gotcha kind, we still mark it accepted but commit nothing —
 * the same "shape it in a curator session" message as before, until the
 * auto-draft job fills it in. Either way the membrane holds: this commit happens
 * only behind the human's password-gated POST (I2/I9).
 */
export function applyApprovalAction(
  store: KnowledgeStore,
  identity: string,
  params: {
    id: number;
    action: "accepted" | "rejected";
    draft?: CorrectionDraft;
    reason?: string;
  },
): string {
  const { id, action, draft, reason } = params;
  const corr = store.getCorrection(id);
  if (!corr || corr.status !== "pending") return `#${id} is not pending (already resolved?).`;

  if (action === "rejected") {
    // a human reject stays a soft, audited status change (not a bot reject)
    const ok = store.rejectCorrection(id, reason || "", identity, false);
    if (!ok) return `#${id} could not be resolved (already resolved?).`;
    store.audit(identity, "approval_rejected", { id, kind: corr.kind, reason: reason || null });
    return `#${id} rejected.`;
  }

  const ok = store.resolveCorrection(id, action, identity);
  if (!ok) return `#${id} could not be resolved (already resolved?).`;

  // commit the drafted doc-edit (the cockpit edit wins, else persisted/default)
  const effective = draft ?? defaultDraft(corr);
  let committed = false;
  if (effective) {
    // attribution: the doc's updated_by (= identity, the approver) records who
    // accepted it; the draft's meta.proposed_by records who originally proposed.
    const meta: Record<string, string | string[]> = { ...(effective.meta ?? {}) };
    if (!meta.proposed_by) meta.proposed_by = corr.user;
    store.upsertDoc(
      { type: effective.type, name: effective.name, body: effective.body, meta },
      identity,
    );
    committed = true;
  }
  store.audit(identity, "approval_accepted", {
    id,
    kind: corr.kind,
    committed,
    doc: committed && effective ? `${effective.type}:${effective.name}` : null,
    reason: reason || null,
  });

  return committed && effective
    ? `#${id} approved — committed [${effective.type}] ${effective.name} to verified context.`
    : `#${id} approved (recorded; no draft yet — shape it into a doc in a curator session or run the auto-draft job).`;
}
