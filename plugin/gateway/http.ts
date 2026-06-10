#!/usr/bin/env bun
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
 *   SETOKU_TOKENS       — "token1=alice@co.com,token2=bob@co.com"
 *   SETOKU_TOKENS_FILE  — optional JSON file { "token": "identity", ... } (merged)
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

const projectDir = resolveProjectDir();

function storePath(): string {
  const res = loadConfig(projectDir);
  if (res.ok && typeof res.config.knowledgeDb === "string") {
    const p = res.config.knowledgeDb;
    return path.isAbsolute(p) ? p : path.join(projectDir, p);
  }
  return defaultDbPath(projectDir);
}

function loadTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of (process.env.SETOKU_TOKENS ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) tokens.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const file = process.env.SETOKU_TOKENS_FILE;
  if (file && fs.existsSync(file)) {
    for (const [token, identity] of Object.entries(
      JSON.parse(fs.readFileSync(file, "utf8")),
    )) {
      tokens.set(token, String(identity));
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

const store = new KnowledgeStore(process.env.SETOKU_DB_PATH ?? storePath());
if (store.empty) {
  const imported = seedFromFiles(store, projectDir);
  if (imported > 0) store.audit("system", "seed_from_files", { imported });
}

function identityFor(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return tokens.get(m[1].trim()) ?? null;
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

const PORT = Number(process.env.SETOKU_HTTP_PORT ?? 8787);

/**
 * Cowork self-setup: the "installer" is a prompt. The user pastes one sentence
 * into Cowork; its Claude fetches this page and follows the instructions —
 * writing the org-plugin config itself (with a native admin-password dialog
 * via osascript, since Cowork's shell has no TTY for sudo).
 */
function coworkSetupInstructions(
  token: string,
  identity: string,
  baseUrl: string,
): string {
  const mcpJson = JSON.stringify({
    mcpServers: {
      setoku: {
        type: "http",
        url: `${baseUrl}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  });
  const pluginJson = JSON.stringify({
    name: "setoku",
    version: "0.4.0",
    description: "Setoku — governed business answers over live company data",
    mcpServers: "./.mcp.json",
  });
  return `# Setoku setup instructions (for the Claude agent reading this)

You are setting up **Setoku** for ${identity}. Setoku is an MCP gateway giving this
user governed, read-only access to their company's data and business knowledge.
Follow these steps; explain to the user what you're doing as you go.

## Step 1 — try the simple path first (no admin rights)

If this Claude surface lets you add MCP servers via a user-level config or settings
file, add an HTTP server named \`setoku\` with url \`${baseUrl}/mcp\` and header
\`Authorization: Bearer ${token}\`. If you have the \`claude\` CLI available, this is:

    claude mcp add --scope user --transport http setoku ${baseUrl}/mcp --header "Authorization: Bearer ${token}"

If that worked, skip to Step 3.

## Step 2 — org-plugin install (needs one admin-password prompt)

Write these three files into \`/Library/Application Support/Claude/org-plugins/setoku/\`.
That directory needs admin rights; from a GUI shell use osascript so the user gets the
native macOS password dialog (tell them to expect it and why):

    osascript -e 'do shell script "mkdir -p \\"/Library/Application Support/Claude/org-plugins/setoku/.claude-plugin\\"" with administrator privileges'

Then write (same osascript pattern, or sudo tee if you have a TTY):

1. \`.claude-plugin/plugin.json\`:

\`\`\`json
${pluginJson}
\`\`\`

2. \`.mcp.json\` (at the plugin root, next to .claude-plugin/):

\`\`\`json
${mcpJson}
\`\`\`

3. \`version.json\`: \`{"version":"1"}\`

Verify all three files exist and are valid JSON, then ask the user to **restart Cowork**.

## Step 3 — prove it works

After setup (and restart if Step 2 was used), call the \`find_context\` tool with the
question "how many companies are paying us right now?", follow what it returns, answer
via \`run_query\`, and show the user the result. Tell them: it's read-only, every query
is logged under their name (${identity}), and if they ever correct a business term,
you'll record it so the whole team's answers improve.

If nothing here works, tell the user to send Peter the exact error.
`;
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

if [ -d "/Applications/Claude.app" ] || [ -d "/Applications/Cowork.app" ]; then
  printf "→ Cowork/Claude desktop detected. Configure it too (needs sudo)? [y/N] "
  if [ -n "$SETOKU_DRY_RUN" ]; then ANSWER=n; echo "n (dry run)"; else read -r ANSWER < /dev/tty || ANSWER=n; fi
  case "$ANSWER" in y|Y)
    PLUG="/Library/Application Support/Claude/org-plugins/setoku"
    run sudo mkdir -p "$PLUG/.claude-plugin"
    if [ -z "$SETOKU_DRY_RUN" ]; then
      printf '%s' '{"name":"setoku","version":"0.4.0","description":"Setoku — governed business answers","mcpServers":"./.mcp.json"}' | run sudo tee "$PLUG/.claude-plugin/plugin.json" >/dev/null
      printf '%s' "{\\"mcpServers\\":{\\"setoku\\":{\\"type\\":\\"http\\",\\"url\\":\\"$URL\\",\\"headers\\":{\\"Authorization\\":\\"Bearer $TOKEN\\"}}}}" | run sudo tee "$PLUG/.mcp.json" >/dev/null
      printf '%s' "{\\"version\\":\\"$(date +%s)\\"}" | run sudo tee "$PLUG/version.json" >/dev/null
    fi
    echo "  Cowork org plugin written (restart Cowork to pick it up)."
    DONE="yes"
  ;; esac
fi

if [ -z "$DONE" ]; then
  echo "No Claude surface found. Install Claude Code (https://claude.com/code) and re-run this command."
  exit 1
fi

echo ""
echo "✓ Setoku is connected. Open Claude and ask:"
echo "    how many companies are paying us right now?"
`;
}

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, docs: store.listDocs().length }));
      return;
    }
    if (req.url?.startsWith("/i/")) {
      const token = decodeURIComponent(req.url.slice(3).split("?")[0]);
      const identity = tokens.get(token);
      if (!identity) {
        store.audit("anonymous", "installer_rejected", {});
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("unknown installer link\n");
        return;
      }
      const baseUrl =
        process.env.SETOKU_PUBLIC_URL ?? `https://${req.headers.host}`;
      store.audit(identity, "installer_served", {});
      res.writeHead(200, { "content-type": "text/x-shellscript" });
      res.end(installerScript(token, identity, baseUrl));
      return;
    }
    if (req.url?.startsWith("/cowork/")) {
      const token = decodeURIComponent(req.url.slice(8).split("?")[0]);
      const identity = tokens.get(token);
      if (!identity) {
        store.audit("anonymous", "installer_rejected", { kind: "cowork" });
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("unknown setup link\n");
        return;
      }
      const baseUrl =
        process.env.SETOKU_PUBLIC_URL ?? `https://${req.headers.host}`;
      store.audit(identity, "cowork_setup_served", {});
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(coworkSetupInstructions(token, identity, baseUrl));
      return;
    }
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    const user = identityFor(req);
    if (!user) {
      store.audit("anonymous", "auth_rejected", { path: req.url });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid or missing bearer token" }));
      return;
    }
    // Stateless: a fresh McpServer per request, identity bound from the token.
    // Shared state lives in the SQLite store (WAL), not the server instance.
    const server = buildServer({ projectDir, store, user });
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
