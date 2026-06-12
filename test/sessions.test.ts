// SPDX-License-Identifier: Apache-2.0
// Web-admin sessions are persisted in the store (SQLite on the durable volume),
// NOT process memory — so a server restart/redeploy does not sign everyone out.
import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../plugin/gateway/lib/store";

const dbPath = path.join(os.tmpdir(), `setoku-sessions-${process.pid}.db`);
afterAll(() => {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
});

describe("session persistence (survives a restart)", () => {
  it("a session written by one store instance is readable by a fresh instance on the same file", () => {
    const s1 = new KnowledgeStore(dbPath);
    s1.createSession({
      sid: "sid-abc",
      identity: "peter",
      role: "admin",
      csrf: "csrf-xyz",
      expires: Date.now() + 60_000,
    });

    // a brand-new instance == the process after a redeploy
    const s2 = new KnowledgeStore(dbPath);
    const got = s2.getSession("sid-abc");
    expect(got).not.toBeNull();
    expect(got!.identity).toBe("peter");
    expect(got!.role).toBe("admin");
    expect(got!.csrf).toBe("csrf-xyz");
  });

  it("an expired session returns null and is pruned", () => {
    const s = new KnowledgeStore(dbPath);
    s.createSession({
      sid: "sid-old",
      identity: "peter",
      role: "admin",
      csrf: "c",
      expires: Date.now() - 1,
    });
    expect(s.getSession("sid-old")).toBeNull();
    // and it's gone, not just hidden
    const raw = (s as unknown as { db: { query: (q: string) => { get: (a: string) => unknown } } }).db
      .query("SELECT sid FROM sessions WHERE sid = ?")
      .get("sid-old");
    expect(raw).toBeNull();
  });

  it("destroy removes a session (sign-out)", () => {
    const s = new KnowledgeStore(dbPath);
    s.createSession({ sid: "sid-bye", identity: "p", role: "admin", csrf: "c", expires: Date.now() + 60_000 });
    expect(s.getSession("sid-bye")).not.toBeNull();
    s.destroySession("sid-bye");
    expect(s.getSession("sid-bye")).toBeNull();
  });
});
