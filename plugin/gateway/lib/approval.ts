// SPDX-License-Identifier: Apache-2.0
/**
 * The web approval surface (Phase 5.5/5.6 — the membrane's human side).
 *
 * This is the "outside the agent loop" accept path that I2/I9 require: a human
 * reads a pending proposal and clicks Approve/Reject. The action is an HTTP
 * POST from a browser form — NOT an MCP tool — so a prompt-injected agent can
 * never reach it, whatever its credential. Agents only ever *propose*
 * (report_correction → pending); knowledge enters curated context only here.
 *
 * AUTH (Phase 5.1 — local accounts, user/pass only): the page lives at a
 * fixed, secret-free URL (/admin) that is safe to share — an unauthenticated
 * visitor gets a login form. The human authenticates with a USERNAME +
 * PASSWORD (a local account, lib/accounts) — NOT their MCP bearer token. This
 * is the load-bearing separation: an agent holds a propose-only token and can
 * read it from its own config, but it never holds a human's password, so even
 * a shell-capable injected agent cannot authenticate here and self-approve
 * (I9). Login mints a server-side session bound to an
 * HttpOnly+Secure+SameSite=Strict cookie; the password never appears in a URL.
 * State lives in one process, so sessions are in-memory (restart → re-login).
 * CSRF: SameSite=Strict blocks cross-site posts, and every mutating form also
 * carries a per-session CSRF token. Accepting is role-gated to admins.
 *
 * SECURITY: correction content is attacker-influenceable (it can be distilled
 * from Slack/logs), so every dynamic value is HTML-escaped before rendering.
 */
import type { KnowledgeStore, KnowledgeDoc, DocType } from "./store";
import { canApprove } from "./accounts";

/** Escape for HTML text/attribute context. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
 * In-memory session store for the approval surface. The gateway is a single
 * process, so this is sufficient; sessions don't survive a restart (re-login).
 * The cookie carries an opaque random id — never the bearer token.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  constructor(private readonly ttlMs = 12 * 60 * 60 * 1000) {}

  create(identity: string, role: string): { sid: string; csrf: string } {
    const sid = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    const csrf = crypto.randomUUID();
    this.sessions.set(sid, {
      identity,
      role,
      csrf,
      expires: Date.now() + this.ttlMs,
    });
    return { sid, csrf };
  }

  get(sid: string | undefined): Session | null {
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.sessions.delete(sid);
      return null;
    }
    return s;
  }

  destroy(sid: string | undefined): void {
    if (sid) this.sessions.delete(sid);
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

/** Set-Cookie value for a new session (HttpOnly, Secure, SameSite=Strict). */
export function sessionSetCookie(sid: string): string {
  return `${COOKIE}=${encodeURIComponent(sid)}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=43200`;
}

/** Set-Cookie value that clears the session cookie. */
export function sessionClearCookie(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`;
}

/* ------------------------------ rendering ------------------------------ */

const PAGE_CSS = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1rem; margin-top: 2rem; color: #888; }
  .item { border: 1px solid #8884; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .meta { color: #888; font-size: 0.85rem; margin-bottom: 0.5rem; }
  .kind { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 4px; background: #8883; font-size: 0.8rem; }
  .content { white-space: pre-wrap; margin: 0.5rem 0; }
  form { display: inline; }
  button { font: inherit; padding: 0.35rem 0.9rem; border-radius: 6px; border: 1px solid #8886; cursor: pointer; }
  button.approve { background: #2e7d32; color: #fff; border-color: #2e7d32; }
  button.reject { background: transparent; }
  textarea, input[type=password] { width: 100%; box-sizing: border-box; margin: 0.4rem 0; font: inherit; padding: 0.4rem; }
  .empty { color: #888; }
  .note { color: #888; font-size: 0.85rem; border-left: 3px solid #8884; padding-left: 0.8rem; }
  .topbar { display: flex; justify-content: space-between; align-items: baseline; }
  nav.tabs { margin: 0.25rem 0 1.25rem; font-size: 0.9rem; }
  nav.tabs a, nav.tabs b { margin-right: 0.6rem; }
  nav.tabs b { color: inherit; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; border: 1px solid #8886; }
  .badge.ok { background: #2e7d3222; color: #2e7d32; border-color: #2e7d3266; }
  .badge.down { background: #c6282822; color: #c62828; border-color: #c6282866; }
  .badge.idle { color: #888; }
  table.grid { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  table.grid th { text-align: left; color: #888; font-weight: 500; border-bottom: 1px solid #8884; padding: 0.3rem 0.5rem; }
  table.grid td { padding: 0.35rem 0.5rem; border-bottom: 1px solid #8882; }
  details.doc { border: 1px solid #8884; border-radius: 8px; padding: 0.6rem 1rem; margin: 0.6rem 0; }
  details.doc summary { cursor: pointer; font-weight: 600; }
  details.doc .meta { margin: 0.5rem 0 0; }
  code.k { font-size: 0.8rem; background: #8882; padding: 0.05rem 0.3rem; border-radius: 4px; }
`;

function shell(title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${inner}</body></html>`;
}

/** Tab nav shared by every signed-in page; the active tab is bold, not a link. */
function nav(active: "pending" | "knowledge" | "sources" | "audit"): string {
  const tab = (href: string, label: string, key: string) =>
    key === active ? `<b>${esc(label)}</b>` : `<a href="${href}">${esc(label)}</a>`;
  return `<nav class="tabs">${tab("/admin", "Pending", "pending")}${tab(
    "/admin/knowledge",
    "Knowledge",
    "knowledge",
  )}${tab("/admin/sources", "Sources", "sources")}${tab("/admin/audit", "Audit", "audit")}</nav>`;
}

/** The sign-out form (carries the session CSRF token). */
function signoutForm(session: Session): string {
  return `<form method="POST" action="/admin/logout">
    <input type="hidden" name="csrf" value="${esc(session.csrf)}">
    <button type="submit">Sign out (${esc(session.identity)} · ${esc(session.role)})</button>
  </form>`;
}

/** The login form shown to anyone without a valid session (no secret in URL). */
export function renderLoginPage(flash?: string): string {
  return shell(
    "Setoku — sign in",
    `<h1>Setoku — sign in</h1>
<p class="meta">Sign in with your Setoku admin account to review pending
knowledge. This is a separate credential from the access token you give
Claude — agents never have it.</p>
${flash ? `<p class="note">${esc(flash)}</p>` : ""}
<form method="POST" action="/admin/login">
  <input type="text" name="username" placeholder="username" autocomplete="username" autofocus>
  <input type="password" name="password" placeholder="password" autocomplete="current-password">
  <button class="approve" type="submit">Sign in</button>
</form>`,
  );
}

/** The audit-log page (Phase 5.6) — who did what, newest first. */
export function renderAuditPage(store: KnowledgeStore, session: Session): string {
  const rows = store
    .listAudit(200)
    .map((r) => {
      let summary = r.payload;
      try {
        const p = JSON.parse(r.payload) as Record<string, unknown>;
        summary = Object.entries(p)
          .filter(([, v]) => v !== null && v !== "")
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(" · ");
      } catch {
        /* leave raw */
      }
      return `<tr><td>${esc(String(r.ts).slice(0, 19))}</td><td>${esc(r.user)}</td><td><code>${esc(r.tool)}</code></td><td>${esc(summary)}</td></tr>`;
    })
    .join("");
  return shell(
    "Setoku — audit log",
    `<div class="topbar"><h1>Setoku — audit log</h1>${signoutForm(session)}</div>
${nav("audit")}
<p class="meta">Append-only; newest first.</p>
<table style="width:100%;border-collapse:collapse;font-size:0.85rem">
<thead><tr style="text-align:left;color:#888"><th>when (UTC)</th><th>who</th><th>action</th><th>detail</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4" class="empty">No activity yet.</td></tr>'}</tbody>
</table>`,
  );
}

/** The pending-corrections approval page (requires a session). */
export function renderApprovalPage(
  store: KnowledgeStore,
  session: Session,
  flash?: string,
): string {
  const pending = store.listCorrections("pending");
  const csrf = esc(session.csrf);
  const mayApprove = canApprove(session.role);
  const actions = mayApprove
    ? `
      <form method="POST" action="/admin/resolve">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="id" value="ID">
        <textarea name="reason" rows="1" placeholder="reason (optional for approve, recommended for reject)"></textarea>
        <button class="approve" name="action" value="accepted">Approve</button>
        <button class="reject" name="action" value="rejected">Reject</button>
      </form>`
    : "";
  const items = pending
    .map(
      (c) => `
    <div class="item">
      <div class="meta">
        <span class="kind">${esc(c.kind)}</span>
        #${esc(c.id)} · proposed by ${esc(c.user)} · ${esc(String(c.ts).slice(0, 16))}${
          c.relatesTo ? ` · re: ${esc(c.relatesTo)}` : ""
        }
      </div>
      <div class="content">${esc(c.content)}</div>${actions.replace('value="ID"', `value="${esc(c.id)}"`)}
    </div>`,
    )
    .join("");

  return shell(
    "Setoku — pending knowledge",
    `<div class="topbar">
  <h1>Setoku — pending knowledge</h1>
  ${signoutForm(session)}
</div>
${nav("pending")}
<p class="meta">These are proposals from agents and teammates; nothing here is
curated until an admin approves it. Approving a gotcha folds it into verified
context immediately; other kinds are recorded for a curator session.</p>
${flash ? `<p class="note">${esc(flash)}</p>` : ""}
${mayApprove ? "" : '<p class="note">You are signed in as a <b>member</b> — viewing only. Ask an admin to approve.</p>'}
<h2>Pending (${pending.length})</h2>
${pending.length ? items : '<p class="empty">Nothing pending. 🎉</p>'}
<p class="note">This is the only path knowledge enters curated context (I2/I9):
a human clicks here, outside any agent. Agents can only propose.</p>`,
  );
}

/** Read-only browser for curated knowledge — "the memories". */
export function renderKnowledgePage(store: KnowledgeStore, session: Session): string {
  const docs = store.listDocs();
  const order: DocType[] = ["overview", "entity", "metric", "query", "gotcha"];
  const byType = new Map<string, KnowledgeDoc[]>();
  for (const d of docs) {
    const arr = byType.get(d.type) ?? [];
    arr.push(d);
    byType.set(d.type, arr);
  }
  const section = (type: string): string => {
    const list = (byType.get(type) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) return "";
    const items = list
      .map((d) => {
        const metaPairs = Object.entries(d.meta ?? {})
          .map(
            ([k, v]) =>
              `<code class="k">${esc(k)}</code> ${esc(Array.isArray(v) ? v.join(", ") : v)}`,
          )
          .join(" · ");
        const badge = d.verified
          ? '<span class="badge ok">verified</span>'
          : '<span class="badge idle">unverified</span>';
        return `<details class="doc">
      <summary>${esc(d.name)} ${badge}</summary>
      <div class="content">${esc(d.body)}</div>
      <div class="meta">${metaPairs ? metaPairs + " · " : ""}updated by ${esc(
        d.updatedBy ?? "—",
      )}${d.updatedAt ? " · " + esc(String(d.updatedAt).slice(0, 16)) : ""}</div>
    </details>`;
      })
      .join("");
    return `<h2>${esc(type)} (${list.length})</h2>${items}`;
  };
  const sections = order.map(section).join("");
  return shell(
    "Setoku — knowledge",
    `<div class="topbar"><h1>Setoku — knowledge</h1>${signoutForm(session)}</div>
${nav("knowledge")}
<p class="meta">Curated business context the analyst reads as ground truth — ${docs.length} doc(s).
Read-only here: curated edits come from a curator session, and corrections from anyone land in
<a href="/admin">Pending</a> for review.</p>
${docs.length ? sections : '<p class="empty">No curated knowledge yet. Run <code class="k">/setoku:generate</code>.</p>'}`,
  );
}

/* ------------------------------ sources ------------------------------ */

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

/** Read-only view of what's connected + whether data is flowing (gathered live). */
export function renderSourcesPage(session: Session, s: SourcesData): string {
  const badge = (ok: boolean, label?: string): string =>
    ok
      ? `<span class="badge ok">${esc(label ?? "connected")}</span>`
      : `<span class="badge down">${esc(label ?? "down")}</span>`;

  const pg = s.postgres;
  const pgBody = !pg.configured
    ? '<p class="empty">No business database configured.</p>'
    : `<table class="grid"><tbody>
      <tr><td>status</td><td>${
        pg.ok ? badge(true) : badge(false, "unreachable")
      }${pg.error ? ` <span class="meta">${esc(pg.error)}</span>` : ""}</td></tr>
      <tr><td>env var</td><td><code class="k">${esc(pg.envVar ?? "—")}</code></td></tr>
      ${pg.tableCount != null ? `<tr><td>tables in scope</td><td>${pg.tableCount}</td></tr>` : ""}
      ${
        pg.allow?.length
          ? `<tr><td>allow</td><td>${pg.allow
              .map((a) => `<code class="k">${esc(a)}</code>`)
              .join(" ")}</td></tr>`
          : ""
      }
    </tbody></table>`;

  const lake = s.lake;
  const lakeRows = lake.tables
    .map(
      (t) => `<tr>
      <td>${esc(t.source)}</td>
      <td>${t.rows == null ? "—" : Number(t.rows).toLocaleString("en-US")}</td>
      <td>${
        t.last ? esc(String(t.last).slice(0, 19)) + " UTC" : '<span class="badge idle">no data</span>'
      }</td>
    </tr>`,
    )
    .join("");
  const lakeBody = !lake.configured
    ? '<p class="empty">No data lake configured (SETOKU_LAKE_URL).</p>'
    : !lake.ok
      ? `<p>${badge(false, "unreachable")} <span class="meta">${esc(lake.error ?? "")}</span></p>`
      : `<p>${badge(true)}</p>
<table class="grid"><thead><tr><th>connector</th><th>rows</th><th>last ingest</th></tr></thead>
<tbody>${lakeRows || '<tr><td colspan="3" class="empty">no source tables</td></tr>'}</tbody></table>`;

  const k = s.knowledge;
  const kPairs =
    Object.entries(k.byType)
      .map(([t, n]) => `${esc(t)} ${n}`)
      .join(" · ") || "empty";

  return shell(
    "Setoku — sources",
    `<div class="topbar"><h1>Setoku — sources</h1>${signoutForm(session)}</div>
${nav("sources")}
<p class="meta">What's wired up and whether data is actually flowing. Read-only.</p>
<h2>Business database (Postgres)</h2>${pgBody}
<h2>Data lake (ClickHouse)</h2>${lakeBody}
<h2>Knowledge store</h2><p>${esc(String(k.docs))} curated doc(s) · ${kPairs}</p>
<p class="note">"Connected" means configured + reachable; per-connector rows and
last-ingest are read live from the lake on each load.</p>`,
  );
}

/* ------------------------------ action ------------------------------ */

/**
 * Apply a human approve/reject decision. Returns a flash message for the
 * redirect. The COMMIT happens here, driven by the human's POST — for an
 * accepted gotcha we fold it straight into curated context (a clean mapping);
 * other kinds are marked accepted and left for a curator session to shape into
 * a metric/entity doc (we don't synthesize structured docs from free text).
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
