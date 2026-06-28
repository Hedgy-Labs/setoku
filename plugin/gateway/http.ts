#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Setoku MCP gateway — HTTP entry (deployed profile, v1).
 *
 * One container per company. Streamable-HTTP MCP transport with bearer-token
 * auth: each token maps to an identity, which flows into the shared knowledge
 * store's audit log. Stateless per-request server instances (the SQLite store
 * is the shared state); knowledge survives restarts on the volume.
 *
 * Env:
 *   SETOKU_PROJECT_DIR  — dir containing .setoku/config.json (+ optional context seed)
 *   SETOKU_DB_PATH      — knowledge store path (put it on the persistent volume)
 *   SETOKU_TOKENS         — analyst tokens (propose-only): "tok1=alice@co.com,tok2=bob@co.com"
 *   SETOKU_CURATOR_TOKENS — curator tokens (can commit curated knowledge, but are
 *                           blocked from reading the lake): same "tok=identity" shape.
 *                           For /setoku:generate + /setoku:curate; keep off analyst machines.
 *   SETOKU_JANITOR_TOKENS — janitor tokens (auto-draft/auto-reject job): draft + reject
 *                           ONLY, both granting zero authority — never upsert/accept.
 *                           Same "tok=identity" shape; for the cockpit's drafting cadence.
 *   SETOKU_TOKENS_FILE    — optional JSON file { "token": "identity", ... } (merged, analyst)
 *   SETOKU_HTTP_PORT    — default 8787
 *   <dataSource.urlEnv> — the Postgres URL env var named in config.json
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer } from "./app";
import { EmbedIndex } from "./lib/embed-index";
import { loadConfig, resolveProjectDir } from "./lib/config";
import {
  KnowledgeStore,
  defaultDbPath,
  seedFromFiles,
  type CorrectionDraft,
  type PublishedMeta,
  type PublishedReport,
} from "./lib/store";
import { newestComputedAt, renderDashboard, type RenderedPanel } from "./lib/dashboards";
import { DASHBOARD_RUNTIME } from "./lib/dashboard-runtime";
import {
  type Invite,
  applyApprovalAction,
  defaultDraft,
  SessionStore,
  sessionIdFromCookie,
  sessionSetCookie,
  sessionClearCookie,
  type SourcesData,
  type SourceTable,
} from "./lib/approval";
import { authenticate, canApprove, hashPassword, isRole } from "./lib/accounts";
import { buildKnowledgeView } from "./lib/facts";
import { VERSION } from "./lib/version";
import { resolveDatabaseUrl, resolveLakeUrl } from "./lib/config";
import { introspectSchema } from "./lib/db";
import { runLakeQuery } from "./lib/lake";

const projectDir = resolveProjectDir();

// Vendored Tailwind stylesheet for /admin (built from web/input.css → web/app.css,
// committed; rebuild with `bun run build:admin-css`). Read once at startup; served
// at /admin/app.css so the surface has no runtime external dependency.
const ADMIN_CSS = ((): string => {
  try {
    return fs.readFileSync(path.join(import.meta.dir, "web", "app.css"), "utf8");
  } catch {
    return "";
  }
})();
// Content-version the stylesheet URL so a CSS change busts the browser cache.
// The link becomes /admin/app.css?v=<hash>; since the URL changes with content,
// the response can be cached immutably (no stale CSS against new HTML).
const ADMIN_CSS_VER = Bun.hash(ADMIN_CSS).toString(36);

// The /admin React bundle (web/app/main.tsx → web/dist/app.js, committed; rebuild
// with `bun run build:admin-js`). Read once at startup, content-versioned like the
// CSS, and served at /admin/app.js so the surface has no runtime external dependency.
const ADMIN_JS = ((): string => {
  try {
    return fs.readFileSync(path.join(import.meta.dir, "web", "dist", "app.js"), "utf8");
  } catch {
    return "";
  }
})();
const ADMIN_JS_VER = Bun.hash(ADMIN_JS).toString(36);

// The single-page-app shell: a static document that boots the React app. It holds
// no data and no secrets — the app fetches /admin/api/session and renders login
// when unauthenticated — so it's safe to serve for every /admin route (deep links
// included; client-side routing takes over once the bundle loads).
const ADMIN_SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setoku — admin</title>
<link rel="stylesheet" href="/admin/app.css?v=${ADMIN_CSS_VER}">
</head>
<body class="min-h-screen bg-stone-50 font-sans text-stone-900 antialiased">
<div id="root"></div>
<script type="module" src="/admin/app.js?v=${ADMIN_JS_VER}"></script>
</body></html>`;

function storePath(): string {
  const res = loadConfig(projectDir);
  if (res.ok && typeof res.config.knowledgeDb === "string") {
    const p = res.config.knowledgeDb;
    return path.isAbsolute(p) ? p : path.join(projectDir, p);
  }
  return defaultDbPath(projectDir);
}

interface TokenInfo {
  identity: string;
  /** curator tokens may commit curated knowledge but cannot read the lake. */
  curator: boolean;
  /**
   * Janitor tokens (the auto-draft/auto-reject job, curation-cockpit B/C). They
   * hold ONLY draft + reject capabilities — both of which grant zero knowledge
   * authority — never `upsert_context` or any accept path. So even though the
   * janitor reads untrusted pending content, it cannot commit; the human /admin
   * click remains the only door into curated context (the membrane, I2/I9).
   */
  janitor?: boolean;
}

function loadTokens(): Map<string, TokenInfo> {
  const tokens = new Map<string, TokenInfo>();
  const add = (spec: string | undefined, info: Omit<TokenInfo, "identity">): void => {
    for (const pair of (spec ?? "").split(",")) {
      const i = pair.indexOf("=");
      if (i > 0)
        tokens.set(pair.slice(0, i).trim(), {
          identity: pair.slice(i + 1).trim(),
          ...info,
        });
    }
  };
  add(process.env.SETOKU_TOKENS, { curator: false });
  add(process.env.SETOKU_CURATOR_TOKENS, { curator: true });
  add(process.env.SETOKU_JANITOR_TOKENS, { curator: false, janitor: true });
  const file = process.env.SETOKU_TOKENS_FILE;
  if (file && fs.existsSync(file)) {
    for (const [token, identity] of Object.entries(
      JSON.parse(fs.readFileSync(file, "utf8")),
    )) {
      tokens.set(token, { identity: String(identity), curator: false });
    }
  }
  return tokens;
}

const tokens = loadTokens();
if (tokens.size === 0) {
  console.error(
    "setoku http: no tokens configured (SETOKU_TOKENS / SETOKU_TOKENS_FILE) — refusing to start unauthenticated",
  );
  process.exit(1);
}

/** Mint a 24-byte hex token (same shape as admin-cli). */
function mintToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Provision an analyst token at runtime (the web "Invite teammate" path): add it
 * to the in-memory set so it authenticates IMMEDIATELY (no restart), and persist
 * to SETOKU_TOKENS_FILE if configured so it survives one. Analyst only — the web
 * surface never mints curator/write capability (that stays an operator action).
 */
function addAnalystToken(token: string, identity: string): { persisted: boolean } {
  tokens.set(token, { identity, curator: false });
  const file = process.env.SETOKU_TOKENS_FILE;
  if (!file) return { persisted: false };
  let map: Record<string, string> = {};
  try {
    if (fs.existsSync(file)) map = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* a corrupt file shouldn't lose the new invite — start fresh */
  }
  map[token] = identity;
  fs.writeFileSync(file, JSON.stringify(map, null, 2) + "\n");
  return { persisted: true };
}

/**
 * Revoke every analyst token for an identity: drop from the in-memory set
 * (effective on the NEXT request — no restart) and from SETOKU_TOKENS_FILE.
 * Returns how many were removed, and whether any lived in SETOKU_TOKENS (env),
 * which we can't rewrite — those reappear on restart, so the caller should warn.
 */
function removeAnalystTokens(identity: string): { removed: number; envBacked: boolean } {
  const file = process.env.SETOKU_TOKENS_FILE;
  let fileMap: Record<string, string> = {};
  if (file && fs.existsSync(file)) {
    try {
      fileMap = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* ignore a corrupt file */
    }
  }
  let removed = 0;
  let envBacked = false;
  for (const [tok, info] of [...tokens]) {
    if (info.curator || info.identity !== identity) continue;
    tokens.delete(tok);
    removed++;
    if (tok in fileMap) delete fileMap[tok];
    else envBacked = true; // came from SETOKU_TOKENS env, not the file
  }
  if (file) fs.writeFileSync(file, JSON.stringify(fileMap, null, 2) + "\n");
  return { removed, envBacked };
}

/** Analyst (non-curator) identities currently provisioned — for the Team page. */
function analystIdentities(): string[] {
  return [...new Set([...tokens.values()].filter((t) => !t.curator).map((t) => t.identity))].sort();
}

const store = new KnowledgeStore(process.env.SETOKU_DB_PATH ?? storePath());
if (store.empty) {
  const imported = seedFromFiles(store, projectDir);
  if (imported > 0) store.audit("system", "seed_from_files", { imported });
}
// Semantic index for hybrid retrieval (I8 opt-in local embeddings). Built in the
// background so startup isn't blocked; find_context falls back to keyword
// retrieval until (and unless) it's ready. Inert when SETOKU_EMBEDDINGS!=1.
const embedIndex = EmbedIndex.create();
embedIndex.start(() => store.listDocs(), store);

if (store.accountCount === 0) {
  console.error(
    "setoku gateway: no admin accounts yet — the approval surface (/admin) has no one who can sign in.\n" +
      "  Bootstrap one:  bun gateway/admin-cli.ts create-user <name> --role admin",
  );
}

/**
 * One row per person for the Team page: union of agent-token identities and web
 * logins, joined by identity string. hasToken = they have an analyst connector;
 * role = their web-login role if any.
 */
function teamPeople(): { identity: string; hasToken: boolean; used: boolean; role?: string }[] {
  const tokenIds = new Set(analystIdentities());
  const active = store.activeIdentities();
  const accounts = store.listAccounts();
  const ids = new Set<string>([...tokenIds, ...accounts.map((a) => a.username)]);
  return [...ids]
    .sort()
    .map((identity) => ({
      identity,
      hasToken: tokenIds.has(identity),
      used: active.has(identity),
      role: accounts.find((a) => a.username === identity)?.role,
    }));
}

/**
 * Resolve identity from either the Authorization header (Claude Code: it sends
 * the configured header) or a token in the URL path: /mcp/<token>. The path
 * form exists for the consumer "Add custom connector" dialog, whose only auth
 * fields are URL + OAuth — no static-header field — so the token rides in the URL.
 */
function identityFor(req: http.IncomingMessage): TokenInfo | null {
  const auth = req.headers.authorization ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const t = tokens.get(m[1].trim());
    if (t) return t;
  }
  const pathTok = (req.url ?? "").match(/^\/mcp\/([^/?]+)/);
  if (pathTok) return tokens.get(decodeURIComponent(pathTok[1])) ?? null;
  return null;
}

const DOC_TYPES = ["entity", "metric", "query", "overview", "gotcha"] as const;

/**
 * Validate a draft payload from the cockpit's Edit-then-approve flow. A draft is
 * advisory until committed by the human accept, but we still shape-check it (a
 * malformed draft would commit a junk doc). Returns undefined for absent input
 * (accept then uses the persisted/default draft); null when present-but-invalid.
 */
function parseDraft(raw: unknown): CorrectionDraft | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  const type = d.type;
  const name = typeof d.name === "string" ? d.name.trim() : "";
  const body = typeof d.body === "string" ? d.body : "";
  if (!DOC_TYPES.includes(type as (typeof DOC_TYPES)[number]) || !name || !body)
    return undefined;
  const meta =
    d.meta && typeof d.meta === "object" && !Array.isArray(d.meta)
      ? (d.meta as Record<string, string | string[]>)
      : {};
  return { type: type as CorrectionDraft["type"], name, body, meta };
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Approval-surface sessions — the human authenticates with a username/password
// and gets an opaque cookie; the token never rides in a URL (no Slack/referer/
// history leakage). Sessions persist in the store, so a restart doesn't sign out.
// The SPA's shown-once secrets (invite token, temp password) ride back in the
// mutation's JSON response, so no server-side PRG stash is needed.
const sessions = new SessionStore(store);

const PORT = Number(process.env.SETOKU_HTTP_PORT ?? 8787);

/**
 * Aggregate health for uptime pings (/healthz): knowledge store, data-volume
 * disk usage, and dependency pings. The lake ping is DERIVED from
 * SETOKU_LAKE_URL (so it cannot drift from what run_query actually uses);
 * extra deps come from SETOKU_HEALTHZ_PING ("name=url,name=url") — only list
 * services you actually run. 503 when any dependency fails or the data disk
 * is ≥90% full; external alerting (deploy/monitor/) pages at 75% first.
 * Results are cached ~5 s: the endpoint is publicly reachable, and each probe
 * fans out real requests — the cache makes a curl loop amplify nothing.
 */
function healthzTargets(): [name: string, url: string][] {
  const targets: [string, string][] = [];
  for (const pair of (process.env.SETOKU_HEALTHZ_PING ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) targets.push([pair.slice(0, i).trim(), pair.slice(i + 1).trim()]);
  }
  const lake = process.env.SETOKU_LAKE_URL;
  if (lake && !targets.some(([n]) => n === "clickhouse")) {
    try {
      targets.push(["clickhouse", `${new URL(lake).origin}/ping`]);
    } catch {
      /* malformed lake URL — run_query will surface it */
    }
  }
  return targets;
}

let healthzCache: {
  at: number;
  value: { status: number; body: Record<string, unknown> };
} | null = null;

async function healthz(): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  if (healthzCache && Date.now() - healthzCache.at < 5_000) {
    return healthzCache.value;
  }
  const deps: Record<string, { ok: boolean; ms?: number; error?: string }> =
    {};
  await Promise.all(
    healthzTargets().map(async ([name, url]) => {
      const t0 = Date.now();
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        deps[name] = r.ok
          ? { ok: true, ms: Date.now() - t0 }
          : { ok: false, error: `HTTP ${r.status}` };
      } catch (e) {
        deps[name] = { ok: false, error: String(e) };
      }
    }),
  );
  let disk: { dir: string; used_pct: number } | undefined;
  const dataDir = path.dirname(process.env.SETOKU_DB_PATH ?? storePath());
  try {
    const statfs = (
      fs as unknown as {
        statfsSync?: (p: string) => { blocks: number; bavail: number };
      }
    ).statfsSync;
    const s = statfs?.(dataDir);
    if (s && s.blocks > 0)
      disk = {
        dir: dataDir,
        used_pct: Math.round((1 - s.bavail / s.blocks) * 100),
      };
  } catch {
    /* statfs unavailable on this platform — omit disk */
  }
  const ok =
    Object.values(deps).every((d) => d.ok) &&
    (disk ? disk.used_pct < 90 : true);
  const value = {
    status: ok ? 200 : 503,
    body: { ok, version: VERSION, docs: store.docCount, disk, deps },
  };
  healthzCache = { at: Date.now(), value };
  return value;
}

/**
 * One-line installer: \`curl -fsSL https://<host>/i/<token> | sh\`
 * Personalized by token; configures Claude Code (user-scoped remote MCP +
 * plugin marketplace) and offers Cowork setup (org plugin with .mcp.json).
 * SETOKU_DRY_RUN=1 prints actions instead of executing.
 */
function installerScript(
  token: string,
  identity: string,
  baseUrl: string,
): string {
  return `#!/bin/sh
# Setoku installer for ${identity} — generated by ${baseUrl}
set -e
URL="${baseUrl}/mcp"
TOKEN="${token}"
run() { if [ -n "$SETOKU_DRY_RUN" ]; then echo "+ $*"; else "$@"; fi; }

echo "Setoku setup for ${identity}"
DONE=""

if command -v claude >/dev/null 2>&1; then
  echo "→ Claude Code detected: adding setoku connector (user scope)…"
  run claude mcp remove --scope user setoku >/dev/null 2>&1 || true
  run claude mcp add --scope user --transport http setoku "$URL" --header "Authorization: Bearer $TOKEN"
  echo "→ Installing the setoku plugin (skills)…"
  if [ -n "$SETOKU_DRY_RUN" ]; then echo "+ claude plugin marketplace add Hedgy-Labs/setoku && claude plugin install setoku@setoku"; else
    (claude plugin marketplace add Hedgy-Labs/setoku >/dev/null 2>&1 && claude plugin install setoku@setoku >/dev/null 2>&1 \\
      && echo "  plugin installed") || echo "  (plugin skipped — needs GitHub access to Hedgy-Labs/setoku; the connector works without it)"
  fi
  DONE="yes"
fi

if [ -z "$DONE" ]; then
  echo ""
  echo "Claude Code isn't installed — Setoku needs it for now."
  echo "  1. install https://claude.com/code   2. re-run this command"
  echo ""
  echo "(The Cowork desktop app on a personal/Pro/Max plan can't add a custom"
  echo " self-hosted connector yet; that needs Team/Enterprise managed MCP. Use"
  echo " Claude Code for now, or ask Peter.)"
  exit 1
fi

echo ""
echo "✓ Setoku is connected in Claude Code. Open it and ask:"
echo "    how many companies are paying us right now?"
`;
}

// Lake source tables we know how to surface (shared with the list_sources MCP
// tool) — query only the ones that actually exist; see gatherSources().
import { LAKE_SOURCES } from "./lib/sources";

/**
 * Gather the /admin Sources view live: is Postgres configured + reachable (+
 * table count), is the lake reachable, and per-connector row counts/freshness.
 * All read-only; every probe is independently try/caught so one failure
 * degrades to "—" rather than blanking the page.
 */
async function gatherSources(): Promise<SourcesData> {
  const cfg = loadConfig(projectDir);
  const config = cfg.ok ? cfg.config : null;

  const postgres: SourcesData["postgres"] = { configured: false, ok: false };
  const lake: SourcesData["lake"] = { configured: false, ok: false, tables: [] };

  if (config) {
    const pgUrl = resolveDatabaseUrl(projectDir, config);
    if (pgUrl.ok) {
      postgres.configured = true;
      postgres.envVar = config.dataSource?.urlEnv;
      postgres.allow = config.allowTables;
      try {
        const tables = await introspectSchema(pgUrl.url, config);
        postgres.ok = true;
        postgres.tableCount = tables.length;
      } catch (e) {
        postgres.error = String(e).slice(0, 200);
      }
    }

    const lakeUrl = resolveLakeUrl(projectDir, config);
    if (lakeUrl.ok) {
      lake.configured = true;
      const qopts = { rowCap: 10, statementTimeoutMs: 8_000 };
      // Connectivity first — distinguishes "lake down" from "table absent". We
      // probe each table independently (rather than reading system.tables, which
      // setoku_ro may not be granted): a missing or unreadable table is simply
      // omitted, while a dead lake surfaces as unreachable.
      try {
        await runLakeQuery(lakeUrl.url, "SELECT 1", qopts);
        lake.ok = true;
      } catch (e) {
        lake.error = String(e).slice(0, 200);
      }
      if (lake.ok) {
        // Connector liveness beats — a source with a `connector` shows "flowing"
        // off its latest beat (pipeline up) rather than data recency, so a quiet
        // source isn't false-"stale". Absent table (un-migrated box) → fall back.
        const beats: Record<string, string> = {};
        try {
          const hb = await runLakeQuery(
            lakeUrl.url,
            "SELECT connector, toString(max(beat_at)) AS beat FROM setoku.ingest_heartbeats GROUP BY connector",
            qopts,
          );
          for (const r of hb.rows as Array<Record<string, unknown>>) {
            beats[String(r.connector)] = String(r.beat);
          }
        } catch {
          /* ingest_heartbeats absent — sources fall back to data-recency freshness */
        }
        const probes = await Promise.all(
          LAKE_SOURCES.map(async (s): Promise<SourceTable | null> => {
            try {
              const res = await runLakeQuery(
                lakeUrl.url,
                `SELECT count() AS rows, toString(max(${s.ts})) AS last FROM setoku.${s.table}`,
                qopts,
              );
              const row = (res.rows[0] ?? {}) as Record<string, unknown>;
              const rows = Number(row.rows ?? 0);
              return {
                source: s.source,
                rows,
                last: rows > 0 ? String(row.last) : null,
                beat: s.connector ? (beats[s.connector] ?? null) : null,
              };
            } catch {
              return null; // table absent or not granted — omit this connector
            }
          }),
        );
        lake.tables = probes.filter((p): p is SourceTable => p !== null);
      }
    }
  }

  const byType: Record<string, number> = {};
  for (const d of store.listDocs()) byType[d.type] = (byType[d.type] ?? 0) + 1;

  return { postgres, lake, knowledge: { docs: store.docCount, byType } };
}

// ---- live-dashboard rendering helpers ----
// The agent-authored template runs in a sandboxed iframe under THIS CSP. Because
// the box INJECTS the data (rather than the template fetching it), the template
// needs no network at all — so default-src 'none' blocks every outbound request,
// closing the exfil-via-author-JS hole a self-contained report would otherwise
// have. Combined with the iframe `sandbox allow-scripts` (opaque origin) it can
// neither reach the box's cookie/API nor phone home.
const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/** Escape a JSON string for safe inlining inside a <script> tag. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** Assemble the sandboxed frame document: our skeleton + injected panel data +
 *  the agent's template fragment. Legacy zero-panel reports are full documents,
 *  served as-is. The payload is already byte-bounded by renderDashboard's
 *  capRenderBytes (shared with the provenance drawer so the two agree). `team`
 *  gates raw error text: a public frame must NOT inject a raw DB error (it can
 *  name tables/columns/env vars) — same scrub the public /data path applies. */
function frameDocument(dash: PublishedReport, panels: RenderedPanel[], opts: { team: boolean }): string {
  // A legacy full HTML document (pre-dashboard report) is served as-is. But a
  // FRAGMENT with no panels — e.g. a dashboard the author turned static while
  // keeping a Setoku.*/__SETOKU__ template — still gets the runtime + empty data
  // injected, so those calls degrade ("No data") instead of ReferenceError.
  if (!panels.length && /<!doctype|<html[\s>]/i.test(dash.body)) return dash.body;
  const scrub = (e: string | null | undefined): string | null =>
    e ? (opts.team ? e : "data temporarily unavailable") : null;
  const data = {
    title: dash.title,
    refreshSeconds: dash.refreshSeconds,
    panels: Object.fromEntries(
      panels.map((p) => [
        p.key,
        {
          columns: p.columns,
          rows: p.rows as unknown[],
          rowCount: p.rowCount,
          computedAt: p.computedAt,
          error: scrub(p.error),
          refreshError: scrub(p.refreshError),
        },
      ]),
    ),
  };
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<script>window.__SETOKU__=${jsonForScript(data)};</script>` +
    // Tested chart helpers (window.Setoku.*) — defined after the data, before the
    // agent template's own <script> in <body> runs, so the template can call them.
    `<script>${DASHBOARD_RUNTIME}</script>` +
    `</head><body>${dash.body}</body></html>`
  );
}

/** Provenance JSON for the shell's "how is this calculated" drawer. `team` is
 *  TRUE only on the authenticated team surface. The public surface must NOT leak
 *  schema (raw `sql`, the metric BODY which is the canonical SQL, the author's
 *  identity, or a raw DB error that may name an env var) — it shows methodology
 *  only: the metric name + summary, and a generic "unavailable" on failure. */
// TEAM-ONLY provenance: the "how is this calculated" drawer (incl. raw SQL) is
// served only to a signed-in box session. The PUBLIC surface exposes NO
// calculations — its /data returns just freshness meta (see the /p/<id>/data
// handler), so a public link is the visual dashboard and nothing else.
function dashboardProvenance(
  knowledge: KnowledgeStore,
  meta: PublishedMeta,
  panels: RenderedPanel[],
): Record<string, unknown> {
  const byKey = new Map(panels.map((p) => [p.key, p]));
  return {
    id: meta.id,
    title: meta.title,
    format: meta.format,
    visibility: meta.visibility,
    refreshSeconds: meta.refreshSeconds,
    createdBy: meta.createdBy,
    createdAt: meta.createdAt,
    archivedAt: meta.archivedAt,
    updatedAt: newestComputedAt(panels),
    panels: (meta.panels ?? []).map((p) => {
      const r = byKey.get(p.key);
      const doc = p.metricId ? knowledge.getDoc("metric", String(p.metricId)) : null;
      return {
        key: p.key,
        title: p.title ?? null,
        description: p.description ?? null,
        dialect: p.dialect,
        metricId: p.metricId ?? null,
        metricSummary: doc ? String(doc.meta.summary ?? "") : null,
        sql: p.sql,
        rowCount: r?.rowCount ?? 0,
        computedAt: r?.computedAt ?? null,
        error: r?.error ?? null,
        refreshError: r?.refreshError ?? null,
      };
    }),
  };
}

/** Escape text for safe interpolation into HTML. */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The trusted OUTER shell (ours). It frames the sandboxed render document and
// renders provenance OUTSIDE the sandbox, so the agent's template can't spoof or
// hide how a number was computed. Its own CSP allows only its inline code, a
// same-origin data fetch, and a same-origin frame — no other network.
const SHELL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src data:; base-uri 'none'";

/** The credential-free public dashboard shell at /p/<id>. (The team surface uses
 *  the React app, which renders the same frame + provenance.) Provenance here
 *  shows methodology only — never raw SQL. */
function publicDashboardShell(opts: {
  title: string;
  framePath: string;
  dataPath: string;
  adminPath: string;
  refreshSeconds: number;
}): string {
  const title = escapeHtml(opts.title || "Dashboard");
  const cfg = jsonForScript({ frame: opts.framePath, data: opts.dataPath, admin: opts.adminPath, refresh: opts.refreshSeconds });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;display:flex;flex-direction:column;height:100vh;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1917;background:#fafaf9}
  header{flex:none;display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem 1rem;padding:.7rem 1.1rem;border-bottom:1px solid #e7e5e4}
  h1{margin:0;font-size:1.02rem;font-weight:600}
  .muted{color:#78716c;font-size:.8rem}
  .adminbtn{display:none;margin-left:auto;font-size:.8rem;text-decoration:none;color:#44403c;border:1px solid #d6d3d1;background:#fafaf9;padding:.2rem .6rem;border-radius:.4rem}
  .adminbtn:hover{background:#f5f5f4}
  main{flex:1;min-height:0;display:flex;padding:.9rem 1.1rem}
  iframe{flex:1;width:100%;border:1px solid #e7e5e4;border-radius:.5rem;background:#fff}
</style></head><body>
<header><h1>${title}</h1><span class="muted" id="stamp"></span><a id="adminlink" class="adminbtn" href="">Admin view →</a></header>
<main><iframe id="frame" title="${title}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></main>
<script>
(function(){
  var CFG=${cfg};
  var frame=document.getElementById('frame'), stamp=document.getElementById('stamp');
  function rel(iso){ if(!iso) return ''; var s=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));
    if(s<60) return s+'s ago'; var m=Math.round(s/60); if(m<60) return m+'m ago';
    var h=Math.round(m/60); return h<48? h+'h ago' : Math.round(h/24)+'d ago'; }
  function reload(){ frame.src=CFG.frame+'?t='+Date.now(); }
  function refresh(){ fetch(CFG.data,{credentials:'omit'}).then(function(r){return r.json()}).then(function(d){
    var secs=d.refreshSeconds||CFG.refresh;
    var iv=secs<60?secs+'s':secs<3600?Math.round(secs/60)+'m':Math.round(secs/3600)+'h';
    stamp.textContent='data updated '+rel(d.updatedAt)+' · auto-refreshes every '+iv;
  }).catch(function(){}); }
  // Reveal the Admin link only if this viewer has a box session (the cookie is
  // Path=/admin, so it rides along to /admin/api/session but not to /p/*).
  fetch('/admin/api/session',{credentials:'include'}).then(function(r){
    if(r.ok){ var a=document.getElementById('adminlink'); a.href=CFG.admin; a.style.display='inline-block'; }
  }).catch(function(){});
  reload(); refresh();
  setInterval(function(){ reload(); refresh(); }, Math.max(30,CFG.refresh)*1000);
})();
</script>
</body></html>`;
}

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: VERSION, docs: store.docCount }));
      return;
    }
    if (req.url === "/healthz" || req.url?.startsWith("/healthz?")) {
      const { status, body } = await healthz();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.url?.startsWith("/i/")) {
      const token = decodeURIComponent(req.url.slice(3).split("?")[0]);
      const info = tokens.get(token);
      if (!info) {
        store.audit("anonymous", "installer_rejected", {});
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("unknown installer link\n");
        return;
      }
      const baseUrl =
        process.env.SETOKU_PUBLIC_URL ?? `https://${req.headers.host}`;
      store.audit(info.identity, "installer_served", {});
      res.writeHead(200, { "content-type": "text/x-shellscript" });
      res.end(installerScript(token, info.identity, baseUrl));
      return;
    }
    // ---- public report surface — /p/<id>, credential-free ----
    // Serves ONLY reports an admin has promoted to "public"; a team report or a
    // bad id 404s, so this path never leaks a session-gated report's content or
    // existence. The body is served under a CSP `sandbox` (no allow-same-origin)
    // so its scripts run in an opaque origin and can't reach the box's cookie or
    // /admin API even though it's the same host.
    if (req.url?.startsWith("/p/")) {
      const segs = req.url.slice(3).split("?")[0].split("/").map((s) => decodeURIComponent(s));
      const id = segs[0];
      const sub = segs[1]; // undefined | "frame" | "data"
      const notFound = (): void => {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found\n");
      };
      // Gate on metadata first so a guessed/archived/team id 404s WITHOUT reading
      // the up-to-2MB body (this path is credential-free and cheap to hammer).
      const meta = store.getPublishedMeta(id);
      if (!meta || meta.archivedAt || meta.visibility !== "public") return notFound();
      const isDashboard = meta.format === "dashboard" && (meta.panels?.length ?? 0) > 0;

      // The /frame and /data subpaths exist only for live dashboards (the shell
      // polls them); a legacy report is served whole at /p/<id>. Don't expose
      // them for non-dashboards.
      if ((sub === "data" || sub === "frame") && !isDashboard) return notFound();

      // /p/<id>/data — FRESHNESS ONLY for the public shell's "updated …" stamp.
      // The public surface exposes NO calculations (no SQL, descriptions, metrics).
      // Reads the newest cached computed_at directly — does NOT re-run any query
      // (the /frame request drives execution; this credential-free poll must not).
      if (sub === "data") {
        store.audit("public", "dashboard_data_public", { id });
        res.writeHead(200, {
          "content-type": "application/json",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        res.end(
          JSON.stringify({
            title: meta.title,
            refreshSeconds: meta.refreshSeconds,
            updatedAt: store.newestPanelComputedAt(id),
          }),
        );
        return;
      }

      // /p/<id>/frame — the sandboxed render document (data injected, no network).
      if (sub === "frame") {
        const rep = store.getPublished(id);
        if (!rep) return notFound();
        const panels = await renderDashboard(store, projectDir, rep);
        store.audit("public", "dashboard_frame_public", { id });
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `${FRAME_CSP}; sandbox allow-scripts`,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        res.end(frameDocument(rep, panels, { team: false }));
        return;
      }

      if (sub) return notFound(); // unknown subpath

      store.audit("public", "published_viewed_public", { id });
      if (!isDashboard) {
        // Legacy static report: serve the self-contained body sandboxed, as before
        // (opaque origin, no popups/top-navigation).
        const rep = store.getPublished(id);
        if (!rep) return notFound();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "sandbox allow-scripts",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        // frameDocument serves a legacy full-doc as-is, but injects the runtime +
        // empty data for a fragment template (so Setoku.* degrades, not throws).
        res.end(frameDocument(rep, [], { team: false }));
        return;
      }
      // Live dashboard: serve the trusted outer shell (frames /p/<id>/frame, polls
      // /p/<id>/data). The agent template never runs in this top-level origin.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": SHELL_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(
        publicDashboardShell({
          title: meta.title,
          framePath: `/p/${encodeURIComponent(id)}/frame`,
          dataPath: `/p/${encodeURIComponent(id)}/data`,
          adminPath: `/admin/p/${encodeURIComponent(id)}`,
          refreshSeconds: meta.refreshSeconds ?? 300,
        }),
      );
      return;
    }
    // ---- web approval surface — React SPA + JSON API ----
    // Auth is a session COOKIE, not a token in the URL: every /admin route is safe
    // to share. The SPA shell and its assets are public (no secrets); the JSON API
    // under /admin/api/* is session-gated, and mutations additionally require the
    // CSRF token (x-csrf-token header) + admin role. The token only ever travels in
    // the POST /admin/api/login body (I9 — the agent has the token, not the password).
    if (req.url === "/admin" || req.url?.startsWith("/admin/") || req.url?.startsWith("/admin?")) {
      const reqPath = req.url.split("?")[0];

      // public, content-versioned assets — safe to cache immutably (URL changes
      // with content), served before the auth gate.
      if (reqPath === "/admin/app.css") {
        res.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        });
        res.end(ADMIN_CSS);
        return;
      }
      if (reqPath === "/admin/app.js") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        });
        res.end(ADMIN_JS);
        return;
      }

      // ---- team dashboard frame — /admin/frame/<id>, session-gated ----
      // The sandboxed render document for a TEAM dashboard. Requires a box
      // session (cookie); the React viewer embeds it as the iframe src so the
      // strict no-network CSP is a real response header, not a srcdoc guess.
      if (reqPath.startsWith("/admin/frame/")) {
        const session = sessions.get(sessionIdFromCookie(req.headers.cookie));
        if (!session) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("not signed in\n");
          return;
        }
        const id = decodeURIComponent(reqPath.slice("/admin/frame/".length));
        const rep = store.getPublished(id);
        if (!rep || rep.archivedAt) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found\n");
          return;
        }
        const isDash = rep.format === "dashboard" && (rep.panels?.length ?? 0) > 0;
        const panels = isDash ? await renderDashboard(store, projectDir, rep) : [];
        store.audit(session.identity, "dashboard_frame_viewed", { id });
        // A live dashboard's template needs no network (data is injected) → strict
        // CSP. A LEGACY report predates that contract and may inline a CDN script
        // or remote image; keep its original sandbox-only CSP so it still renders.
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": isDash ? `${FRAME_CSP}; sandbox allow-scripts` : "sandbox allow-scripts",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        res.end(frameDocument(rep, panels, { team: true }));
        return;
      }

      // ---- JSON API ----
      if (reqPath.startsWith("/admin/api/")) {
        const api = reqPath.slice("/admin/api/".length);
        const json = (status: number, body: unknown): void => {
          res.writeHead(status, { "content-type": "application/json", "referrer-policy": "no-referrer" });
          res.end(JSON.stringify(body));
        };

        // login: username + password (a LOCAL ACCOUNT, never the MCP token) →
        // session cookie + the CSRF token the SPA echoes on every mutation.
        if (api === "login" && req.method === "POST") {
          const body = (await readBody(req)) as { username?: string; password?: string } | undefined;
          const username = (body?.username ?? "").trim();
          const auth = await authenticate(store, username, body?.password ?? "");
          if (!auth.ok) {
            store.audit(username || "anonymous", "admin_login_rejected", {});
            return json(401, { ok: false, error: "Invalid username or password." });
          }
          const { sid, csrf } = sessions.create(username, auth.role);
          store.audit(username, "admin_login", { role: auth.role });
          res.writeHead(200, { "content-type": "application/json", "set-cookie": sessionSetCookie(sid) });
          res.end(JSON.stringify({ ok: true, identity: username, role: auth.role, csrf }));
          return;
        }

        const sid = sessionIdFromCookie(req.headers.cookie);
        const session = sessions.get(sid);

        if (api === "logout" && req.method === "POST") {
          sessions.destroy(sid);
          res.writeHead(200, { "content-type": "application/json", "set-cookie": sessionClearCookie() });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // everything below requires a session
        if (!session) return json(401, { ok: false, error: "not signed in" });

        // who am I — drives the SPA's auth state + the CSRF token for mutations
        if (api === "session")
          return json(200, { identity: session.identity, role: session.role, csrf: session.csrf });

        // read endpoints — any signed-in user (members included) may view
        // pending list for the cockpit: each item carries the best-available
        // DRAFT (persisted auto-draft, else the synthesized gotcha default) so a
        // review card can render a finished, editable change. Advisory only.
        if (api === "pending" && req.method === "GET")
          return json(
            200,
            store.listCorrections("pending").map((c) => ({ ...c, draft: defaultDraft(c) })),
          );
        // bot-rejected items the cockpit can review + un-reject (piece C: soft,
        // reversible, audited — a janitor suppressing good proposals is undoable).
        if (api === "rejected" && req.method === "GET")
          return json(200, store.listCorrections("rejected"));
        if (api === "knowledge" && req.method === "GET") return json(200, store.listDocs());
        if (api === "knowledge_view" && req.method === "GET")
          return json(
            200,
            buildKnowledgeView(
              store.listDocs(),
              store.listCorrections("pending"),
              store.knowledgeUsage(),
            ),
          );
        if (api === "audit" && req.method === "GET") return json(200, store.listAudit(200));
        if (api === "sources" && req.method === "GET") return json(200, await gatherSources());
        if (api === "team" && req.method === "GET")
          return json(200, { people: teamPeople(), adminCount: store.countRole("admin") });

        // published dashboards/reports — TEAM-ONLY: gated behind this session
        // check, so a shared /admin/p/<id> link only renders for a box login.
        // The list UI needs only panel COUNT, not the queries — strip each panel's
        // raw SQL so the list doesn't broadcast every dashboard's query text to all
        // members (SQL stays team-tier, shown only in the per-dashboard drawer).
        if (api === "published" && req.method === "GET")
          return json(
            200,
            store.listPublished().map((r) => ({
              ...r,
              panels: r.panels ? r.panels.map((p) => ({ ...p, sql: "" })) : null,
            })),
          );
        // Provenance + rendered panel metadata for the team viewer's drawer.
        // Includes raw SQL (this surface is authenticated). The rows themselves
        // arrive via the sandboxed /admin/frame/<id>.
        if (api === "dashboard_data" && req.method === "GET") {
          const url = new URL(req.url ?? "", "http://x");
          const id = url.searchParams.get("id") ?? "";
          const meta = store.getPublishedMeta(id);
          if (!meta || meta.archivedAt) return json(404, { ok: false, error: "dashboard not found or archived" });
          // ?force=1 bypasses the cache and re-runs every panel — restrict it to
          // the author or an admin so a member (or a stale tab, or a credentialed
          // cross-site GET) can't hammer the prod DB the cache exists to protect.
          const force =
            url.searchParams.get("force") === "1" &&
            (meta.createdBy === session.identity || canApprove(session.role));
          // Renders from `meta` — provenance + frame don't need the report body.
          const panels = await renderDashboard(store, projectDir, meta, { force });
          store.audit(session.identity, force ? "dashboard_refreshed" : "dashboard_viewed", { id });
          return json(200, dashboardProvenance(store, meta, panels));
        }

        // ---- mutations: CSRF (header) + admin role, mirroring the old form posts ----
        if (req.method === "POST") {
          if ((req.headers["x-csrf-token"] ?? "") !== session.csrf)
            return json(403, { ok: false, error: "bad csrf token" });

          // Author-or-admin gate for a per-dashboard mutation (archive, visibility):
          // 404 if missing/archived, 403 unless the caller authored it or is an
          // admin. Returns false having ALREADY sent the response, so the handler
          // returns immediately. These two are allowed before the blanket admin
          // gate below (a member can manage their own dashboard); every OTHER
          // mutation stays admin-only. The agent never reaches here — it has no
          // web session — so promotion-to-public is always a human decision.
          const mayMutateDashboard = (id: string): boolean => {
            const rep = id ? store.getPublishedMeta(id) : null;
            if (!rep || rep.archivedAt) {
              json(404, { ok: false, error: "No active dashboard with that id." });
              return false;
            }
            if (rep.createdBy !== session.identity && !canApprove(session.role)) {
              store.audit(session.identity, "admin_mutation_denied", { api, role: session.role });
              json(403, { ok: false, error: "Only the dashboard's author or an admin can manage it." });
              return false;
            }
            return true;
          };

          if (api === "archive") {
            const body = (await readBody(req)) as { id?: string } | undefined;
            const id = (body?.id ?? "").trim();
            if (!mayMutateDashboard(id)) return;
            const ok = store.archivePublished(id);
            store.audit(session.identity, "unpublish_dashboard", { id, ok });
            return json(200, { ok, flash: "Archived — its link no longer works." });
          }

          // Restore an archived dashboard. Author-or-admin, but (unlike the other
          // per-dashboard mutations) it operates on an ARCHIVED row, so it gates
          // here rather than via mayMutateDashboard (which 404s archived rows).
          if (api === "unarchive") {
            const body = (await readBody(req)) as { id?: string } | undefined;
            const id = (body?.id ?? "").trim();
            const rep = id ? store.getPublishedMeta(id) : null;
            if (!rep || !rep.archivedAt) return json(404, { ok: false, error: "No archived dashboard with that id." });
            if (rep.createdBy !== session.identity && !canApprove(session.role)) {
              store.audit(session.identity, "admin_mutation_denied", { api, role: session.role });
              return json(403, { ok: false, error: "Only the dashboard's author or an admin can restore it." });
            }
            const ok = store.unarchivePublished(id);
            store.audit(session.identity, "unarchive_dashboard", { id, ok });
            return json(ok ? 200 : 409, {
              ok,
              flash: ok ? "Restored as team-only — an admin can make it public again." : "Already restored.",
            });
          }

          if (api === "set_visibility") {
            const body = (await readBody(req)) as { id?: string; visibility?: string } | undefined;
            const id = (body?.id ?? "").trim();
            const visibility = body?.visibility;
            if (visibility !== "team" && visibility !== "public")
              return json(400, { ok: false, error: "visibility must be 'team' or 'public'" });
            if (!mayMutateDashboard(id)) return;
            // Making a dashboard PUBLIC (a credential-free link) is an ADMIN action
            // (I9) — an author can take it back to team-only, but not expose it.
            if (visibility === "public" && !canApprove(session.role)) {
              store.audit(session.identity, "admin_mutation_denied", { api, role: session.role });
              return json(403, { ok: false, error: "Only an admin can make a dashboard public." });
            }
            const ok = store.setReportVisibility(id, visibility);
            store.audit(session.identity, "dashboard_visibility_set", { id, visibility, ok });
            return json(ok ? 200 : 404, {
              ok,
              flash: ok
                ? visibility === "public"
                  ? "Now PUBLIC — anyone with the /p link can open it, no login required."
                  : "Now team-only."
                : "No active dashboard with that id.",
            });
          }

          if (!canApprove(session.role)) {
            store.audit(session.identity, "admin_mutation_denied", { api, role: session.role });
            return json(403, { ok: false, error: "not authorized" });
          }
          const baseUrl = process.env.SETOKU_PUBLIC_URL ?? `https://${req.headers.host}`;
          const tempPw = (): string =>
            Array.from(crypto.getRandomValues(new Uint8Array(9)))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
          const buildInvite = (identity: string): Invite => {
            const token = mintToken();
            const { persisted } = addAnalystToken(token, identity);
            store.audit(session.identity, "teammate_invited", { identity, persisted });
            return { identity, token, installerUrl: `${baseUrl}/i/${token}`, mcpUrl: `${baseUrl}/mcp`, persisted };
          };

          // approve/reject — the membrane's human side (I9). On accept, commits
          // the DRAFTED doc-edit (the cockpit edit if supplied, else the persisted/
          // default draft) into curated context for ALL kinds (cockpit piece A.1).
          if (api === "resolve") {
            const body = (await readBody(req)) as
              | { id?: number; action?: string; reason?: string; draft?: unknown }
              | undefined;
            const id = Number(body?.id);
            const action = body?.action;
            if (!Number.isInteger(id) || (action !== "accepted" && action !== "rejected"))
              return json(400, { ok: false, error: "invalid action" });
            const draft = parseDraft(body?.draft);
            if (action === "accepted" && body?.draft !== undefined && !draft)
              return json(400, { ok: false, error: "invalid draft (need type, name, body)" });
            const flash = applyApprovalAction(store, session.identity, {
              id,
              action,
              draft,
              reason: body?.reason,
            });
            return json(200, { ok: true, flash });
          }

          // un-reject a (typically bot-)rejected item back to pending — the
          // reversal that makes janitor auto-rejects safe (piece C).
          if (api === "unreject") {
            const body = (await readBody(req)) as { id?: number } | undefined;
            const id = Number(body?.id);
            if (!Number.isInteger(id)) return json(400, { ok: false, error: "invalid id" });
            const ok = store.unrejectCorrection(id, session.identity);
            return json(200, { ok, flash: ok ? `#${id} restored to pending.` : `#${id} was not rejected.` });
          }

          // invite a teammate — mint a read-only analyst connector (+ a member
          // account if they have none). Never grants curate/write (operator-only).
          // The shown-once secrets ride back in the response (no PRG stash needed).
          if (api === "invite") {
            const body = (await readBody(req)) as { identity?: string; rotate?: boolean } | undefined;
            const identity = (body?.identity ?? "").trim();
            const rotate = body?.rotate === true;
            if (!identity) return json(400, { ok: false, error: "Enter a teammate email to invite." });
            if (!rotate && analystIdentities().includes(identity))
              return json(409, { ok: false, error: `${identity} already has an agent connector — use Rotate to replace it.` });
            let flash: string | undefined;
            let revokedEnv = false;
            if (rotate) {
              const r = removeAnalystTokens(identity);
              revokedEnv = r.envBacked;
              store.audit(session.identity, "connector_rotated", { identity, removed: r.removed });
            }
            const token = mintToken();
            const { persisted } = addAnalystToken(token, identity);
            const invite: Invite = { identity, token, installerUrl: `${baseUrl}/i/${token}`, mcpUrl: `${baseUrl}/mcp`, persisted };
            if (rotate)
              flash = `Rotated ${identity}'s connector — the old token no longer works.${revokedEnv ? " (One old token is in SETOKU_TOKENS env, not the file — it returns on restart; remove it from .env to fully revoke.)" : ""}`;
            else store.audit(session.identity, "teammate_invited", { identity, persisted });
            let newLogin: { username: string; role: string; tempPassword: string } | undefined;
            if (!store.getAccount(identity)) {
              const pw = tempPw();
              store.createAccount({ username: identity, pwhash: await hashPassword(pw), role: "member", createdBy: session.identity });
              store.audit(session.identity, "account_created", { username: identity, role: "member" });
              newLogin = { username: identity, role: "member", tempPassword: pw };
            }
            return json(200, { ok: true, invite, newLogin, flash });
          }

          // manage web logins: create / promote-demote / reset / remove. Manages
          // who can sign in here and at what role — no agent-side write capability.
          if (api === "users") {
            const body = (await readBody(req)) as { op?: string; username?: string; role?: string } | undefined;
            const op = body?.op;
            const uname = (body?.username ?? "").trim();
            const acct = uname ? store.getAccount(uname) : null;
            const isLastAdmin = (a: { role: string } | null): boolean =>
              !!a && a.role === "admin" && store.countRole("admin") <= 1;

            if (op === "create") {
              const role = body?.role ?? "member";
              if (!uname) return json(400, { ok: false, error: "Username required." });
              if (!isRole(role)) return json(400, { ok: false, error: `Invalid role "${role}".` });
              if (store.getAccount(uname)) return json(409, { ok: false, error: `"${uname}" already has a login.` });
              const pw = tempPw();
              store.createAccount({ username: uname, pwhash: await hashPassword(pw), role, createdBy: session.identity });
              store.audit(session.identity, "account_created", { username: uname, role });
              const newLogin = { username: uname, role, tempPassword: pw };
              const invite = analystIdentities().includes(uname) ? undefined : buildInvite(uname);
              return json(200, {
                ok: true,
                flash: `Created ${role} login for ${uname}${invite ? " + agent connector" : ""}.`,
                newLogin,
                invite,
              });
            }
            if (op === "role") {
              const role = body?.role ?? "";
              if (!acct) return json(404, { ok: false, error: `No login "${uname}".` });
              if (!isRole(role)) return json(400, { ok: false, error: `Invalid role "${role}".` });
              if (role === "member" && isLastAdmin(acct)) return json(409, { ok: false, error: "Can't demote the last admin." });
              store.setRole(uname, role);
              store.audit(session.identity, "account_role_changed", { username: uname, role });
              return json(200, { ok: true, flash: `${uname} is now ${role}.` });
            }
            if (op === "reset") {
              if (!acct) return json(404, { ok: false, error: `No login "${uname}".` });
              const pw = tempPw();
              store.setPassword(uname, await hashPassword(pw));
              store.audit(session.identity, "account_password_reset", { username: uname });
              return json(200, {
                ok: true,
                flash: `Reset password for ${uname}.`,
                newLogin: { username: uname, role: acct.role, tempPassword: pw },
              });
            }
            if (op === "delete") {
              if (!acct) return json(404, { ok: false, error: `No login "${uname}".` });
              if (isLastAdmin(acct)) return json(409, { ok: false, error: "Can't remove the last admin." });
              store.deleteAccount(uname);
              const { removed, envBacked } = removeAnalystTokens(uname);
              store.audit(session.identity, "account_deleted", { username: uname, tokensRevoked: removed });
              return json(200, {
                ok: true,
                flash: `Removed ${uname} (account + ${removed} connector${removed === 1 ? "" : "s"} revoked).${envBacked ? " One token is in SETOKU_TOKENS env — remove it from .env to fully revoke." : ""}`,
              });
            }
            return json(400, { ok: false, error: "Unknown operation." });
          }

          return json(404, { ok: false, error: "unknown endpoint" });
        }

        return json(404, { ok: false, error: "unknown endpoint" });
      }

      // A logged-OUT visitor to /admin/p/<id> for a PUBLIC dashboard should see
      // the public view, not the login wall — bounce them to /p/<id>. (Signed-in
      // users fall through to the SPA, which renders the full team view.)
      const pm = reqPath.match(/^\/admin\/p\/([^/]+)$/);
      if (pm && req.method === "GET" && !sessions.get(sessionIdFromCookie(req.headers.cookie))) {
        const pmeta = store.getPublishedMeta(decodeURIComponent(pm[1]));
        if (pmeta && !pmeta.archivedAt && pmeta.visibility === "public") {
          res.writeHead(302, { location: `/p/${encodeURIComponent(pmeta.id)}`, "referrer-policy": "no-referrer" });
          res.end();
          return;
        }
      }

      // SPA shell for every other /admin GET — client-side routing renders the
      // view; the app fetches /admin/api/session and shows login if unauthenticated.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" });
      res.end(ADMIN_SHELL);
      return;
    }

    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    const auth = identityFor(req);
    if (!auth) {
      store.audit("anonymous", "auth_rejected", { path: req.url });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid or missing bearer token" }));
      return;
    }
    // Stateless: a fresh McpServer per request, identity bound from the token.
    // Shared state lives in the SQLite store (WAL), not the server instance.
    // Analyst tokens are propose-only (canWrite:false) and may read the lake.
    // Curator tokens may commit curated knowledge (canWrite) but are blocked
    // from reading the lake (denyLakeRead) — the two never coexist (I2/I9).
    const server = buildServer({
      projectDir,
      store,
      user: auth.identity,
      canWrite: auth.curator,
      denyLakeRead: auth.curator,
      // the janitor holds draft + reject only — both grant zero authority — so it
      // can read untrusted pending content without ever committing knowledge.
      canDraft: auth.janitor === true,
      canReject: auth.janitor === true,
      embedIndex,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    const body = await readBody(req);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error("setoku http error:", e);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.error(
    `setoku gateway (http) listening on :${PORT} — ${tokens.size} token(s), project ${projectDir}`,
  );
});
