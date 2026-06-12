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

/** Set-Cookie value for a new session (HttpOnly, Secure, SameSite=Strict). */
export function sessionSetCookie(sid: string): string {
  return `${COOKIE}=${encodeURIComponent(sid)}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=43200`;
}

/** Set-Cookie value that clears the session cookie. */
export function sessionClearCookie(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`;
}

/* ------------------------------ rendering ------------------------------ */

// Stylesheet URL, content-versioned by the server at startup (?v=<hash>) so a
// CSS change busts the browser cache — without it, clients serve stale CSS
// against new HTML for up to the cache lifetime. Default (unversioned) is used
// by the local preview, which inlines the CSS anyway.
let stylesheetHref = "/admin/app.css";
export function setStylesheetHref(href: string): void {
  stylesheetHref = href;
}

function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${stylesheetHref}">
</head>
<body class="min-h-screen bg-stone-950 font-sans text-stone-100 antialiased">${inner}</body></html>`;
}

type Tab = "pending" | "knowledge" | "sources" | "audit";

/** The brand mark (white square). */
function brand(size = "h-7 w-7 text-xs"): string {
  return `<div class="grid ${size} place-items-center rounded-lg bg-white font-bold text-stone-900">S</div>`;
}

/** Tab nav shared by every signed-in page; the active tab is highlighted. */
function nav(active: Tab): string {
  const tab = (href: string, label: string, key: Tab) =>
    `<a href="${href}" class="tab${key === active ? " tab-active" : ""}">${esc(label)}</a>`;
  return `<nav class="flex items-center gap-1">${tab("/admin", "Pending", "pending")}${tab(
    "/admin/knowledge",
    "Knowledge",
    "knowledge",
  )}${tab("/admin/sources", "Sources", "sources")}${tab("/admin/audit", "Audit", "audit")}</nav>`;
}

/** Sticky top bar: brand, nav, identity, and the sign-out form (carries CSRF). */
function topbar(session: Session, active: Tab): string {
  return `<header class="sticky top-0 z-10 border-b border-stone-800 bg-stone-950/80 backdrop-blur">
  <div class="mx-auto flex max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
    <a href="/admin" class="flex items-center gap-2">${brand()}<span class="font-semibold">Setoku</span></a>
    ${nav(active)}
    <div class="ml-auto flex items-center gap-3">
      <span class="hidden text-xs text-stone-500 sm:inline">${esc(session.identity)} · ${esc(session.role)}</span>
      <form method="POST" action="/admin/logout">
        <input type="hidden" name="csrf" value="${esc(session.csrf)}">
        <button type="submit" class="btn btn-ghost">Sign out</button>
      </form>
    </div>
  </div>
</header>`;
}

/** Signed-in page chrome: top bar + centered content column. */
function page(session: Session, active: Tab, title: string, body: string): string {
  return shell(
    title,
    `${topbar(session, active)}<main class="mx-auto max-w-4xl px-5 py-8">${body}</main>`,
  );
}

/** A page heading with an optional sub line (sub may contain trusted HTML). */
function heading(title: string, sub?: string): string {
  return `<div class="mb-5"><h1 class="text-xl font-semibold tracking-tight">${esc(title)}</h1>${
    sub ? `<p class="mt-1 text-sm leading-relaxed text-stone-400">${sub}</p>` : ""
  }</div>`;
}

/** A neutral flash banner (escaped). */
function flashBanner(flash?: string): string {
  return flash
    ? `<div class="mb-4 rounded-lg border border-stone-700 bg-stone-800/50 px-3 py-2 text-sm text-stone-300">${esc(flash)}</div>`
    : "";
}

/** The login card shown to anyone without a valid session (no secret in URL). */
export function renderLoginPage(flash?: string): string {
  return shell(
    "Setoku — sign in",
    `<main class="flex min-h-screen items-center justify-center p-6">
  <div class="card w-full max-w-sm p-7">
    <div class="mb-5 flex items-center gap-2">${brand("h-8 w-8 text-sm")}<h1 class="text-lg font-semibold">Setoku</h1></div>
    <p class="mb-5 text-sm leading-relaxed text-stone-400">Sign in to review pending
    knowledge. This is a separate credential from the access token you give
    Claude — agents never have it.</p>
    ${flashBanner(flash)}
    <form method="POST" action="/admin/login" class="space-y-3">
      <input class="input" type="text" name="username" placeholder="username" autocomplete="username" autofocus>
      <input class="input" type="password" name="password" placeholder="password" autocomplete="current-password">
      <button class="btn btn-primary w-full" type="submit">Sign in</button>
    </form>
  </div>
</main>`,
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
      return `<tr class="border-b border-stone-800/60 last:border-0">
      <td class="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-stone-500">${esc(String(r.ts).slice(0, 19))}</td>
      <td class="px-4 py-2.5 text-stone-300">${esc(r.user)}</td>
      <td class="px-4 py-2.5"><code class="kbd">${esc(r.tool)}</code></td>
      <td class="px-4 py-2.5 text-stone-400">${esc(summary)}</td>
    </tr>`;
    })
    .join("");
  return page(
    session,
    "audit",
    "Setoku — audit log",
    `${heading("Audit log", "Append-only; newest first.")}
<div class="card overflow-x-auto">
  <table class="w-full text-left text-sm">
    <thead><tr class="border-b border-stone-800 text-xs uppercase tracking-wide text-stone-500">
      <th class="px-4 py-2.5 font-medium">when (UTC)</th><th class="px-4 py-2.5 font-medium">who</th><th class="px-4 py-2.5 font-medium">action</th><th class="px-4 py-2.5 font-medium">detail</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="px-4 py-4 text-stone-500">No activity yet.</td></tr>'}</tbody>
  </table>
</div>`,
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
  const actionForm = (id: number): string =>
    mayApprove
      ? `<form method="POST" action="/admin/resolve" class="mt-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="id" value="${esc(id)}">
        <input class="input min-w-[12rem] flex-1" name="reason" placeholder="reason (optional for approve, recommended for reject)">
        <button class="btn btn-primary" name="action" value="accepted">Approve</button>
        <button class="btn btn-ghost" name="action" value="rejected">Reject</button>
      </form>`
      : "";
  const items = pending
    .map(
      (c) => `<div class="card p-4">
      <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <span class="badge badge-idle">${esc(c.kind)}</span>
        <span class="font-mono text-stone-400">#${esc(c.id)}</span>
        <span>proposed by ${esc(c.user)} · ${esc(String(c.ts).slice(0, 16))}${
          c.relatesTo ? ` · re: ${esc(c.relatesTo)}` : ""
        }</span>
      </div>
      <div class="whitespace-pre-wrap text-sm leading-relaxed text-stone-200">${esc(c.content)}</div>
      ${actionForm(c.id)}
    </div>`,
    )
    .join("");

  return page(
    session,
    "pending",
    "Setoku — pending knowledge",
    `${heading(
      "Pending knowledge",
      "Proposals from agents and teammates. Nothing is curated until an admin approves it — this is the only path into verified context, and agents can only propose.",
    )}
${flashBanner(flash)}
${
  mayApprove
    ? ""
    : '<div class="mb-4 rounded-lg border border-stone-700 bg-stone-800/40 px-3 py-2 text-sm text-stone-400">You are signed in as a <b class="text-stone-200">member</b> — viewing only. Ask an admin to approve.</div>'
}
<div class="mb-3 text-xs font-medium uppercase tracking-wide text-stone-500">Pending (${pending.length})</div>
<div class="space-y-3">${pending.length ? items : '<div class="card p-8 text-center text-stone-500">Nothing pending. 🎉</div>'}</div>`,
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
              `<code class="kbd">${esc(k)}</code> ${esc(Array.isArray(v) ? v.join(", ") : v)}`,
          )
          .join(" · ");
        const badge = d.verified
          ? '<span class="badge badge-ok">verified</span>'
          : '<span class="badge badge-idle">unverified</span>';
        return `<details class="card group">
      <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-medium text-stone-200 [&::-webkit-details-marker]:hidden">
        <span class="text-stone-500 transition group-open:rotate-90">›</span>
        <span class="flex-1">${esc(d.name)}</span>${badge}
      </summary>
      <div class="border-t border-stone-800 px-4 py-3">
        <div class="whitespace-pre-wrap text-sm leading-relaxed text-stone-300">${esc(d.body)}</div>
        <div class="mt-3 text-xs text-stone-500">${metaPairs ? metaPairs + " · " : ""}updated by ${esc(
          d.updatedBy ?? "—",
        )}${d.updatedAt ? " · " + esc(String(d.updatedAt).slice(0, 16)) : ""}</div>
      </div>
    </details>`;
      })
      .join("");
    return `<section class="mb-6"><h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">${esc(
      type,
    )} (${list.length})</h2><div class="space-y-2">${items}</div></section>`;
  };
  const sections = order.map(section).join("");
  return page(
    session,
    "knowledge",
    "Setoku — knowledge",
    `${heading(
      "Knowledge",
      `Curated business context the analyst reads as ground truth — ${docs.length} doc(s). Read-only here: curated edits come from a curator session, and corrections land in <a class="font-medium text-stone-100 underline decoration-stone-600 underline-offset-2 hover:decoration-stone-300" href="/admin">Pending</a> for review.`,
    )}
${docs.length ? sections : '<div class="card p-8 text-center text-stone-500">No curated knowledge yet. Run <code class="kbd">/setoku:generate</code>.</div>'}`,
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

type SourceStatus = { color: "green" | "yellow" | "red"; label: string };

/** Parse a lake timestamp ("2026-06-12 19:25:52.036", UTC) to epoch ms. */
function lakeTsToMs(s: string | null | undefined): number | null {
  if (!s) return null;
  let t = s.includes("T") ? s : s.replace(" ", "T");
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(t)) t += "Z";
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

/** Compact "3m ago" / "2h ago" / "5d ago" from a lake timestamp. */
function relTime(s: string | null | undefined): string {
  const ms = lakeTsToMs(s);
  if (ms == null) return "";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Freshness → status: green if data within 24h, yellow if stale/empty. */
function freshnessStatus(rows: number | null, last: string | null): SourceStatus {
  if (!rows || !last) return { color: "yellow", label: "no data" };
  const ms = lakeTsToMs(last);
  if (ms != null && Date.now() - ms < 24 * 60 * 60 * 1000)
    return { color: "green", label: "flowing" };
  return { color: "yellow", label: "stale" };
}

/** Read-only view of what's connected + whether data is flowing (gathered live). */
export function renderSourcesPage(session: Session, s: SourcesData): string {
  // one detail key/value line
  const kv = (k: string, v: string): string =>
    `<div class="flex items-start justify-between gap-4 py-1.5"><span class="text-stone-500">${esc(
      k,
    )}</span><span class="text-right text-stone-200">${v}</span></div>`;
  // one expandable source row: name + relative time + colored status dot
  const sourceRow = (
    name: string,
    status: SourceStatus,
    last: string | null,
    detail: string,
  ): string => {
    const rel = relTime(last);
    return `<details class="card group">
    <summary class="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
      <span class="shrink-0 text-stone-500 transition group-open:rotate-90">›</span>
      <span class="min-w-0 flex-1 truncate font-medium text-stone-100">${esc(name)}</span>
      ${rel ? `<span class="shrink-0 text-xs text-stone-500">${esc(rel)}</span>` : ""}
      <span class="status status-${status.color} shrink-0"><span class="dot dot-${status.color}"></span>${esc(status.label)}</span>
    </summary>
    <div class="border-t border-stone-800 px-4 py-2.5 text-sm">${detail}</div>
  </details>`;
  };

  const rows: string[] = [];

  // Business database (Postgres)
  const pg = s.postgres;
  if (!pg.configured) {
    rows.push(
      sourceRow("Business database (Postgres)", { color: "yellow", label: "not configured" }, null, kv("note", "no SETOKU_DATABASE_URL")),
    );
  } else {
    const status: SourceStatus = pg.ok
      ? { color: "green", label: "healthy" }
      : { color: "red", label: "unreachable" };
    const detail =
      (pg.error ? kv("error", `<span class="text-red-400">${esc(pg.error)}</span>`) : kv("status", "reachable")) +
      kv("env var", `<code class="kbd">${esc(pg.envVar ?? "—")}</code>`) +
      (pg.tableCount != null ? kv("tables in scope", String(pg.tableCount)) : "") +
      (pg.allow?.length ? kv("allow", pg.allow.map((a) => `<code class="kbd">${esc(a)}</code>`).join(" ")) : "");
    rows.push(sourceRow("Business database (Postgres)", status, null, detail));
  }

  // Data lake connectors
  const lake = s.lake;
  if (lake.configured && !lake.ok) {
    rows.push(
      sourceRow("Data lake (ClickHouse)", { color: "red", label: "unreachable" }, null, kv("error", `<span class="text-red-400">${esc(lake.error ?? "unreachable")}</span>`)),
    );
  } else if (lake.configured) {
    for (const t of lake.tables) {
      const detail =
        kv("rows", t.rows == null ? "—" : Number(t.rows).toLocaleString("en-US")) +
        kv("last ingest", t.last ? `${esc(String(t.last).slice(0, 19))} UTC` : "—");
      rows.push(sourceRow(t.source, freshnessStatus(t.rows, t.last), t.last, detail));
    }
  }

  // Knowledge store
  const k = s.knowledge;
  const kStatus: SourceStatus = k.docs > 0 ? { color: "green", label: "healthy" } : { color: "yellow", label: "empty" };
  const kDetail =
    kv("documents", String(k.docs)) +
    Object.entries(k.byType)
      .map(([t, n]) => kv(t, String(n)))
      .join("");
  rows.push(sourceRow("Knowledge store", kStatus, null, kDetail));

  return page(
    session,
    "sources",
    "Setoku — sources",
    `${heading("Sources", "What's connected and whether data is flowing — click a source to expand. Read-only, refreshed live on each load.")}
<div class="space-y-2">${rows.join("")}</div>
<div class="mt-5 flex items-center gap-4 text-xs text-stone-500">
  <span class="status status-green"><span class="dot dot-green"></span>flowing</span>
  <span class="status status-yellow"><span class="dot dot-yellow"></span>stale / empty</span>
  <span class="status status-red"><span class="dot dot-red"></span>down</span>
</div>`,
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
