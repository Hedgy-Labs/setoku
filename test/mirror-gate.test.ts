// SPDX-License-Identifier: Apache-2.0
/**
 * e2e for the mirror-required policy (issue #47, hardened): with a biz.* mirror
 * present, mirrored tables are read via ClickHouse — postgres queries and
 * panels against them are REJECTED with the rewrite; force_postgres reads the
 * live source (verification); mirrorPolicy "prefer" softens to the nudge.
 *
 * Real Postgres (fast-suite requirement) + real ClickHouse, gated on
 * SETOKU_E2E_CH_URL exactly like test/lake.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pgPkg from "pg";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { spawnGateway, waitHealthy, connect, call as gwCall, FIXTURES } from "./lib/gateway";

const { Client: PgClient } = pgPkg;

const CH_URL = process.env.SETOKU_E2E_CH_URL;
const PG_HOST = process.env.SETOKU_E2E_PG_HOST ?? "/tmp";
const DB_NAME = "setoku_mirror_gate";
const DB_URL = `postgresql:///${DB_NAME}?host=${encodeURIComponent(PG_HOST)}`;
const PORT = 38747;
const PREFER_PORT = 38748;

async function chAdmin(query: string): Promise<void> {
  const u = new URL(CH_URL!);
  const res = await fetch(`${u.origin}/`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${decodeURIComponent(u.username) || "default"}:${decodeURIComponent(u.password)}`)}` },
    body: query,
  });
  if (!res.ok) throw new Error(`ch admin: ${await res.text()}`);
}

function makeRepo(extraConfig: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-mirror-gate-"));
  fs.cpSync(path.join(FIXTURES, "setoku"), path.join(dir, ".setoku"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".setoku", "config.json"),
    JSON.stringify({
      dataSource: { kind: "postgres", urlEnv: "SETOKU_E2E_DB_URL" },
      allowTables: ["public.*"],
      denyTables: [],
      rowCap: 50,
      statementTimeoutMs: 15000,
      ...extraConfig,
    }),
  );
  return dir;
}

const spawnOn = (port: number, repo: string): Subprocess =>
  spawnGateway({
    SETOKU_PROJECT_DIR: repo,
    SETOKU_DB_PATH: path.join(repo, "knowledge.db"),
    SETOKU_E2E_DB_URL: DB_URL,
    SETOKU_HTTP_PORT: String(port),
    SETOKU_TOKENS: "tok-analyst=mirror-gate@test",
    SETOKU_CURATOR_TOKENS: "tok-curator=mirror-gate@test",
    SETOKU_LAKE_URL: CH_URL!,
  });

describe.skipIf(!CH_URL)("mirror-required policy", () => {
  let repos: string[] = [];
  let procs: Subprocess[] = [];
  let mcp: McpClient;
  const call = (name: string, args: Record<string, unknown> = {}) => gwCall(mcp, name, args);

  beforeAll(async () => {
    // pg source table
    const admin = new PgClient({ host: PG_HOST, database: process.env.SETOKU_E2E_PG_MAINTENANCE_DB ?? "template1" });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
    const db = new PgClient({ host: PG_HOST, database: DB_NAME });
    await db.connect();
    await db.query("CREATE TABLE public.deals (id bigint PRIMARY KEY, amount bigint NOT NULL)");
    await db.query("INSERT INTO public.deals VALUES (1, 100), (2, 250)");
    await db.query("CREATE TABLE public.side_notes (id int PRIMARY KEY, note text)"); // NOT mirrored
    await db.end();

    // lake: the mirror's footprint, as pg-mirror would leave it
    await chAdmin("CREATE DATABASE IF NOT EXISTS setoku");
    await chAdmin("CREATE DATABASE IF NOT EXISTS biz");
    await chAdmin(
      `CREATE TABLE IF NOT EXISTS setoku.pg_mirror_runs
       (started_at DateTime64(3), finished_at DateTime64(3), target_table LowCardinality(String),
        source_table String, rows UInt64, status LowCardinality(String), error String)
       ENGINE = MergeTree ORDER BY (finished_at, target_table)`,
    );
    await chAdmin("CREATE OR REPLACE TABLE biz.deals (id Int64, amount Int64) ENGINE = MergeTree ORDER BY id");
    await chAdmin("INSERT INTO biz.deals VALUES (1, 100), (2, 250)");
    await chAdmin(`INSERT INTO setoku.pg_mirror_runs VALUES (now64(3), now64(3), 'deals', 'public.deals', 2, 'ok', '')`);

    const repo = makeRepo();
    repos.push(repo);
    procs.push(spawnOn(PORT, repo));
    await waitHealthy(`http://127.0.0.1:${PORT}`);
    mcp = await connect(`http://127.0.0.1:${PORT}`, "tok-analyst");
  }, 40_000);

  afterAll(async () => {
    await mcp?.close();
    for (const p of procs) p.kill();
    await chAdmin("DROP TABLE IF EXISTS biz.deals").catch(() => {});
    await chAdmin("TRUNCATE TABLE setoku.pg_mirror_runs").catch(() => {});
    for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
  });

  it("rejects a postgres query against a mirrored table with the biz.* rewrite", async () => {
    const r = await call("run_query", { sql: "SELECT count(*) FROM deals" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("public.deals → biz.deals");
    expect(r.text).toContain("force_postgres");
  });

  it("force_postgres reads the live source (verification path)", async () => {
    const r = await call("run_query", { sql: "SELECT count(*) AS n FROM deals", force_postgres: true });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("2");
    expect(r.text).not.toContain("mirrored into the lake"); // no nudge on a deliberate force
  });

  it("unmirrored tables still run on postgres untouched", async () => {
    const r = await call("run_query", { sql: "SELECT count(*) AS n FROM side_notes" });
    expect(r.isError).toBe(false);
  });

  it("an identifier collision is not a reference — column/alias named like a mirrored table passes", async () => {
    const r = await call("run_query", { sql: "SELECT count(*) AS deals FROM side_notes" });
    expect(r.isError).toBe(false);
  });

  it("curator sessions cannot slip postgres panels past the gate (no membrane bypass)", async () => {
    const curator = await connect(`http://127.0.0.1:${PORT}`, "tok-curator");
    const r = await gwCall(curator, "publish_app", {
      title: "curator-gate",
      html: "<div id='a'></div>",
      panels: [{ key: "a", sql: "SELECT sum(amount) AS total FROM deals" }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("biz.deals");
    await curator.close();
  });

  it("the mirror itself answers on clickhouse", async () => {
    const r = await call("run_query", { sql: "SELECT sum(amount) AS total FROM biz.deals", dialect: "clickhouse" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("350");
  });

  it("rejects publishing a postgres panel over a mirrored table", async () => {
    const r = await call("publish_app", {
      title: "gate",
      html: "<div id='a'></div>",
      panels: [{ key: "a", sql: "SELECT sum(amount) AS total FROM deals" }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("biz.deals");
  });

  it("accepts the same panel authored against the mirror", async () => {
    const r = await call("publish_app", {
      title: "gate-ok",
      html: "<div id='a'></div><script>Setoku.stat('a','a',{label:'t',value:'total'})</script>",
      panels: [{ key: "a", title: "t", description: "d", sql: "SELECT sum(amount) AS total FROM biz.deals", dialect: "clickhouse" }],
    });
    expect(r.isError).toBe(false);
  });

  it("list_sources declares the mirror as THE read path", async () => {
    const r = await call("list_sources", {});
    expect(r.text).toContain("BUSINESS-DB MIRROR");
    expect(r.text).toContain("THE read path");
    expect(r.text).toContain("biz.deals ← public.deals");
  });

  it('mirrorPolicy "prefer" softens the gate to the nudge', async () => {
    const repo = makeRepo({ mirrorPolicy: "prefer" });
    repos.push(repo);
    const proc = spawnOn(PREFER_PORT, repo);
    procs.push(proc);
    await waitHealthy(`http://127.0.0.1:${PREFER_PORT}`);
    const soft = await connect(`http://127.0.0.1:${PREFER_PORT}`, "tok-analyst");
    const r = await gwCall(soft, "run_query", { sql: "SELECT count(*) AS n FROM deals" });
    expect(r.isError).toBe(false); // runs on postgres…
    expect(r.text).toContain("biz.deals"); // …but carries the steer nudge
    await soft.close();
  }, 20_000);
});
