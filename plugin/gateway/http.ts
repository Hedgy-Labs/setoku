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

import { buildServer, type TokenRole } from "./app";
import { EmbedIndex } from "./lib/embed-index";
import { DerivedSynonyms } from "./lib/derived-synonyms";
import { loadConfig, resolveProjectDir, connectorName } from "./lib/config";
import { notifyActivity } from "./lib/notify";
import {
  KnowledgeStore,
  defaultDbPath,
  seedFromFiles,
  type CorrectionDraft,
  type PublishedMeta,
  type PublishedReport,
} from "./lib/store";
import { newestComputedAt, renderApp, type RenderedPanel } from "./lib/apps";
import { mirroredTables, mirrorAsOf, referencedBizTables } from "./lib/mirror";
import { APP_RUNTIME } from "./lib/app-runtime";
import { AppStore, defaultAppDbPath, AppStoreQuotaError, type StateScope } from "./lib/app-store";
import { resolveParams, type AppParam } from "./lib/params";
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
  type SourceSeries,
  type SourceSeriesData,
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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%231A1A19'/><g transform='translate(32 33) scale(0.82) translate(-30 -33)' fill='%23FAF6EC'><path d='M32 35 Q24.8 27.88 11.47 25.91 A11 11 0 1 1 26.61 13.21 Q32.37 21.53 32 35 Z'/><path d='M32 35 Q32.37 25.88 35.79 19.33 A8 8 0 1 1 46.77 28.54 Q37.86 30.49 32 35 Z'/><path d='M29.86 35.18 L29.87 36.49 L29.83 37.72 L29.76 38.89 L29.65 40.02 L29.51 41.12 L29.34 42.17 L29.15 43.2 L28.93 44.2 L28.7 45.17 L28.45 46.13 L28.2 47.08 L27.93 48.02 L27.66 48.96 L27.39 49.9 L27.12 50.84 L26.86 51.8 L26.61 52.77 L26.38 53.76 L26.16 54.78 L25.97 55.82 L25.82 56.9 L25.7 57.92 L34.3 58.08 L34.22 57.2 L34.16 56.4 L34.14 55.58 L34.13 54.74 L34.15 53.88 L34.19 52.99 L34.25 52.08 L34.32 51.14 L34.39 50.18 L34.47 49.19 L34.55 48.17 L34.63 47.12 L34.7 46.04 L34.75 44.93 L34.78 43.79 L34.8 42.61 L34.78 41.4 L34.73 40.15 L34.65 38.87 L34.52 37.55 L34.35 36.19 L34.14 34.82 Z'/></g></svg>">
<link rel="preconnect" href="https://use.typekit.net" crossorigin>
<link rel="preconnect" href="https://p.typekit.net" crossorigin>
<link rel="stylesheet" href="https://use.typekit.net/zcb5teq.css">
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
  /**
   * The token's capability role (the membrane, I2/I9). EXACTLY one value, so a
   * token can never be both curator and janitor: analyst (reads lake, propose-
   * only), curator (commits knowledge, no lake), janitor (draft+reject only).
   * Each source env maps to a single role.
   */
  role: TokenRole;
  /**
   * Where this token came from. "env" tokens can't be revoked at runtime (the
   * process env is fixed; they reappear on restart); "file" tokens can (the
   * file is rewritten); "db" is the normal teammate path (analyst_tokens table,
   * read per-request — never in the boot-time map).
   */
  source: "env" | "file" | "db";
}

function loadTokens(): Map<string, TokenInfo> {
  const tokens = new Map<string, TokenInfo>();
  const add = (spec: string | undefined, role: TokenRole): void => {
    for (const pair of (spec ?? "").split(",")) {
      const i = pair.indexOf("=");
      if (i > 0)
        tokens.set(pair.slice(0, i).trim(), {
          identity: pair.slice(i + 1).trim(),
          role,
          source: "env",
        });
    }
  };
  add(process.env.SETOKU_TOKENS, "analyst");
  add(process.env.SETOKU_CURATOR_TOKENS, "curator");
  add(process.env.SETOKU_JANITOR_TOKENS, "janitor");
  const file = process.env.SETOKU_TOKENS_FILE;
  if (file && fs.existsSync(file)) {
    for (const [token, identity] of Object.entries(
      JSON.parse(fs.readFileSync(file, "utf8")),
    )) {
      tokens.set(token, { identity: String(identity), role: "analyst", source: "file" });
    }
  }
  return tokens;
}

// NOTE: an empty token set is fail-closed, not unauthenticated — identityFor()
// 401s every /mcp request until a token exists. A fresh box deliberately boots
// with ZERO env tokens (bootstrap creates the operator's DB-backed connector
// AFTER `up --wait`), so the zero-token warning lives below, once the store is
// open and DB-backed teammate tokens can be counted too.
const tokens = loadTokens();

/** Mint a 24-byte hex token (same shape as admin-cli). */
function mintToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Provision an analyst token at runtime (the web "Invite teammate" and CLI
 * add-teammate paths): write it to the store, which the request path reads live,
 * so it authenticates IMMEDIATELY — no restart, no env/file surgery. Analyst
 * only — nothing here mints curator/write capability (that stays an operator
 * action, env-pinned, per the membrane I2/I9). `persisted` is always true now
 * (the DB is durable); kept in the return shape for the callers' messaging.
 */
function addAnalystToken(token: string, identity: string): { persisted: boolean } {
  store.addAnalystToken(token, identity, "web-invite");
  return { persisted: true };
}

/**
 * Revoke every analyst token for an identity. Removes the DB-backed teammate
 * tokens (the normal case) AND any legacy in-memory tokens seeded from
 * SETOKU_TOKENS / SETOKU_TOKENS_FILE at boot. Returns how many were removed, and
 * whether any came from SETOKU_TOKENS env (which we can't rewrite — those reappear
 * on restart, so the caller should warn).
 */
function removeAnalystTokens(identity: string): { removed: number; envBacked: boolean } {
  let removed = store.removeAnalystTokensFor(identity);
  let envBacked = false;
  const file = process.env.SETOKU_TOKENS_FILE;
  let fileMap: Record<string, string> = {};
  if (file && fs.existsSync(file)) {
    try {
      fileMap = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* ignore a corrupt file */
    }
  }
  for (const [tok, info] of [...tokens]) {
    // only revoke analyst tokens for this identity (never curator/janitor)
    if (info.role !== "analyst" || info.identity !== identity) continue;
    tokens.delete(tok);
    removed++;
    if (info.source === "file") delete fileMap[tok];
    else envBacked = true; // came from SETOKU_TOKENS env — reappears on restart
  }
  if (file) fs.writeFileSync(file, JSON.stringify(fileMap, null, 2) + "\n");
  return { removed, envBacked };
}

/** Analyst identities currently provisioned — for the Team page (curator/janitor
 *  are operator-held, not team members). Union of DB-backed teammate tokens and
 *  any legacy env/file analyst tokens loaded at boot. */
function analystIdentities(): string[] {
  const fromEnv = [...tokens.values()].filter((t) => t.role === "analyst").map((t) => t.identity);
  return [...new Set([...fromEnv, ...store.analystIdentities()])].sort();
}

/** Identities whose analyst connector is pinned in SETOKU_TOKENS env — the one
 *  kind Remove can only revoke until the next restart. */
function envBackedIdentities(): Set<string> {
  return new Set(
    [...tokens.values()]
      .filter((t) => t.role === "analyst" && t.source === "env")
      .map((t) => t.identity),
  );
}

/** Does this identity ALSO hold an operator (curator/janitor) env token?
 *  Removing the person never touches those (membrane I2/I9) — used only to
 *  say so in the Remove flash. */
function holdsOperatorToken(identity: string): boolean {
  return [...tokens.values()].some((t) => t.role !== "analyst" && t.identity === identity);
}

const store = new KnowledgeStore(process.env.SETOKU_DB_PATH ?? storePath());
// Per-app private datastore — an app's OWN state (annotations, todos, votes),
// isolated from every business data source (the read-only GRANT stays absolute).
// A SEPARATE db file sibling to knowledge.db; there is no code path from here to
// the business DB/lake. See lib/app-store.ts.
const appStore = new AppStore(defaultAppDbPath(process.env.SETOKU_DB_PATH ?? storePath()));
if (store.empty) {
  const imported = seedFromFiles(store, projectDir);
  if (imported > 0) store.audit("system", "seed_from_files", { imported });
}
// Detect a version change across restarts (issue #63): the gateway boots fresh
// after `docker compose up --build`, so a startup where VERSION differs from the
// last one we recorded is a real deploy. Record it now (so a crash-loop doesn't
// re-announce), and remember whether to announce once we're actually listening.
// A first-ever boot (no prior version) is onboarding, not a deploy — no notice.
const previousVersion = store.getKv("last_deployed_version");
const versionChanged = previousVersion !== null && previousVersion !== VERSION;
if (previousVersion !== VERSION) store.setKv("last_deployed_version", VERSION);
// Semantic index for hybrid retrieval (I8 opt-in local embeddings). Built in the
// background so startup isn't blocked; find_context falls back to keyword
// retrieval until (and unless) it's ready. Inert when SETOKU_EMBEDDINGS!=1.
const embedIndex = EmbedIndex.create();
embedIndex.start(() => store.listDocs(), store);

// Per-tenant DERIVED synonym table (issue #33): cluster this tenant's own doc
// vocabulary with the local model OFFLINE, so every domain gets a lexical bridge
// over its own words without hand-editing synonyms.ts. Built in the background;
// inert (base table only) until ready, and when embeddings are off.
const derivedSynonyms = DerivedSynonyms.create();
derivedSynonyms.start(() => store.listDocs());

if (tokens.size === 0 && store.analystIdentities().length === 0) {
  console.error(
    "setoku http: no MCP tokens yet (env SETOKU_TOKENS / SETOKU_TOKENS_FILE / DB) — every /mcp request will 401 until one is provisioned.\n" +
      "  Provision the operator:  bun gateway/admin-cli.ts add-person <email> --role admin",
  );
}

if (store.accountCount === 0) {
  console.error(
    "setoku gateway: no admin accounts yet — the approval surface (/admin) has no one who can sign in.\n" +
      "  Bootstrap one:  bun gateway/admin-cli.ts add-person <email> --role admin",
  );
}

/**
 * One row per person for the Team page: union of agent-token identities and web
 * logins, joined by identity string. hasToken = they have an analyst connector;
 * role = their web-login role if any; envBacked = the connector is pinned in
 * SETOKU_TOKENS env (legacy — Remove only revokes it until the next restart).
 */
function teamPeople(): {
  identity: string;
  hasToken: boolean;
  used: boolean;
  envBacked: boolean;
  role?: string;
}[] {
  const tokenIds = new Set(analystIdentities());
  const envIds = envBackedIdentities();
  const active = store.activeIdentities();
  const accounts = store.listAccounts();
  const ids = new Set<string>([...tokenIds, ...accounts.map((a) => a.username)]);
  return [...ids]
    .sort()
    .map((identity) => ({
      identity,
      hasToken: tokenIds.has(identity),
      used: active.has(identity),
      envBacked: envIds.has(identity),
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
  const pathTok = (req.url ?? "").match(/^\/mcp\/([^/?]+)/);
  const raw = m ? m[1].trim() : pathTok ? decodeURIComponent(pathTok[1]) : null;
  if (!raw) return null;
  // Env/file-seeded tokens first (analyst seed + the operator's curator/janitor);
  // then DB-backed teammate analyst tokens, which authenticate without a restart.
  const seeded = tokens.get(raw);
  if (seeded) return seeded;
  const identity = store.analystTokenIdentity(raw);
  return identity ? { identity, role: "analyst", source: "db" } : null;
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
  // Business-DB mirror freshness (issue #47) — informational, never flips `ok`
  // (a stale mirror degrades app panels, it doesn't down the box). Derived from
  // SETOKU_LAKE_URL like the lake ping; omitted when there is no mirror.
  let mirror: { asOf: string | null; tables: number } | undefined;
  if (process.env.SETOKU_LAKE_URL) {
    const tables = await mirroredTables(process.env.SETOKU_LAKE_URL);
    if (tables.length) mirror = { asOf: mirrorAsOf(tables), tables: tables.length };
  }
  const ok =
    Object.values(deps).every((d) => d.ok) &&
    (disk ? disk.used_pct < 90 : true);
  const value = {
    status: ok ? 200 : 503,
    body: { ok, version: VERSION, docs: store.docCount, disk, deps, ...(mirror ? { mirror } : {}) },
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
  connector: string,
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
  echo "→ Claude Code detected: adding ${connector} connector (user scope)…"
  run claude mcp remove --scope user ${connector} >/dev/null 2>&1 || true
  run claude mcp add --scope user --transport http ${connector} "$URL" --header "Authorization: Bearer $TOKEN"
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

/**
 * Per-source daily ingestion for the last 30 days — one lake query per known
 * source, each independently try/caught (a missing/ungranted table is simply
 * omitted). Powers the Sources sparklines and the /sources/trends chart. Table
 * and column come from the trusted LAKE_SOURCES constant (never user input), so
 * the interpolation is safe — same pattern as gatherSources().
 */
async function gatherSourceSeries(): Promise<SourceSeriesData> {
  const cfg = loadConfig(projectDir);
  const config = cfg.ok ? cfg.config : null;
  const series: SourceSeries[] = [];
  if (config) {
    const lakeUrl = resolveLakeUrl(projectDir, config);
    if (lakeUrl.ok) {
      const qopts = { rowCap: 100, statementTimeoutMs: 8_000 };
      const results = await Promise.all(
        LAKE_SOURCES.map(async (s): Promise<SourceSeries | null> => {
          try {
            const res = await runLakeQuery(
              lakeUrl.url,
              `SELECT toString(toDate(${s.ts})) AS day, count() AS rows
               FROM setoku.${s.table}
               WHERE ${s.ts} >= now() - INTERVAL 30 DAY
               GROUP BY day ORDER BY day`,
              qopts,
            );
            const points = (res.rows as Array<Record<string, unknown>>).map((r) => ({
              day: String(r.day),
              rows: Number(r.rows ?? 0),
            }));
            return points.length ? { source: s.source, points } : null;
          } catch {
            return null; // table absent or not granted — omit this source
          }
        }),
      );
      for (const r of results) if (r) series.push(r);
    }
  }
  return { series };
}

// ---- live-app rendering helpers ----
// The agent-authored template runs in a sandboxed iframe under THIS CSP. Because
// the box INJECTS the data (rather than the template fetching it), the template
// needs no network at all — so default-src 'none' blocks every outbound request,
// closing the exfil-via-author-JS hole a self-contained report would otherwise
// have. Combined with the iframe `sandbox allow-scripts` (opaque origin) it can
// neither reach the box's cookie/API nor phone home.
// `form-action 'none'` is load-bearing: the frame sandbox grants `allow-forms`
// (so an app's <form> submit handler fires — the natural app pattern), but this
// directive blocks any ACTUAL submission from leaving the sandbox. The app's JS
// handles the submit in-page; nothing posts out.
const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

// Per-app FRESH-execution budget for the CREDENTIAL-FREE surface. The per-panel
// cache shields repeated views, but viewer-supplied params (?p.<name>=) create
// unbounded distinct cache variants — each a cache miss = a live prod query — so
// an anonymous hammer could amplify load against the business DB/lake without
// limit (the 256-variant cap even helps the attacker: it evicts+recomputes so the
// cache never saturates as a shield). A token bucket caps the RATE of fresh runs
// per app; once spent, the render is served cache-only (renderApp `tryFreshRun`).
// Authenticated /admin renders are NOT gated — a logged-in viewer is trusted and
// audited, and ?force there is already author/admin-only.
// Sized to comfortably cover human filter-changing (a team poking different date
// ranges) while still capping an automated hammer: ~60 fresh runs/min/app, burst
// 60. Charged per cache-MISS execution, so a normal viewer (cache hits) never
// spends from it; only never-seen variants do.
const PUBLIC_FRESH_BURST = 60; // bucket capacity
const PUBLIC_FRESH_PER_SEC = 1; // sustained refill: ~60 fresh runs/min/app
const freshBudget = new Map<string, { tokens: number; last: number }>();
const refill = (b: { tokens: number; last: number }, now: number): number =>
  Math.min(PUBLIC_FRESH_BURST, b.tokens + ((now - b.last) / 1000) * PUBLIC_FRESH_PER_SEC);
/** Spend one token for a fresh (cache-miss) render of `appId` on the public
 *  surface. Returns false when the bucket is empty → caller renders cache-only. */
function spendFreshRun(appId: string, now: number): boolean {
  const b = freshBudget.get(appId) ?? { tokens: PUBLIC_FRESH_BURST, last: now };
  b.tokens = refill(b, now);
  b.last = now;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  freshBudget.set(appId, b);
  // Opportunistic GC: a long-idle app refills to full and is then indistinguishable
  // from a fresh bucket, so drop fully-refilled entries once the map grows. Bounds
  // it to recently-active apps rather than every app ever publicly viewed.
  if (freshBudget.size > 512)
    for (const [k, v] of freshBudget) if (k !== appId && refill(v, now) >= PUBLIC_FRESH_BURST) freshBudget.delete(k);
  return ok;
}

/** Escape a JSON string for safe inlining inside a <script> tag. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** Assemble the sandboxed frame document: our skeleton + injected panel data +
 *  the agent's template fragment. Every published app is a fragment the runtime
 *  wraps — even one with no panels (a state-only app: a todo, a poll) gets the
 *  runtime + empty data injected, so its `Setoku.*` / `__SETOKU__` calls degrade
 *  ("No data") instead of ReferenceError. The payload is already byte-bounded by
 *  renderApp's capRenderBytes (shared with the provenance drawer so the two
 *  agree). `team` gates raw error text: a public frame must NOT inject a raw DB
 *  error (it can name tables/columns/env vars) — same scrub the public /data
 *  path applies. */
function frameDocument(dash: PublishedReport, panels: RenderedPanel[], opts: { team: boolean; params?: Record<string, string> }): string {
  const scrub = (e: string | null | undefined): string | null =>
    e ? (opts.team ? e : "data temporarily unavailable") : null;
  const data = {
    title: dash.title,
    refreshSeconds: dash.refreshSeconds,
    // The RESOLVED param values actually used for this render (a rejected viewer
    // value shows as the default here). The runtime echoes these to the parent so
    // the control bar reflects what ran — see the params echo in app-runtime.ts.
    params: opts.params ?? {},
    panels: Object.fromEntries(
      panels.map((p) => [
        p.key,
        {
          columns: p.columns,
          rows: p.rows as unknown[],
          rowCount: p.rowCount,
          // The served rows are a prefix of a larger result — drives the built-in
          // table's "showing first N" note so a byte-trimmed panel isn't silent.
          truncated: p.truncated ?? false,
          computedAt: p.computedAt,
          error: scrub(p.error),
          refreshError: scrub(p.refreshError),
          refreshing: p.refreshing ?? false,
          // Run duration is team-only telemetry — don't leak perf shape publicly.
          durationMs: opts.team ? (p.durationMs ?? null) : null,
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
    `<script>${APP_RUNTIME}</script>` +
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
// handler), so a public link is the visual app and nothing else.
function appProvenance(
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
    params: meta.params ?? [],
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
        truncated: r?.truncated ?? false,
        computedAt: r?.computedAt ?? null,
        error: r?.error ?? null,
        refreshError: r?.refreshError ?? null,
        refreshing: r?.refreshing ?? false,
        durationMs: r?.durationMs ?? null,
      };
    }),
  };
}

/** Mirror "data as of" for an app (issue #47): the oldest fresh copy among the
 *  biz.* tables its clickhouse panels read — an app is only as current as its
 *  stalest input. Null when the app doesn't touch the mirror. Best-effort and
 *  cached (lib/mirror), so the freshness polls stay cheap. */
async function appMirrorAsOf(meta: PublishedMeta): Promise<string | null> {
  const chPanels = (meta.panels ?? []).filter((p) => p.dialect === "clickhouse");
  if (!chPanels.length) return null;
  try {
    const cfg = loadConfig(projectDir);
    if (!cfg.ok) return null;
    const lake = resolveLakeUrl(projectDir, cfg.config);
    if (!lake.ok) return null;
    const tables = await mirroredTables(lake.url);
    const refs = [...new Set(chPanels.flatMap((p) => referencedBizTables(p.sql, tables)))];
    return refs.length ? mirrorAsOf(tables, refs) : null;
  } catch {
    return null;
  }
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

/** The credential-free public app shell at /p/<id>. (The team surface uses
 *  the React app, which renders the same frame + provenance.) Provenance here
 *  shows methodology only — never raw SQL. */
/** Server-rendered stone controls for an app's declared params (chrome — never an
 *  accent color). Each carries `data-pname`; the shell's JS gathers their values
 *  into `?p.<name>=…` and re-requests the frame. Defaults are pre-selected. */
function paramControlsHtml(params: AppParam[]): string {
  if (!params.length) return "";
  const ctrl = (p: AppParam): string => {
    const nm = escapeHtml(p.name);
    if (p.type === "enum") {
      const opts = (p.options ?? [])
        .map((o) => `<option value="${escapeHtml(o.value)}"${o.value === p.default ? " selected" : ""}>${escapeHtml(o.label || o.value)}</option>`)
        .join("");
      return `<select data-pname="${nm}">${opts}</select>`;
    }
    if (p.type === "bool")
      return `<select data-pname="${nm}"><option value="true"${p.default === true ? " selected" : ""}>Yes</option><option value="false"${p.default !== true ? " selected" : ""}>No</option></select>`;
    const type = p.type === "int" ? "number" : p.type === "date" ? "date" : "text";
    const extra =
      p.type === "int"
        ? ` step="1"${p.min != null ? ` min="${p.min}"` : ""}${p.max != null ? ` max="${p.max}"` : ""}`
        : p.type === "text" && p.maxLength != null
          ? ` maxlength="${p.maxLength}"`
          : "";
    return `<input type="${type}" data-pname="${nm}"${extra} value="${escapeHtml(String(p.default ?? ""))}">`;
  };
  return (
    `<div id="controls">` +
    params.map((p) => `<label class="pc"><span>${escapeHtml(p.label || p.name)}</span>${ctrl(p)}</label>`).join("") +
    `</div>`
  );
}

/** The RESOLVED param values for a render, as control-display strings: the
 *  viewer's raw value when it coerces, else the default (so a rejected value
 *  shows as the fallback, not what they typed). Injected into the frame and
 *  echoed to the control bar so the controls always reflect what actually ran. */
function resolvedParamValues(declared: AppParam[], rawParams: Record<string, string>): Record<string, string> {
  if (!declared.length) return {};
  try {
    const resolved = resolveParams(declared, rawParams);
    const out: Record<string, string> = {};
    for (const p of declared) {
      const v = resolved.get(p.name);
      out[p.name] = v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? "" : String(v);
    }
    return out;
  } catch {
    return {}; // published params are validated; defensive only
  }
}

/** Viewer-supplied param values from a frame/shell request: `?p.<name>=value`.
 *  Raw strings — renderApp coerces each to its declared type (or the default). */
function parseFrameParams(reqUrl: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const [k, v] of new URL(reqUrl ?? "", "http://x").searchParams) {
      if (k.startsWith("p.")) out[k.slice(2)] = v;
    }
  } catch {
    /* malformed URL — no params */
  }
  return out;
}

function publicAppShell(opts: {
  title: string;
  framePath: string;
  dataPath: string;
  statePath: string;
  adminPath: string;
  refreshSeconds: number;
  /** False for a panel-less app (state-only) — no live data to stamp or poll, so
   *  the shell shows no "updated …" line and never auto-reloads the frame (which
   *  would wipe in-progress input). */
  hasPanels: boolean;
  /** Declared interactive inputs — rendered as stone controls in the header; the
   *  shell re-requests the frame with `?p.<name>=…` when one changes. */
  params: AppParam[];
}): string {
  const title = escapeHtml(opts.title || "App");
  const cfg = jsonForScript({ frame: opts.framePath, data: opts.dataPath, state: opts.statePath, admin: opts.adminPath, refresh: opts.refreshSeconds, hasPanels: opts.hasPanels });
  const controls = paramControlsHtml(opts.params);
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
  /* very subtle attribution — stone-family, no accent (neutral-chrome rule) */
  .brand{margin-left:auto;font-size:.72rem;color:#a8a29e;text-decoration:none;letter-spacing:.01em;white-space:nowrap}
  .brand:hover{color:#78716c;text-decoration:underline}
  .adminbtn{display:none;font-size:.8rem;text-decoration:none;color:#44403c;border:1px solid #d6d3d1;background:#fafaf9;padding:.2rem .6rem;border-radius:.4rem}
  .adminbtn:hover{background:#f5f5f4}
  main{flex:1;min-height:0;display:flex;position:relative}
  iframe{flex:1;width:100%;border:0;background:#fff}
  /* loader over the reloading frame (param change / refresh) — the transition
     delay keeps a fast cached load from flashing it */
  #ldr{pointer-events:none;position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.55);opacity:0;transition:opacity .15s .15s}
  #ldr.on{opacity:1}
  #ldr .card{display:flex;align-items:center;gap:.5rem;border:1px solid #e7e5e4;background:#fff;border-radius:.5rem;padding:.35rem .7rem;font-size:.8rem;color:#78716c;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  #ldr .sp{width:12px;height:12px;border:2px solid #d6d3d1;border-top-color:#57534e;border-radius:50%;animation:ldrspin .8s linear infinite}
  @keyframes ldrspin{to{transform:rotate(360deg)}}
  #controls{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .9rem;width:100%;margin-top:.1rem}
  .pc{display:inline-flex;align-items:center;gap:.4rem;font-size:.8rem;color:#57534e}
  .pc select,.pc input{font:inherit;font-size:.8rem;color:#1c1917;background:#fff;border:1px solid #d6d3d1;border-radius:.4rem;padding:.18rem .45rem}
  .pc select:focus,.pc input:focus{outline:none;border-color:#a8a29e;box-shadow:0 0 0 2px #e7e5e4}
</style></head><body>
<header><h1>${title}</h1><span class="muted" id="stamp"></span><a class="brand" href="https://setoku.com" target="_blank" rel="noopener noreferrer">Made with Setoku</a><a id="adminlink" class="adminbtn" href="">Admin view →</a>${controls}</header>
<main><iframe id="frame" title="${title}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><div id="ldr"><div class="card"><span class="sp"></span>updating…</div></div></main>
<script>
(function(){
  var CFG=${cfg};
  var frame=document.getElementById('frame'), stamp=document.getElementById('stamp');
  // App-state bridge (public): the sandboxed frame has no network, so it
  // postMessages state ops up to this shell — the policy gate. We pin the app id
  // (CFG.state) and pass an anonymous per-browser id as the owner for viewer
  // scope; app scope is shared by everyone with the link. Mirrors the admin
  // AppView mediator, minus the session (this surface is credential-free).
  var VKEY='setoku_av_'+location.pathname, viewerId;
  try{ viewerId=localStorage.getItem(VKEY); if(!viewerId){ viewerId='v'+Date.now().toString(36)+Math.random().toString(36).slice(2,8); localStorage.setItem(VKEY,viewerId);} }catch(e){ viewerId='anon'; }
  window.addEventListener('message', function(e){
    var m=e.data; if(!m) return;
    if(e.source!==frame.contentWindow) return; // only OUR iframe
    // Resolved-param echo: reset each control to the value the server actually
    // used, so a rejected input snaps back to the default instead of lingering.
    if(m.__setoku_params_echo===true){ document.querySelectorAll('[data-pname]').forEach(function(el){
      var v=m.params&&m.params[el.getAttribute('data-pname')]; if(v!==undefined&&v!==null) el.value=v; }); return; }
    if(m.__setoku_state_req!==true) return;
    var scope=m.scope==='viewer'?'viewer':'app', owner=scope==='viewer'?viewerId:'';
    var reply=function(b){ b.__setoku_state_res=true; b.id=m.id; frame.contentWindow.postMessage(b,'*'); };
    function done(p){ p.then(function(r){ return r.json().catch(function(){return {};}).then(function(d){
        // A non-2xx (e.g. 413 over-quota, 404) must REJECT, not resolve undefined —
        // otherwise Setoku.state.set() silently "succeeds" and the write vanishes.
        if(!r.ok) throw new Error((d&&d.error)||('request failed ('+r.status+')'));
        return d; }); }).then(function(d){
        if(m.op==='list') reply({result:d.entries||[]});
        else if(m.op==='get'){ var hit=(d.entries||[]).filter(function(x){return x.key===String(m.key)})[0]; reply({result:hit?hit.value:null}); }
        else if(m.op==='set') reply({result:d.entry});
        else reply({result:d.deleted});
      }).catch(function(err){ reply({error:String((err&&err.message)||err)}); }); }
    if(m.op==='get'||m.op==='list'){ done(fetch(CFG.state+'?scope='+scope+'&owner='+encodeURIComponent(owner),{credentials:'omit'})); }
    else if(m.op==='set'||m.op==='delete'){ done(fetch(CFG.state,{method:'POST',headers:{'content-type':'application/json'},credentials:'omit',body:JSON.stringify({op:m.op,scope:scope,owner:owner,key:String(m.key),value:m.value})})); }
    else { reply({error:'bad op'}); }
  });
  function rel(iso){ if(!iso) return ''; var s=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));
    if(s<60) return s+'s ago'; var m=Math.round(s/60); if(m<60) return m+'m ago';
    var h=Math.round(m/60); return h<48? h+'h ago' : Math.round(h/24)+'d ago'; }
  // Gather the current control values into the frame query (?p.<name>=…) so every
  // frame load — initial, on a control change, and the auto-refresh — runs the
  // panels bound to the viewer's current selection.
  function paramQuery(){ var parts=[]; document.querySelectorAll('[data-pname]').forEach(function(el){
    parts.push('p.'+encodeURIComponent(el.getAttribute('data-pname'))+'='+encodeURIComponent(el.value)); }); return parts.join('&'); }
  var ldr=document.getElementById('ldr'), ldrT=null;
  function ldrOff(){ ldr.classList.remove('on'); if(ldrT){ clearTimeout(ldrT); ldrT=null; } }
  frame.addEventListener('load', ldrOff);
  // watchdog: a navigation that never completes (box restart, dropped network)
  // must not leave the page dimmed behind a permanent spinner
  function reload(){ ldr.classList.add('on'); if(ldrT) clearTimeout(ldrT); ldrT=setTimeout(ldrOff, 25000);
    var q=paramQuery(); frame.src=CFG.frame+'?'+(q?q+'&':'')+'t='+Date.now(); }
  document.querySelectorAll('[data-pname]').forEach(function(el){ el.addEventListener('change', function(){ reload(); }); });
  function refresh(){ fetch(CFG.data,{credentials:'omit'}).then(function(r){return r.json()}).then(function(d){
    var secs=d.refreshSeconds||CFG.refresh;
    var iv=secs<60?secs+'s':secs<3600?Math.round(secs/60)+'m':Math.round(secs/3600)+'h';
    // Omit the "data updated …" clause when there's no successful data yet (null
    // stamp — e.g. every panel currently errored) rather than render a blank time.
    stamp.textContent=(d.updatedAt?'data updated '+rel(d.updatedAt)+' · ':'')+(d.mirrorAsOf?'source data as of '+rel(d.mirrorAsOf)+' · ':'')+'auto-refreshes every '+iv;
  }).catch(function(){}); }
  // Reveal the Admin link only if this viewer has a box session (the cookie is
  // Path=/admin, so it rides along to /admin/api/session but not to /p/*).
  fetch('/admin/api/session',{credentials:'include'}).then(function(r){
    if(r.ok){ var a=document.getElementById('adminlink'); a.href=CFG.admin; a.style.display='inline-block'; }
  }).catch(function(){});
  reload();
  // Only apps with data panels have something to stamp/poll and re-run on a TTL.
  // A state-only app shows no freshness line and never auto-reloads (a reload
  // would wipe whatever the viewer was typing); its state persists server-side.
  if (CFG.hasPanels) {
    refresh();
    setInterval(function(){ reload(); refresh(); }, Math.max(30,CFG.refresh)*1000);
  }
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
      // seeded (env/file) tokens, then DB-backed teammate tokens — the default
      // since invites/add-person write to the store.
      const dbIdentity = store.analystTokenIdentity(token);
      const info =
        tokens.get(token) ??
        (dbIdentity ? ({ identity: dbIdentity, role: "analyst", source: "db" } as TokenInfo) : null);
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
      res.end(installerScript(token, info.identity, baseUrl, connectorName(projectDir)));
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
      // Every app renders via the runtime path whether or not it has data panels:
      // a chart app has panels; a state-only app (todo/poll) has none but still
      // wants the runtime + no-network frame.
      const hasPanels = (meta.panels?.length ?? 0) > 0;

      // /data is the freshness poll — meaningful only with panels.
      if (sub === "data" && !hasPanels) return notFound();

      // /p/<id>/data — FRESHNESS ONLY for the public shell's "updated …" stamp.
      // The public surface exposes NO calculations (no SQL, descriptions, metrics).
      // Reads the newest cached computed_at directly — does NOT re-run any query
      // (the /frame request drives execution; this credential-free poll must not).
      if (sub === "data") {
        store.audit("public", "app_data_public", { id });
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
            // mirror freshness is methodology-safe (a timestamp, no schema/SQL)
            mirrorAsOf: await appMirrorAsOf(meta),
          }),
        );
        return;
      }

      // /p/<id>/state — per-app private datastore on the PUBLIC surface.
      // Reached only for public-visibility apps (the meta gate above already
      // 404s team/missing/archived). Credential-free, so there is no session
      // identity: `app` scope is shared by everyone with the link; `viewer` scope
      // is keyed to an anonymous per-browser id the public shell mints and passes
      // as `owner` (unguessable, so practically isolated — but, lacking a login,
      // it's best-effort per-browser privacy, not a hard security boundary). Still
      // can't touch any business source, and stays bounded by the AppStore quota.
      if (sub === "state") {
        const url = new URL(req.url ?? "", "http://x");
        const scope = (url.searchParams.get("scope") ?? "app") as StateScope;
        if (scope !== "app" && scope !== "viewer") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad scope" }));
          return;
        }
        const jsonOut = (status: number, body: unknown): void => {
          res.writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
          res.end(JSON.stringify(body));
        };
        if (req.method === "GET") {
          const owner = scope === "viewer" ? url.searchParams.get("owner") || "" : null;
          return jsonOut(200, { ok: true, entries: appStore.list(id, scope, owner) });
        }
        if (req.method === "POST") {
          const body = (await readBody(req)) as { op?: string; scope?: string; owner?: string; key?: string; value?: unknown } | undefined;
          const owner = scope === "viewer" ? String(body?.owner ?? "") : null;
          const key = String(body?.key ?? "");
          try {
            if (body?.op === "set") {
              const entry = appStore.set(id, scope, owner, key, body.value, new Date().toISOString());
              store.audit("public", "app_state_set_public", { id, scope, key });
              return jsonOut(200, { ok: true, entry });
            }
            if (body?.op === "delete") return jsonOut(200, { ok: true, deleted: appStore.delete(id, scope, owner, key) });
            return jsonOut(400, { ok: false, error: "bad op" });
          } catch (e) {
            if (e instanceof AppStoreQuotaError) return jsonOut(413, { ok: false, error: e.message });
            throw e;
          }
        }
        return notFound();
      }

      // /p/<id>/frame — the sandboxed render document (data injected, no network).
      if (sub === "frame") {
        const rep = store.getPublished(id);
        if (!rep) return notFound();
        const raw = parseFrameParams(req.url);
        // Bound prod load on this credential-free link: each would-be fresh (cache-
        // miss) panel run spends from the app's token bucket; once empty, the panel
        // renders cache-only, so distinct ?p.<name>= values can't keep missing the
        // cache and re-hitting prod. Charged per execution → cached hits are free.
        const panels = await renderApp(store, projectDir, rep, {
          rawParams: raw,
          tryFreshRun: () => spendFreshRun(id, Date.now()),
        });
        store.audit("public", "app_frame_public", { id });
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `${FRAME_CSP}; sandbox allow-scripts allow-forms`,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        res.end(frameDocument(rep, panels, { team: false, params: resolvedParamValues(rep.params ?? [], raw) }));
        return;
      }

      if (sub) return notFound(); // unknown subpath

      store.audit("public", "published_viewed_public", { id });
      // Serve the trusted outer shell (frames /p/<id>/frame, polls /p/<id>/data).
      // The agent template never runs in this top-level origin.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": SHELL_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(
        publicAppShell({
          title: meta.title,
          framePath: `/p/${encodeURIComponent(id)}/frame`,
          dataPath: `/p/${encodeURIComponent(id)}/data`,
          statePath: `/p/${encodeURIComponent(id)}/state`,
          adminPath: `/admin/p/${encodeURIComponent(id)}`,
          refreshSeconds: meta.refreshSeconds ?? 300,
          hasPanels,
          params: meta.params ?? [],
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

      // ---- team app frame — /admin/frame/<id>, session-gated ----
      // The sandboxed render document for a TEAM app. Requires a box
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
        const raw = parseFrameParams(req.url);
        // ?force=1 bypasses the cache and re-runs the selected variant — author or
        // admin only, so a member (or a stale tab) can't hammer prod through the
        // iframe. The React viewer adds it for an explicit "Refresh data".
        const force =
          new URL(req.url ?? "", "http://x").searchParams.get("force") === "1" &&
          (rep.createdBy === session.identity || canApprove(session.role));
        const panels = (rep.panels?.length ?? 0) > 0 ? await renderApp(store, projectDir, rep, { rawParams: raw, force }) : [];
        store.audit(session.identity, force ? "app_frame_refreshed" : "app_frame_viewed", { id });
        // The app template needs no network (data is injected) → strict CSP.
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `${FRAME_CSP}; sandbox allow-scripts allow-forms`,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        res.end(frameDocument(rep, panels, { team: true, params: resolvedParamValues(rep.params ?? [], raw) }));
        return;
      }

      // ---- JSON API ----
      if (reqPath.startsWith("/admin/api/")) {
        const api = reqPath.slice("/admin/api/".length);
        // When a request slides the session window forward, re-issue the cookie so
        // the browser's copy slides too (Max-Age is relative to each Set-Cookie).
        let renewedCookie: string | undefined;
        const json = (status: number, body: unknown): void => {
          const headers: Record<string, string> = {
            "content-type": "application/json",
            "referrer-policy": "no-referrer",
          };
          if (renewedCookie) headers["set-cookie"] = renewedCookie;
          res.writeHead(status, headers);
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

        // Sliding window: an active (non-logout) session renews on use, so a
        // working admin never gets logged out mid-use — only 14 days idle does.
        // Throttled inside, and the re-issued cookie slides the browser's copy too.
        if (sessions.renew(sid, session)) renewedCookie = sessionSetCookie(sid!);

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
        if (api === "source_series" && req.method === "GET") return json(200, await gatherSourceSeries());
        if (api === "team" && req.method === "GET")
          return json(200, { people: teamPeople(), adminCount: store.countRole("admin") });

        // published apps/reports — TEAM-ONLY: gated behind this session
        // check, so a shared /admin/p/<id> link only renders for a box login.
        // The list UI needs only panel COUNT, not the queries — strip each panel's
        // raw SQL so the list doesn't broadcast every app's query text to all
        // members (SQL stays team-tier, shown only in the per-app drawer).
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
        if (api === "app_data" && req.method === "GET") {
          const url = new URL(req.url ?? "", "http://x");
          const id = url.searchParams.get("id") ?? "";
          const meta = store.getPublishedMeta(id);
          if (!meta || meta.archivedAt) return json(404, { ok: false, error: "app not found or archived" });
          // Param-INDEPENDENT metadata only (titles, SQL, descriptions). The live
          // per-variant numbers come from the frame's provenance echo, so this
          // endpoint does NOT render any panel — it just reads the freshness stamp
          // from the cache (no query). Keeps the metadata fetch off the DB entirely.
          const prov = appProvenance(store, meta, []);
          prov.updatedAt = store.newestPanelComputedAt(id);
          prov.mirrorAsOf = await appMirrorAsOf(meta);
          // Last-editor stamp for the header (#58) — the newest version's author +
          // time, shown once an app has actually been edited (versions > 1).
          const edit = store.latestAppEdit(id);
          if (edit) {
            prov.editedBy = edit.editor;
            prov.editedAt = edit.ts;
            prov.versions = edit.versions;
          }
          store.audit(session.identity, "app_viewed", { id });
          return json(200, prov);
        }

        // Version history for the header's version drawer (#58): every content
        // edit, newest first, with who made it and when. Team-only (like the
        // provenance drawer) — an authenticated box session; the public /p shell
        // never sees it. Bodies are omitted (a restore fetches them server-side).
        if (api === "app_history" && req.method === "GET") {
          const url = new URL(req.url ?? "", "http://x");
          const id = url.searchParams.get("id") ?? "";
          const meta = store.getPublishedMeta(id);
          if (!meta || meta.archivedAt) return json(404, { ok: false, error: "app not found or archived" });
          const revs = store.listAppHistory(id);
          const current = revs.length ? revs[0].seq : 0; // newest seq === live state
          return json(200, revs.map((r) => ({ ...r, current: r.seq === current })));
        }

        // ---- app state (per-app private datastore) ----
        // An app reads/writes its OWN state here; this never touches a business
        // data source. The app id comes from the request, but every op is scoped
        // by (id, scope, owner) so an app can only see its own state, and viewer
        // scope is keyed to THIS session's identity (one viewer can't read
        // another's). Any signed-in user may use an app (members included).
        if (api === "app_state" && req.method === "GET") {
          const url = new URL(req.url ?? "", "http://x");
          const id = url.searchParams.get("id") ?? "";
          const scope = (url.searchParams.get("scope") ?? "app") as StateScope;
          if (scope !== "app" && scope !== "viewer") return json(400, { ok: false, error: "bad scope" });
          const meta = store.getPublishedMeta(id);
          if (!meta || meta.archivedAt) return json(404, { ok: false, error: "app not found" });
          const owner = scope === "viewer" ? session.identity : null;
          return json(200, {
            ok: true,
            entries: appStore.list(id, scope, owner),
            usage: appStore.usage(id, scope, owner),
          });
        }

        // ---- mutations: CSRF (header) + admin role, mirroring the old form posts ----
        if (req.method === "POST") {
          if ((req.headers["x-csrf-token"] ?? "") !== session.csrf)
            return json(403, { ok: false, error: "bad csrf token" });

          // App state write — any signed-in user may use a published app (members
          // included), so this sits BEFORE the admin-only gate below. It writes
          // only the app's own sandbox; quota errors surface as 413.
          if (api === "app_state") {
            const body = (await readBody(req)) as
              | { id?: string; op?: string; scope?: string; key?: string; value?: unknown }
              | undefined;
            const id = (body?.id ?? "").trim();
            const scope = (body?.scope ?? "app") as StateScope;
            if (scope !== "app" && scope !== "viewer") return json(400, { ok: false, error: "bad scope" });
            const meta = id ? store.getPublishedMeta(id) : null;
            if (!meta || meta.archivedAt) return json(404, { ok: false, error: "app not found" });
            const owner = scope === "viewer" ? session.identity : null;
            const key = String(body?.key ?? "");
            try {
              if (body?.op === "set") {
                const entry = appStore.set(id, scope, owner, key, body.value, new Date().toISOString());
                store.audit(session.identity, "app_state_set", { id, scope, key });
                return json(200, { ok: true, entry });
              }
              if (body?.op === "delete")
                return json(200, { ok: true, deleted: appStore.delete(id, scope, owner, key) });
              return json(400, { ok: false, error: "bad op" });
            } catch (e) {
              if (e instanceof AppStoreQuotaError) return json(413, { ok: false, error: e.message });
              throw e;
            }
          }

          // Author-or-admin gate for a per-app mutation (archive, visibility):
          // 404 if missing/archived, 403 unless the caller authored it or is an
          // admin. Returns false having ALREADY sent the response, so the handler
          // returns immediately. These two are allowed before the blanket admin
          // gate below (a member can manage their own app); every OTHER
          // mutation stays admin-only. The agent never reaches here — it has no
          // web session — so promotion-to-public is always a human decision.
          const mayMutateApp = (id: string): boolean => {
            const rep = id ? store.getPublishedMeta(id) : null;
            if (!rep || rep.archivedAt) {
              json(404, { ok: false, error: "No active app with that id." });
              return false;
            }
            if (rep.createdBy !== session.identity && !canApprove(session.role)) {
              store.audit(session.identity, "admin_mutation_denied", { api, role: session.role });
              json(403, { ok: false, error: "Only the app's author or an admin can manage it." });
              return false;
            }
            return true;
          };

          if (api === "archive") {
            const body = (await readBody(req)) as { id?: string } | undefined;
            const id = (body?.id ?? "").trim();
            if (!mayMutateApp(id)) return;
            const ok = store.archivePublished(id);
            store.audit(session.identity, "unpublish_app", { id, ok });
            return json(200, { ok, flash: "Archived — its link no longer works." });
          }

          // Rename (title only) — author-or-admin, same gate as archive/visibility.
          if (api === "rename") {
            const body = (await readBody(req)) as { id?: string; title?: string } | undefined;
            const id = (body?.id ?? "").trim();
            const title = (body?.title ?? "").trim();
            if (!title) return json(400, { ok: false, error: "Title can't be empty." });
            if (title.length > 200) return json(400, { ok: false, error: "Title is too long (max 200 characters)." });
            if (!mayMutateApp(id)) return;
            const ok = store.updatePublished(id, { title }, { editor: session.identity });
            store.audit(session.identity, "rename_app", { id, ok });
            return json(200, { ok, title, flash: "Renamed." });
          }

          // Restore an earlier version (#58) — author-or-admin, same gate as
          // rename. Copies the chosen snapshot's content forward as a NEW version
          // (append-only, so the restore is itself undoable) and clears the panel
          // cache (restored panels recompute on next view). If the restored
          // content changes what a PUBLIC app exposes, it drops to team-only — an
          // admin must re-publish it (the human promotion gate, I9), mirroring
          // update_app.
          if (api === "revert") {
            const body = (await readBody(req)) as { id?: string; seq?: number } | undefined;
            const id = (body?.id ?? "").trim();
            const seq = Number(body?.seq);
            if (!Number.isInteger(seq) || seq < 1) return json(400, { ok: false, error: "Bad version." });
            if (!mayMutateApp(id)) return;
            const meta = store.getPublishedMeta(id); // current state (for the visibility check)
            const snap = store.getAppRevision(id, seq);
            if (!meta || !snap) return json(404, { ok: false, error: "No such version." });
            const norm = (v: unknown): string => JSON.stringify(v ?? []);
            const dataChanged = norm(snap.panels) !== norm(meta.panels) || norm(snap.params) !== norm(meta.params);
            const ok = store.updatePublished(
              id,
              {
                title: snap.title,
                body: snap.body,
                panels: snap.panels ?? [], // [] rewrites to no-panels + clears cache
                params: snap.params ?? [],
                refreshSeconds: snap.refreshSeconds,
              },
              { editor: session.identity, note: `Restored version ${seq}` },
            );
            // `error` (not `flash`) on failure — the SPA surfaces `error` on a
            // non-2xx; a `flash` here would be dropped and shown as "HTTP 409".
            if (!ok)
              return json(409, { ok: false, error: "Couldn't restore that version — the app may have just been archived." });
            let reverted = false;
            if (dataChanged && meta.visibility === "public") {
              store.setReportVisibility(id, "team");
              reverted = true;
            }
            // Re-seed the cache from the restored version and check its panels
            // still run — the snapshot was valid when saved, but the schema/config
            // may have drifted since. Uses the same governed viewer render path
            // (not the agent's prepPanels), so it's the right identity/membrane and
            // any breakage surfaces NOW instead of on the next viewer. Best-effort.
            let panelWarning = "";
            const restored = store.getPublished(id);
            if (restored && (restored.panels?.length ?? 0) > 0) {
              try {
                const broken = (await renderApp(store, projectDir, restored, { force: true })).filter((p) => p.error);
                if (broken.length)
                  panelWarning = ` Heads up: ${broken.length} panel(s) no longer run against the current data (${broken
                    .map((p) => p.key)
                    .join(", ")}) — this version may predate a schema change.`;
              } catch {
                // A re-seed failure must not fail the restore; the next view recomputes.
              }
            }
            store.audit(session.identity, "revert_app", { id, seq, reverted, brokenPanels: !!panelWarning });
            return json(200, {
              ok: true,
              flash:
                (reverted
                  ? `Restored version ${seq} — its data changed, so it reverted to team-only; an admin can re-publish it publicly.`
                  : `Restored version ${seq}.`) + panelWarning,
            });
          }

          // Restore an archived app. Author-or-admin, but (unlike the other
          // per-app mutations) it operates on an ARCHIVED row, so it gates
          // here rather than via mayMutateApp (which 404s archived rows).
          if (api === "unarchive") {
            const body = (await readBody(req)) as { id?: string } | undefined;
            const id = (body?.id ?? "").trim();
            const rep = id ? store.getPublishedMeta(id) : null;
            if (!rep || !rep.archivedAt) return json(404, { ok: false, error: "No archived app with that id." });
            if (rep.createdBy !== session.identity && !canApprove(session.role)) {
              store.audit(session.identity, "admin_mutation_denied", { api, role: session.role });
              return json(403, { ok: false, error: "Only the app's author or an admin can restore it." });
            }
            const ok = store.unarchivePublished(id);
            store.audit(session.identity, "unarchive_app", { id, ok });
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
            if (!mayMutateApp(id)) return;
            // Making an app PUBLIC (a credential-free link) is an ADMIN action
            // (I9) — an author can take it back to team-only, but not expose it.
            if (visibility === "public" && !canApprove(session.role)) {
              store.audit(session.identity, "admin_mutation_denied", { api, role: session.role });
              return json(403, { ok: false, error: "Only an admin can make an app public." });
            }
            const ok = store.setReportVisibility(id, visibility);
            store.audit(session.identity, "app_visibility_set", { id, visibility, ok });
            return json(ok ? 200 : 404, {
              ok,
              flash: ok
                ? visibility === "public"
                  ? "Now PUBLIC — anyone with the /p link can open it, no login required."
                  : "Now team-only."
                : "No active app with that id.",
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
              // Sessions snapshot the role at sign-in — kill them so the change
              // takes effect NOW (a demoted admin must not keep approve power
              // for the 14-day session lifetime; a promote re-logs-in too).
              store.destroySessionsFor(uname);
              store.audit(session.identity, "account_role_changed", { username: uname, role });
              return json(200, { ok: true, flash: `${uname} is now ${role} — they'll need to sign in again.` });
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
              // Person-level remove: works for EVERY row — login-only, token-only,
              // or both. 404 only when there is literally nothing to remove.
              const hadToken = analystIdentities().includes(uname);
              if (!acct && !hadToken)
                return json(404, { ok: false, error: `No person "${uname}" (no login, no connector).` });
              if (isLastAdmin(acct)) return json(409, { ok: false, error: "Can't remove the last admin." });
              if (acct) store.deleteAccount(uname);
              const { removed, envBacked } = removeAnalystTokens(uname);
              const sessionsKilled = store.destroySessionsFor(uname);
              store.audit(session.identity, "person_removed", {
                username: uname,
                accountDeleted: !!acct,
                tokensRevoked: removed,
                sessionsKilled,
                envBacked,
              });
              let flash = `Removed ${uname} (${acct ? "login deleted, " : ""}${removed} connector${removed === 1 ? "" : "s"} revoked).`;
              if (envBacked)
                flash +=
                  " One token is pinned in SETOKU_TOKENS in the box's .env — it's revoked now but returns on restart; delete it from .env and `docker compose up -d server` to make it permanent.";
              if (holdsOperatorToken(uname))
                flash += " Note: this identity also holds an operator (curator/janitor) token in the box's env — unaffected.";
              return json(200, { ok: true, flash });
            }
            return json(400, { ok: false, error: "Unknown operation." });
          }

          return json(404, { ok: false, error: "unknown endpoint" });
        }

        return json(404, { ok: false, error: "unknown endpoint" });
      }

      // A logged-OUT visitor to /admin/p/<id> for a PUBLIC app should see
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
    // The token's role IS the membrane (I2/I9): capabilities are derived from it,
    // so commit-knowledge and read-the-lake can never coexist on one session.
    const server = buildServer({
      projectDir,
      store,
      user: auth.identity,
      role: auth.role,
      embedIndex,
      derivedSynonyms,
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
  // Announce a new deployed version once the box is actually serving it (issue
  // #63). Detached + best-effort; a no-op unless a notify webhook is configured.
  if (versionChanged) {
    const cfg = loadConfig(projectDir);
    void notifyActivity(projectDir, {
      kind: "deploy",
      version: VERSION,
      previous: previousVersion,
      box: cfg.ok ? cfg.config.name ?? null : null,
    });
  }
});
