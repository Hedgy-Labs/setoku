// SPDX-License-Identifier: Apache-2.0
/**
 * e2e for the RETIRED direct business-Postgres path (supersedes the old
 * mirror-required gate of issue #47): the gateway holds no pg client at all,
 * so `dialect:"postgres"` is rejected everywhere — run_query, publish_app, and
 * the render of a legacy stored panel — with the biz.* rewrite pointer.
 *
 * The load-bearing trick: we spawn the gateway WITH SETOKU_DATABASE_URL set to
 * an unroutable address (127.0.0.1:1). If any code path still held a pg client
 * and tried to use the credential, the tests would see a connection error (or
 * hang) instead of the clean retirement message — so a green run proves the
 * rejection is enforced by CODE, not by the env var merely being absent.
 *
 * No real database anywhere: ClickHouse is a fake lake (test/lib/fakelake),
 * which doubles as a witness that retired queries never reach an engine.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnGateway, waitHealthy, connect, call as gwCall, FIXTURES, ROOT } from "./lib/gateway";
import { startFakeLake, innerSql, type FakeLake } from "./lib/fakelake";

const PORT = 38747;
const BASE = `http://127.0.0.1:${PORT}`;

let repo: string;
let proc: Subprocess;
let lake: FakeLake;
let legacyAppId = "";

const mcp = async (token = "tok-analyst") => connect(BASE, token, "pg-retired");

beforeAll(async () => {
  // The fake lake: the mirror registry says public.deals is mirrored as
  // biz.deals, and biz.deals answers the one aggregate the tests ask.
  // Everything else returns zero rows.
  lake = startFakeLake((sql) => {
    const q = innerSql(sql);
    if (q.includes("pg_mirror_runs") && q.includes("target_table AS target"))
      return { rows: [{ target: "deals", source: "public.deals", as_of: "2026-07-14 00:00:00.000" }] };
    if (q.includes("sum(amount)")) return { rows: [{ total: 350 }] };
    return { rows: [] };
  });

  repo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-pg-retired-"));
  fs.cpSync(path.join(FIXTURES, "setoku"), path.join(repo, ".setoku"), { recursive: true });

  // An admin login (for the team frame render) + a LEGACY stored app whose
  // panel still declares dialect:"postgres" — the pre-retirement shape, written
  // straight into the store the way an old box would carry it forward.
  {
    const { KnowledgeStore, mintShareId } = await import(
      path.join(ROOT, "plugin", "gateway", "lib", "store.ts")
    );
    const { hashPassword } = await import(
      path.join(ROOT, "plugin", "gateway", "lib", "accounts.ts")
    );
    const s = new KnowledgeStore(path.join(repo, "knowledge.db"));
    s.createAccount({ username: "boss", pwhash: await hashPassword("s3cret-pass"), role: "admin" });
    legacyAppId = mintShareId();
    s.createPublished({
      id: legacyAppId,
      title: "Legacy pg app",
      body: "<div id=x></div>",
      panels: [{ key: "legacy", sql: "SELECT count(*) AS n FROM deals /*legacy-probe*/", dialect: "postgres" }],
      refreshSeconds: 60,
      createdBy: "someone@co.test",
    });
    s.db.close();
  }

  proc = spawnGateway({
    SETOKU_PROJECT_DIR: repo,
    SETOKU_DB_PATH: path.join(repo, "knowledge.db"),
    SETOKU_HTTP_PORT: String(PORT),
    SETOKU_LAKE_URL: lake.url,
    // The trick (see the header): a credential IS present but unroutable —
    // retired code paths must never even attempt a connection with it.
    SETOKU_DATABASE_URL: "postgresql://x:y@127.0.0.1:1/nope",
    SETOKU_TOKENS: "tok-analyst=analyst@co.test",
  });
  await waitHealthy(BASE);
}, 30_000);

afterAll(async () => {
  proc?.kill();
  lake?.stop();
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe("the business-Postgres path is retired", () => {
  it('run_query dialect:"postgres" is rejected by code — no connection attempted, no engine touched', async () => {
    const c = await mcp();
    const r = await gwCall(c, "run_query", {
      sql: "SELECT 42 AS pg_probe_marker",
      dialect: "postgres",
    });
    await c.close();
    expect(r.isError).toBe(true);
    // the clean retirement message with the biz.* rewrite pointer ...
    expect(r.text).toContain("retired");
    expect(r.text).toContain("biz.");
    // ... and NOT a connection error from the planted unroutable credential
    expect(r.text).not.toMatch(/ECONNREFUSED|Connection|getaddrinfo|timeout/i);
    // the fake lake never saw the query either — nothing executed anywhere
    expect(lake.calls.some((c2) => c2.sql.includes("pg_probe_marker"))).toBe(false);
  });

  it("the default dialect is clickhouse: a bare run_query reaches the lake and returns its rows", async () => {
    const c = await mcp();
    const r = await gwCall(c, "run_query", { sql: "SELECT sum(amount) AS total FROM biz.deals" });
    await c.close();
    expect(r.isError).toBe(false);
    expect(r.text).toContain("350"); // the canned biz.deals aggregate
    expect(lake.calls.some((c2) => c2.sql.includes("sum(amount)"))).toBe(true);
  });

  it("publish_app rejects a postgres-dialect panel outright (no dry-run, no store row)", async () => {
    const c = await mcp();
    const r = await gwCall(c, "publish_app", {
      title: "should not publish",
      html: "<div id='a'></div>",
      panels: [{ key: "a", sql: "SELECT sum(amount) AS total FROM deals", dialect: "postgres" }],
    });
    await c.close();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Panel "a"');
    expect(r.text).toContain("retired");
  });

  it("a legacy STORED postgres panel surfaces the retirement message as its panel error at render", async () => {
    // Sign in as the admin (the team frame carries raw error text; the public
    // frame scrubs it) and render the pre-retirement app injected in beforeAll.
    const login = await fetch(`${BASE}/admin/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "boss", password: "s3cret-pass" }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

    const res = await fetch(`${BASE}/admin/frame/${legacyAppId}`, { headers: { cookie } });
    expect(res.status).toBe(200); // the app still renders — the PANEL carries the error
    const frame = await res.text();
    expect(frame).toContain("window.__SETOKU__");
    expect(frame).toContain("retired"); // PG_RETIRED_ERROR as the panel's error
    expect(frame).not.toMatch(/ECONNREFUSED|getaddrinfo/i); // rejected, not attempted
    // the legacy SQL never reached any engine
    expect(lake.calls.some((c2) => c2.sql.includes("legacy-probe"))).toBe(false);
  });
});
