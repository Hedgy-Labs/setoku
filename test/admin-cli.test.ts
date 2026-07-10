// SPDX-License-Identifier: Apache-2.0
/**
 * admin-cli add-person: the one-command person bootstrap (login + analyst
 * connector, same identity). Its `token=<hex>` stdout line is a CONTRACT with
 * deploy/bootstrap.sh (parsed via `sed -n 's/^token=//p'`) — pin it here.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./lib/gateway";

const CLI = path.join(ROOT, "plugin", "gateway", "admin-cli.ts");

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-cli-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", CLI, ...args],
    env: {
      ...(process.env as Record<string, string>),
      SETOKU_DB_PATH: path.join(tmpDir, "knowledge.db"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout, code };
}

async function openStore() {
  const { KnowledgeStore } = await import(path.join(ROOT, "plugin", "gateway", "lib", "store.ts"));
  return new KnowledgeStore(path.join(tmpDir, "knowledge.db"));
}

describe("admin-cli add-person", () => {
  it("creates the pair (admin login + analyst connector) and prints the token= contract line", async () => {
    const { stdout, code } = await runCli(["add-person", "op@co.test", "--role", "admin"], {
      SETOKU_NEW_PASSWORD: "op-secret-pw",
    });
    expect(code).toBe(0);
    // exactly ONE machine-parseable token line (the bootstrap.sh contract)
    const tokenLines = stdout.match(/^token=[0-9a-f]{48}$/gm) ?? [];
    expect(tokenLines.length).toBe(1);
    const token = tokenLines[0]!.slice("token=".length);

    const s = await openStore();
    expect(s.getAccount("op@co.test")?.role).toBe("admin");
    expect(s.analystTokenIdentity(token)).toBe("op@co.test");
    // membrane: nothing but an ANALYST token was minted (curator/janitor are env-pinned)
    expect(s.analystIdentities()).toEqual(["op@co.test"]);
    s.db.close();
  });

  it("is idempotent on the account — a re-run keeps the login and mints a fresh connector", async () => {
    const { stdout, code } = await runCli(["add-person", "op@co.test", "--role", "admin"], {
      SETOKU_NEW_PASSWORD: "ignored-account-exists",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("already exists");
    expect((stdout.match(/^token=[0-9a-f]{48}$/gm) ?? []).length).toBe(1);
  });

  it("add-teammate now creates the full person: member login (generated password) + connector", async () => {
    const { stdout, code } = await runCli(["add-teammate", "mate@co.test"]);
    expect(code).toBe(0);
    expect(stdout).toContain("password (share once)");
    expect((stdout.match(/^token=[0-9a-f]{48}$/gm) ?? []).length).toBe(1);
    const s = await openStore();
    expect(s.getAccount("mate@co.test")?.role).toBe("member");
    s.db.close();
  });
});
