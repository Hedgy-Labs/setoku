#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Setoku MCP gateway — stdio entry (local profile).
 *
 * Spawned by the Claude Code/Cowork plugin per project. Identity = local user
 * (SETOKU_USER env → git email). Knowledge store = service-owned SQLite
 * (~/.setoku/projects/<slug>/knowledge.db unless overridden); `.setoku/context/`
 * markdown is imported once as a seed. This process never calls an LLM and
 * never reveals database credentials.
 */
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer } from "./app";
import { loadConfig, resolveProjectDir, resolveUser } from "./lib/config";
import { closePools } from "./lib/db";
import { KnowledgeStore, defaultDbPath, seedFromFiles } from "./lib/store";

const projectDir = resolveProjectDir();
const user = resolveUser(projectDir);

function storePath(): string {
  const res = loadConfig(projectDir);
  if (res.ok && typeof res.config.knowledgeDb === "string") {
    const p = res.config.knowledgeDb;
    return path.isAbsolute(p) ? p : path.join(projectDir, p);
  }
  return defaultDbPath(projectDir);
}

const store = new KnowledgeStore(storePath());
if (store.empty) {
  const imported = seedFromFiles(store, projectDir);
  if (imported > 0) store.audit(user, "seed_from_files", { imported });
}

async function main() {
  const server = buildServer({ projectDir, store, user });
  await server.connect(new StdioServerTransport());
  process.on("SIGTERM", async () => {
    await closePools();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("setoku gateway failed to start:", e);
  process.exit(1);
});
