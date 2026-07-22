// SPDX-License-Identifier: Apache-2.0
/**
 * e2e for run_query against a real ClickHouse — the gateway's ONLY query
 * engine (I5; the direct business-Postgres path is retired): real ClickHouse
 * ⇄ the box's http.ts ⇄ real MCP client. An **analyst** token reads the lake;
 * a **curator** token is refused (the I2/I9 mutual exclusion).
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

  it("list_sources splits connected sources from never-connected empty tables", async () => {
    // These are the CANONICAL production table names — refuse to touch a lake
    // that already holds data in any of them (someone pointed SETOKU_E2E_CH_URL
    // at a real box), rather than CREATE OR REPLACE-ing away real archives (I4).
    const TABLES = ["slack_messages", "logs_vercel", "github_issues", "mercury_accounts", "mercury_events", "ingest_heartbeats"];
    for (const t of TABLES) {
      const probe = await chAdmin(`SELECT count() FROM setoku.${t}`, true);
      if (probe.ok && Number((await probe.text()).trim()) > 0) {
        throw new Error(`refusing to run: setoku.${t} already holds data — SETOKU_E2E_CH_URL points at a non-disposable lake`);
      }
    }
    // bootstrap-style footprint: a flowing source, an empty one, a quiet-but-
    // beating one, and a partially-connected family (mercury accounts flowing,
    // mercury webhooks empty)
    await chAdmin("CREATE DATABASE IF NOT EXISTS setoku");
    await chAdmin(
      "CREATE OR REPLACE TABLE setoku.slack_messages (event_ts DateTime64(3), text String) ENGINE = MergeTree ORDER BY event_ts",
    );
    await chAdmin("INSERT INTO setoku.slack_messages VALUES (now64(3), 'hi')");
    await chAdmin("CREATE OR REPLACE TABLE setoku.logs_vercel (ts DateTime64(3)) ENGINE = MergeTree ORDER BY ts");
    await chAdmin(
      "CREATE OR REPLACE TABLE setoku.github_issues (ingested_at DateTime64(3)) ENGINE = MergeTree ORDER BY ingested_at",
    );
    await chAdmin(
      "CREATE OR REPLACE TABLE setoku.mercury_accounts (snapshot_ts DateTime64(3)) ENGINE = MergeTree ORDER BY snapshot_ts",
    );
    await chAdmin("INSERT INTO setoku.mercury_accounts VALUES (now64(3))");
    await chAdmin(
      "CREATE OR REPLACE TABLE setoku.mercury_events (received_at DateTime64(3)) ENGINE = MergeTree ORDER BY received_at",
    );
    await chAdmin(
      "CREATE OR REPLACE TABLE setoku.ingest_heartbeats (connector LowCardinality(String), beat_at DateTime64(3), detail String) ENGINE = ReplacingMergeTree(beat_at) ORDER BY connector",
    );
    await chAdmin("INSERT INTO setoku.ingest_heartbeats VALUES ('github-poller', now64(3), 'test')");
    try {
      const r = await call("list_sources");
      expect(r.isError).toBe(false);
      // business data is the biz.* mirror now — no pg_mirror_runs in this lake,
      // so the section reports the mirror isn't flowing (no direct-pg fallback)
      expect(r.text).toContain("no biz.* mirror is flowing yet");
      expect(r.text).not.toContain("BUSINESS DATABASE (Postgres)");
      expect(r.text).toContain("setoku.slack_messages"); // has rows → listed
      expect(r.text).toContain("setoku.github_issues"); // empty but a live beat → listed
      expect(r.text).toMatch(/Not connected[^\n]*Vercel/); // empty, no beat → segregated
      // family-level classification: the empty webhooks sibling neither flags
      // Mercury as not-connected nor vanishes — the family is connected, so
      // all its present tables list
      expect(r.text).not.toMatch(/Not connected[^\n]*Mercury/);
      expect(r.text).toContain("setoku.mercury_events");
      expect(r.text).not.toContain("ingest_heartbeats"); // plumbing, never listed
    } finally {
      for (const t of TABLES) {
        await chAdmin(`DROP TABLE IF EXISTS setoku.${t}`);
      }
    }
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
    expect(r.text).toContain("TRUNCATED at the model-context row cap (50)"); // fixture config caps at 50
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

  it("clickhouse is the default dialect — a bare run_query hits the lake", async () => {
    // the direct business-Postgres path is retired, so no-dialect goes to the
    // gateway's only engine and returns the data (same answer as the explicit
    // dialect:"clickhouse" call above)
    const r = await call("run_query", {
      sql: `SELECT event_name, sum(n) AS total FROM ${TABLE} GROUP BY event_name ORDER BY total DESC`,
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("order_placed");
    expect(r.text).toContain("12");
  });

  it('dialect:"postgres" is retired — rejected with the biz.* rewrite pointer', async () => {
    const r = await call("run_query", {
      sql: `SELECT * FROM ${TABLE} LIMIT 1`,
      dialect: "postgres",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("retired");
    expect(r.text).toContain("biz.");
    expect(r.text).not.toContain("order_placed"); // fails fast, never executed
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
