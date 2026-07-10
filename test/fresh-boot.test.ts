// SPDX-License-Identifier: Apache-2.0
/**
 * A FRESH box boots with ZERO env tokens — bootstrap creates the operator's
 * DB-backed connector only after `up --wait` — so the gateway must start
 * fail-closed (every /mcp 401s) rather than exit. Then provisioning a token
 * straight into the store (the add-person path) authenticates with no restart.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnGateway, waitHealthy, connect, ROOT } from "./lib/gateway";

const PORT = 38731;
const BASE = `http://127.0.0.1:${PORT}`;

let tmpDir: string;
let proc: Subprocess;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-fresh-"));
  // spawnGateway merges process.env, so the token vars must be explicitly
  // EMPTIED to simulate the fresh box (a dev shell may carry real ones).
  proc = spawnGateway({
    SETOKU_PROJECT_DIR: tmpDir,
    SETOKU_DB_PATH: path.join(tmpDir, "knowledge.db"),
    SETOKU_HTTP_PORT: String(PORT),
    SETOKU_TOKENS: "",
    SETOKU_CURATOR_TOKENS: "",
    SETOKU_JANITOR_TOKENS: "",
    SETOKU_TOKENS_FILE: path.join(tmpDir, "no-such-tokens.json"),
  });
  await waitHealthy(BASE);
});

afterAll(() => {
  proc?.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("fresh boot with zero tokens", () => {
  it("starts and serves /health — no exit on an empty token set", async () => {
    expect((await fetch(`${BASE}/health`)).ok).toBe(true);
  });

  it("is fail-closed: /mcp rejects any token", async () => {
    expect(connect(BASE, "not-a-real-token")).rejects.toThrow();
    expect(connect(BASE, null)).rejects.toThrow();
  });

  it("a token provisioned into the store (add-person path) authenticates with NO restart", async () => {
    const { KnowledgeStore } = await import(path.join(ROOT, "plugin", "gateway", "lib", "store.ts"));
    const s = new KnowledgeStore(path.join(tmpDir, "knowledge.db"));
    s.addAnalystToken("tok-fresh-operator", "op@co.test", "test");
    s.db.close();
    const client = await connect(BASE, "tok-fresh-operator");
    const names = (await client.listTools()).tools.map((t: { name: string }) => t.name);
    expect(names).toContain("find_context");
    expect(names).not.toContain("upsert_context"); // analyst only — the membrane holds
    await client.close();
  });
});
