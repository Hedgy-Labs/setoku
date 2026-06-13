// SPDX-License-Identifier: Apache-2.0
/**
 * e2e for run_query dialect routing (task 3.6, I5): real ClickHouse ⇄ the
 * box's http.ts ⇄ real MCP client. An **analyst** token reads the lake; a
 * **curator** token is refused (the I2/I9 mutual exclusion).
 *
 * Gated on SETOKU_E2E_CH_URL (e.g. http://default:pass@127.0.0.1:18123/default)
 * — skipped when no ClickHouse is reachable. CI provides a service container;
 * locally: docker run --rm -d -p 18123:8123 -e CLICKHOUSE_PASSWORD=pw \
 *            clickhouse/clickhouse-server:25.3
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { spawnGateway, waitHealthy, connect, call as gwCall, FIXTURES } from "./lib/gateway";

const CH_URL = process.env.SETOKU_E2E_CH_URL;

const TABLE = "setoku_lake_e2e";
const PORT = 38741;
const BASE = `http://127.0.0.1:${PORT}`;

let tmpRepo: string;
let proc: Subprocess;
let mcp: McpClient; // analyst token — may read the lake

/** Direct admin call to ClickHouse (test setup/teardown only). */
async function chAdmin(query: string, readonly = false): Promise<Response> {
  const u = new URL(CH_URL!);
  const params = new URLSearchParams({ database: u.pathname.slice(1) || "default" });
  if (readonly) params.set("readonly", "2");
  return fetch(`${u.origin}/?${params}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${decodeURIComponent(u.username) || "default"}:${decodeURIComponent(u.password)}`)}`,
    },
    body: query,
  });
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  gwCall(mcp, name, args);

describe.skipIf(!CH_URL)("run_query dialect routing (lake)", () => {
  beforeAll(async () => {
    const create = await chAdmin(
      `CREATE OR REPLACE TABLE ${TABLE} (event_name String, n UInt32) ENGINE = MergeTree ORDER BY event_name`,
    );
    expect(create.ok).toBe(true);
    const insert = await chAdmin(
      `INSERT INTO ${TABLE} VALUES ('order_placed', 7), ('order_placed', 5), ('cart_abandoned', 3)`,
    );
    expect(insert.ok).toBe(true);

    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-lake-"));
    fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), {
      recursive: true,
    });
    proc = spawnGateway({
      SETOKU_PROJECT_DIR: tmpRepo,
      SETOKU_DB_PATH: path.join(tmpRepo, "knowledge.db"),
      SETOKU_HTTP_PORT: String(PORT),
      SETOKU_TOKENS: "tok-analyst=lake-e2e@test",
      SETOKU_CURATOR_TOKENS: "tok-curator=lake-e2e@test",
      SETOKU_LAKE_URL: CH_URL!,
    });
    await waitHealthy(BASE);
    mcp = await connect(BASE, "tok-analyst");
  }, 30_000);

  afterAll(async () => {
    await mcp?.close();
    proc?.kill();
    await chAdmin(`DROP TABLE IF EXISTS ${TABLE}`);
    if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("executes clickhouse-dialect metric SQL against the lake", async () => {
    const r = await call("run_query", {
      sql: `SELECT event_name, sum(n) AS total FROM ${TABLE} GROUP BY event_name ORDER BY total DESC`,
      dialect: "clickhouse",
      purpose: "lake e2e",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("order_placed");
    expect(r.text).toContain("12");
  });

  it("supports lake discovery via DESCRIBE", async () => {
    const r = await call("run_query", {
      sql: `DESCRIBE TABLE ${TABLE}`,
      dialect: "clickhouse",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("event_name");
  });

  it("applies the row cap with a truncation notice", async () => {
    const r = await call("run_query", {
      sql: "SELECT number FROM system.numbers LIMIT 250",
      dialect: "clickhouse",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("TRUNCATED at row cap"); // fixture config caps at 50
  });

  it("rejects mutations at the statement gate", async () => {
    const r = await call("run_query", {
      sql: `INSERT INTO ${TABLE} VALUES ('evil', 1)`,
      dialect: "clickhouse",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("read");
  });

  it("the engine itself rejects writes under readonly (the wall behind the gate)", async () => {
    // bypass our gate entirely: hit ClickHouse the way runLakeQuery does
    const res = await chAdmin(`INSERT INTO ${TABLE} VALUES ('evil', 2)`, true);
    expect(res.ok).toBe(false);
    expect(await res.text()).toMatch(/readonly|READONLY/);
  });

  it("postgres stays the default dialect (no lake config leakage)", async () => {
    const r = await call("run_query", { sql: `SELECT * FROM ${TABLE} LIMIT 1` });
    // default dialect targets the business Postgres — this table doesn't exist there
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("order_placed");
  });

  it("a curator token is refused on the lake (mutual exclusion, I2/I9)", async () => {
    const curator = await connect(BASE, "tok-curator");
    const res = (await curator.callTool({
      name: "run_query",
      arguments: { sql: `SELECT * FROM ${TABLE}`, dialect: "clickhouse" },
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => c.text).join("").toLowerCase()).toContain(
      "curator session",
    );
    await curator.close();
  });
});
