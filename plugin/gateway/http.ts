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
 *   SETOKU_TOKENS_FILE    — optional JSON file { "token": "identity", ... } (merged, analyst)
 *   SETOKU_HTTP_PORT    — default 8787
 *   <dataSource.urlEnv> — the Postgres URL env var named in config.json
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer } from "./app";
import { loadConfig, resolveProjectDir } from "./lib/config";
import { KnowledgeStore, defaultDbPath, seedFromFiles } from "./lib/store";
import {
  renderApprovalPage,
  renderLoginPage,
  renderAuditPage,
  renderKnowledgePage,
  renderSourcesPage,
  renderTeamPage,
  type Invite,
  applyApprovalAction,
  SessionStore,
  sessionIdFromCookie,
  sessionSetCookie,
  sessionClearCookie,
  setStylesheetHref,
  type SourcesData,
  type SourceTable,
} from "./lib/approval";
import { authenticate, canApprove, hashPassword, isRole } from "./lib/accounts";
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
setStylesheetHref(`/admin/app.css?v=${ADMIN_CSS_VER}`);

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
}

function loadTokens(): Map<string, TokenInfo> {
  const tokens = new Map<string, TokenInfo>();
  const add = (spec: string | undefined, curator: boolean): void => {
    for (const pair of (spec ?? "").split(",")) {
      const i = pair.indexOf("=");
      if (i > 0)
        tokens.set(pair.slice(0, i).trim(), {
          identity: pair.slice(i + 1).trim(),
          curator,
        });
    }
  };
  add(process.env.SETOKU_TOKENS, false);
  add(process.env.SETOKU_CURATOR_TOKENS, true);
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

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Approval-surface sessions — the human authenticates once with their token
// and gets an opaque cookie; the token never rides in a URL (no Slack/referer/
// history leakage). One process, so in-memory is fine.
const sessions = new SessionStore(store);

// One-time render state for Post/Redirect/Get: a mutating POST (invite, account
// op) stashes its shown-once result here keyed by session, then 303-redirects;
// the next GET /admin/team consumes and clears it. Without PRG, refreshing the
// POST response re-submits it — re-minting tokens on every refresh.
type TeamFlash = {
  invite?: Invite;
  newLogin?: { username: string; role: string; tempPassword: string };
  flash?: string;
};
const teamFlash = new Map<string, TeamFlash>();

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
    body: { ok, docs: store.docCount, disk, deps },
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
              return { source: s.source, rows, last: rows > 0 ? String(row.last) : null };
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

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, docs: store.docCount }));
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
    // ---- web approval surface (Phase 5.5) — the human accept/reject path ----
    // Auth is a session COOKIE, not a token in the URL: the link (/admin) is
    // safe to share; the token only ever travels in the POST /admin/login body.
    if (req.url === "/admin" || req.url?.startsWith("/admin/") || req.url?.startsWith("/admin?")) {
      const htmlHead = {
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
      } as const;
      const path = req.url.split("?")[0];

      // the admin stylesheet — public (not secret), served before the auth gate.
      // URL is content-versioned (?v=hash), so it's safe to cache immutably.
      if (path === "/admin/app.css") {
        res.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        });
        res.end(ADMIN_CSS);
        return;
      }

      // login: username + password (a LOCAL ACCOUNT, never the MCP token) →
      // session cookie. The agent has the token but not the password (I9).
      if (path === "/admin/login" && req.method === "POST") {
        const form = new URLSearchParams(await readRawBody(req));
        const username = (form.get("username") ?? "").trim();
        const auth = await authenticate(store, username, form.get("password") ?? "");
        if (!auth.ok) {
          store.audit(username || "anonymous", "admin_login_rejected", {});
          res.writeHead(401, htmlHead);
          res.end(renderLoginPage("Invalid username or password."));
          return;
        }
        const { sid } = sessions.create(username, auth.role);
        store.audit(username, "admin_login", { role: auth.role });
        res.writeHead(303, { location: "/admin", "set-cookie": sessionSetCookie(sid) });
        res.end();
        return;
      }

      const sid = sessionIdFromCookie(req.headers.cookie);
      const session = sessions.get(sid);

      // logout
      if (path === "/admin/logout" && req.method === "POST") {
        sessions.destroy(sid);
        res.writeHead(303, { location: "/admin", "set-cookie": sessionClearCookie() });
        res.end();
        return;
      }

      // everything else requires a session
      if (!session) {
        res.writeHead(path === "/admin" ? 200 : 401, htmlHead);
        res.end(renderLoginPage());
        return;
      }

      // approve/reject — CSRF-checked (belt-and-suspenders with SameSite=Strict)
      // and ROLE-gated: only admins may accept (I9 — the membrane's human side).
      if (path === "/admin/resolve" && req.method === "POST") {
        const form = new URLSearchParams(await readRawBody(req));
        if (form.get("csrf") !== session.csrf) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("bad csrf token\n");
          return;
        }
        if (!canApprove(session.role)) {
          store.audit(session.identity, "admin_resolve_denied", { role: session.role });
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("not authorized to approve\n");
          return;
        }
        const id = Number(form.get("id"));
        const action = form.get("action");
        let flash = "Invalid action.";
        if (Number.isInteger(id) && (action === "accepted" || action === "rejected")) {
          flash = applyApprovalAction(store, session.identity, {
            id,
            action,
            reason: form.get("reason") ?? undefined,
          });
        }
        res.writeHead(303, { location: `/admin?flash=${encodeURIComponent(flash)}` });
        res.end();
        return;
      }

      // audit log (Phase 5.6)
      if (path === "/admin/audit") {
        res.writeHead(200, htmlHead);
        res.end(renderAuditPage(store, session));
        return;
      }

      // knowledge browser — read the curated memories
      if (path === "/admin/knowledge") {
        res.writeHead(200, htmlHead);
        res.end(renderKnowledgePage(store, session));
        return;
      }

      // connected sources — what's wired up + live freshness from the lake
      if (path === "/admin/sources") {
        res.writeHead(200, htmlHead);
        res.end(renderSourcesPage(session, await gatherSources()));
        return;
      }

      // invite a teammate — mint a read-only analyst connector. CSRF + admin-gated
      // (members can't invite, mirroring approve). Mints analyst only; web never
      // grants curate/write (that stays an operator action — admin-cli).
      if (path === "/admin/invite" && req.method === "POST") {
        const form = new URLSearchParams(await readRawBody(req));
        if (form.get("csrf") !== session.csrf) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("bad csrf token\n");
          return;
        }
        if (!canApprove(session.role)) {
          store.audit(session.identity, "teammate_invite_denied", { role: session.role });
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("not authorized to invite\n");
          return;
        }
        const identity = (form.get("identity") ?? "").trim();
        const rotate = form.get("rotate") === "1"; // revoke any existing token first
        if (!identity) {
          teamFlash.set(sid ?? "", { flash: "Enter a teammate email to invite." });
        } else if (!rotate && analystIdentities().includes(identity)) {
          teamFlash.set(sid ?? "", { flash: `${identity} already has an agent connector — use Rotate to replace it.` });
        } else {
          // Rotate = kill the old token (lost/leaked) before issuing a new one.
          let revokedEnv = false;
          if (rotate) {
            const r = removeAnalystTokens(identity);
            revokedEnv = r.envBacked;
            store.audit(session.identity, "connector_rotated", { identity, removed: r.removed });
          }
          // mint the connector AND ensure a web account exists — an agent always
          // implies an account (member by default; promote later if they curate).
          const token = mintToken();
          const { persisted } = addAnalystToken(token, identity);
          const baseUrl = process.env.SETOKU_PUBLIC_URL ?? `https://${req.headers.host}`;
          const slot: TeamFlash = {
            invite: { identity, token, installerUrl: `${baseUrl}/i/${token}`, mcpUrl: `${baseUrl}/mcp`, persisted },
          };
          if (rotate)
            slot.flash = `Rotated ${identity}'s connector — the old token no longer works.${revokedEnv ? " (One old token is in SETOKU_TOKENS env, not the file — it returns on restart; remove it from .env to fully revoke.)" : ""}`;
          if (!rotate) store.audit(session.identity, "teammate_invited", { identity, persisted });
          if (!store.getAccount(identity)) {
            const pw = Array.from(crypto.getRandomValues(new Uint8Array(9)))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
            store.createAccount({ username: identity, pwhash: await hashPassword(pw), role: "member", createdBy: session.identity });
            store.audit(session.identity, "account_created", { username: identity, role: "member" });
            slot.newLogin = { username: identity, role: "member", tempPassword: pw };
          }
          teamFlash.set(sid ?? "", slot);
        }
        // Post/Redirect/Get: never re-mint on refresh
        res.writeHead(303, { location: "/admin/team" });
        res.end();
        return;
      }

      // manage web logins (admin access): create / promote-demote / reset / remove.
      // CSRF + admin-gated. Mints NO agent-side write capability (curator stays an
      // operator action); this only manages who can sign in here and at what role.
      if (path === "/admin/users" && req.method === "POST") {
        const form = new URLSearchParams(await readRawBody(req));
        if (form.get("csrf") !== session.csrf) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("bad csrf token\n");
          return;
        }
        if (!canApprove(session.role)) {
          store.audit(session.identity, "admin_users_denied", { role: session.role });
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("not authorized to manage accounts\n");
          return;
        }
        const op = form.get("op");
        const uname = (form.get("username") ?? "").trim();
        let flash = "Invalid request.";
        let newLogin: { username: string; role: string; tempPassword: string } | undefined;
        let invite: Awaited<ReturnType<typeof buildInvite>> | undefined;
        const tempPw = (): string =>
          Array.from(crypto.getRandomValues(new Uint8Array(9)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        const baseUrl = process.env.SETOKU_PUBLIC_URL ?? `https://${req.headers.host}`;
        const actor = session.identity;
        function buildInvite(identity: string) {
          const token = mintToken();
          const { persisted } = addAnalystToken(token, identity);
          store.audit(actor, "teammate_invited", { identity, persisted });
          return { identity, token, installerUrl: `${baseUrl}/i/${token}`, mcpUrl: `${baseUrl}/mcp`, persisted };
        }
        const acct = uname ? store.getAccount(uname) : null;
        const isLastAdmin = (a: { role: string } | null): boolean =>
          !!a && a.role === "admin" && store.countRole("admin") <= 1;

        if (op === "create") {
          const role = form.get("role") ?? "member";
          if (!uname) flash = "Username required.";
          else if (!isRole(role)) flash = `Invalid role "${role}".`;
          else if (store.getAccount(uname)) flash = `"${uname}" already has a login.`;
          else {
            const pw = tempPw();
            store.createAccount({ username: uname, pwhash: await hashPassword(pw), role, createdBy: session.identity });
            store.audit(session.identity, "account_created", { username: uname, role });
            newLogin = { username: uname, role, tempPassword: pw };
            // no login without an agent: mint a connector too if they lack one
            if (!analystIdentities().includes(uname)) invite = buildInvite(uname);
            flash = `Created ${role} login for ${uname}${invite ? " + agent connector" : ""}.`;
          }
        } else if (op === "role") {
          const role = form.get("role") ?? "";
          if (!acct) flash = `No login "${uname}".`;
          else if (!isRole(role)) flash = `Invalid role "${role}".`;
          else if (role === "member" && isLastAdmin(acct)) flash = "Can't demote the last admin.";
          else {
            store.setRole(uname, role);
            store.audit(session.identity, "account_role_changed", { username: uname, role });
            flash = `${uname} is now ${role}.`;
          }
        } else if (op === "reset") {
          if (!acct) flash = `No login "${uname}".`;
          else {
            const pw = tempPw();
            store.setPassword(uname, await hashPassword(pw));
            store.audit(session.identity, "account_password_reset", { username: uname });
            newLogin = { username: uname, role: acct.role, tempPassword: pw };
            flash = `Reset password for ${uname}.`;
          }
        } else if (op === "delete") {
          if (!acct) flash = `No login "${uname}".`;
          else if (isLastAdmin(acct)) flash = "Can't remove the last admin.";
          else {
            // full offboard: remove the account AND revoke their agent connector
            store.deleteAccount(uname);
            const { removed, envBacked } = removeAnalystTokens(uname);
            store.audit(session.identity, "account_deleted", { username: uname, tokensRevoked: removed });
            flash = `Removed ${uname} (account + ${removed} connector${removed === 1 ? "" : "s"} revoked).${envBacked ? " One token is in SETOKU_TOKENS env — remove it from .env to fully revoke." : ""}`;
          }
        }
        teamFlash.set(sid ?? "", { newLogin, invite, flash });
        res.writeHead(303, { location: "/admin/team" }); // PRG: refresh won't re-run the op
        res.end();
        return;
      }

      // team — one row per person: agent status + web login/role, plus management.
      // Consume any one-time result from a preceding POST (shown exactly once).
      if (path === "/admin/team") {
        const once = teamFlash.get(sid ?? "");
        teamFlash.delete(sid ?? "");
        res.writeHead(200, htmlHead);
        res.end(renderTeamPage(session, { people: teamPeople(), ...once }));
        return;
      }

      // the page
      const flash = new URL(req.url, "http://x").searchParams.get("flash") ?? undefined;
      res.writeHead(200, htmlHead);
      res.end(renderApprovalPage(store, session, flash));
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
