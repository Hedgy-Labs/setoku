// SPDX-License-Identifier: Apache-2.0
/**
 * SETOKU_DEMO=1 (a public demo box): the web console is viewable READ-ONLY
 * without login, and mutations still require a real session (the membrane,
 * I2/I9). Spawns the actual http.ts entry with the flag on and drives it
 * anonymously (no session cookie).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pgPkg from "pg";
import { spawnGateway, waitHealthy, FIXTURES, ROOT } from "./lib/gateway";

const { Client: PgClient } = pgPkg;

const PG_HOST = process.env.SETOKU_E2E_PG_HOST ?? "/tmp";
const DB_NAME = "setoku_e2e_demo";
const DB_URL =
  process.env.SETOKU_E2E_DEMO_DB_URL ??
  `postgresql:///${DB_NAME}?host=${encodeURIComponent(PG_HOST)}`;
const PORT = 38731;
const BASE = `http://127.0.0.1:${PORT}`;

let tmpRepo: string;
let proc: Subprocess;

beforeAll(async () => {
  const admin = new PgClient({
    host: PG_HOST,
    database: process.env.SETOKU_E2E_PG_MAINTENANCE_DB ?? "template1",
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const db = new PgClient({ host: PG_HOST, database: DB_NAME });
  await db.connect();
  await db.query(fs.readFileSync(path.join(FIXTURES, "schema.sql"), "utf8"));
  await db.end();

  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-demo-"));
  fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), { recursive: true });

  proc = spawnGateway({
    SETOKU_PROJECT_DIR: tmpRepo,
    SETOKU_DB_PATH: path.join(tmpRepo, "knowledge.db"),
    SETOKU_E2E_DB_URL: DB_URL,
    SETOKU_HTTP_PORT: String(PORT),
    SETOKU_TOKENS: "tok-alice=alice@co.test",
    SETOKU_DEMO: "1",
  });
  await waitHealthy(BASE);
}, 30_000);

afterAll(async () => {
  proc?.kill();
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe("SETOKU_DEMO — anonymous read-only console", () => {
  it("serves a viewer identity to an anonymous /admin/api/session", async () => {
    const r = await fetch(`${BASE}/admin/api/session`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { identity: string; role: string; csrf: string };
    expect(body.role).toBe("viewer");
    expect(body.identity).toBe("public");
    expect(body.csrf).toBe(""); // no CSRF token → the SPA can't mutate
  });

  it("allows anonymous GETs on the allowlisted read endpoints", async () => {
    for (const api of ["knowledge", "published", "sources", "team", "pending"]) {
      const r = await fetch(`${BASE}/admin/api/${api}`);
      expect(r.status).toBe(200);
    }
  });

  it("keeps the audit trail off-limits to the anonymous viewer (admin-only)", async () => {
    // Its payloads carry doc names, SQL, and identities — not for a public viewer.
    const r = await fetch(`${BASE}/admin/api/audit`);
    expect(r.status).toBe(401);
  });

  it("still 401s an anonymous GET on a non-allowlisted endpoint", async () => {
    // 'app_history' with no id would 404 for a viewer, so probe a truly unlisted
    // read: there is none the SPA calls, so use an unknown api name → viewer null.
    const r = await fetch(`${BASE}/admin/api/definitely_not_an_api`);
    expect(r.status).toBe(401);
  });

  it("BLOCKS anonymous mutations — a POST has no session (the membrane, I2/I9)", async () => {
    const r = await fetch(`${BASE}/admin/api/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "" },
      body: JSON.stringify({ identity: "evil@attacker.test" }),
    });
    expect(r.status).toBe(401);
  });

  it("lets an anonymous viewer past the /admin/frame auth gate (404, not 401)", async () => {
    // Without the demo flag this 401s ('not signed in'); with it, the viewer
    // reaches the app lookup and gets 404 for a missing app.
    const r = await fetch(`${BASE}/admin/frame/no-such-app`);
    expect(r.status).toBe(404);
  });

  it("injects the demo flag into the SPA shell", async () => {
    const shell = await (await fetch(`${BASE}/`)).text();
    expect(shell).toContain("window.__SETOKU_DEMO__=true");
  });
});
