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

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, docs: store.listDocs().length }));
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
