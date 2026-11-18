// SPDX-License-Identifier: Apache-2.0
/**
 * preview_app is offered only while a renderer answers, and never to a curator
 * session (a screenshot carries lake data; curators are walled off from lake
 * reads, I2). The renderer here is a stub CDP endpoint — rendering itself is
 * covered by e2e/preview.test.ts against real Chrome.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnGateway, waitHealthy, connect, ROOT } from "./lib/gateway";
import { startFakeLake } from "./lib/fakelake";

const PORT = 38763;
const BASE = `http://127.0.0.1:${PORT}`;
const lake = startFakeLake(() => ({ rows: [] }));
const cdp = Bun.serve({ port: 0, fetch: (r) => (new URL(r.url).pathname === "/json/version" ? Response.json({ Browser: "stub" }) : new Response("no", { status: 404 })) });

let up: Subprocess;
let off: Subprocess;
let tmp = "";

async function toolNames(base: string, token: string): Promise<string[]> {
  const c = await connect(base, token);
  try {
    return (await c.listTools()).tools.map((t) => t.name);
  } finally {
    await c.close();
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-preview-gate-"));
  fs.cpSync(path.join(ROOT, "deploy", "project-template", ".setoku"), path.join(tmp, ".setoku"), { recursive: true });
  const env = (port: number, db: string, extra: Record<string, string>) => ({
    SETOKU_PROJECT_DIR: tmp,
    SETOKU_DB_PATH: path.join(tmp, db, "knowledge.db"), // own dir: app/file stores sit beside it
    SETOKU_LAKE_URL: lake.url,
    SETOKU_TOKENS: "tok-ana=ana",
    SETOKU_CURATOR_TOKENS: "tok-cur=cur",
    SETOKU_HTTP_PORT: String(port),
    ...extra,
  });
  up = spawnGateway(env(PORT, "a", { SETOKU_PREVIEW_URL: `http://127.0.0.1:${cdp.port}` }));
  off = spawnGateway(env(PORT + 1, "b", {}));
  await waitHealthy(BASE);
  await waitHealthy(`http://127.0.0.1:${PORT + 1}`);
}, 30_000);
afterAll(() => {
  up?.kill();
  off?.kill();
  cdp.stop(true);
  lake.stop?.();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("preview_app gating", () => {
  it("is offered to an analyst while the renderer answers — never to a curator", async () => {
    let names: string[] = [];
    for (let i = 0; i < 30 && !names.includes("preview_app"); i++) {
      names = await toolNames(BASE, "tok-ana"); // the boot probe is async
      if (!names.includes("preview_app")) await new Promise((r) => setTimeout(r, 100));
    }
    expect(names).toContain("preview_app");
    expect(await toolNames(BASE, "tok-cur")).not.toContain("preview_app");
  });

  it("isn't offered on a box with no renderer configured", async () => {
    expect(await toolNames(`http://127.0.0.1:${PORT + 1}`, "tok-ana")).not.toContain("preview_app");
  });
});
