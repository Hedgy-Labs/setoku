// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end test of the Setoku gateway:
 *   real Postgres (synthetic shop schema) ⇄ real MCP client over HTTP ⇄ the
 *   exact http.ts the box runs. Exercises both token classes: a **curator**
 *   token (may commit curated knowledge, blocked from the lake) drives the
 *   generate/curate surface; an **analyst** token is propose-only (I2/I9).
 *
 * No LLM is involved — this proves the deterministic layer (tools, governance,
 * retrieval). The inference layer (skills) is exercised live in Claude Code.
 *
 * Requires a local Postgres. Default connection is via unix socket as the
 * current OS user; override with SETOKU_E2E_PG_HOST / SETOKU_E2E_DB_URL.
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

const PG_HOST = process.env.SETOKU_E2E_PG_HOST ?? "/tmp"; // unix socket dir or hostname
const DB_NAME = "setoku_e2e";
const DB_URL =
  process.env.SETOKU_E2E_DB_URL ??
  `postgresql:///${DB_NAME}?host=${encodeURIComponent(PG_HOST)}`;
const PORT = 38731;
const BASE = `http://127.0.0.1:${PORT}`;
const CURATOR = "tok-curator";
const ANALYST = "tok-analyst";

let tmpRepo: string;
let dbPath: string;
let proc: Subprocess;
let mcp: McpClient; // connected with the curator token

const call = (name: string, args: Record<string, unknown> = {}) =>
  gwCall(mcp, name, args);

function boot(): void {
  proc = spawnGateway({
    SETOKU_PROJECT_DIR: tmpRepo,
    SETOKU_DB_PATH: dbPath,
    SETOKU_E2E_DB_URL: DB_URL,
    SETOKU_HTTP_PORT: String(PORT),
    SETOKU_TOKENS: `${ANALYST}=e2e@test`,
    SETOKU_CURATOR_TOKENS: `${CURATOR}=e2e@test`,
  });
}

beforeAll(async () => {
  // 1. (re)create the test database and load the synthetic schema
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

  // 2. fake "business repo" with a .setoku dir (copied from fixtures).
  // The markdown fixtures double as a test of the file → store seed importer.
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-e2e-"));
  fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), {
    recursive: true,
  });
  dbPath = path.join(tmpRepo, "knowledge.db");

  // 3. spawn the HTTP gateway exactly as the box runs it, then connect a real
  // MCP client with the CURATOR token (this suite drives generate/curate).
  boot();
  await waitHealthy(BASE);
  mcp = await connect(BASE, CURATOR);
}, 30_000);

afterAll(async () => {
  await mcp?.close();
  proc?.kill();
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe("tool surface", () => {
  it("exposes the v0 tools (curator token: write tools present)", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "describe_entity",
        "find_context",
        "get_metric",
        "get_schema",
        "list_corrections",
        "list_entities",
        "list_sources",
        "report_correction",
        "resolve_correction",
        "run_query",
        "upsert_context",
      ].sort(),
    );
  });

  it("the analyst token is propose-only: no curated-write tools (I2/I9)", async () => {
    const proposeOnly = await connect(BASE, ANALYST, "propose-only");
    const names = (await proposeOnly.listTools()).tools.map((t) => t.name);
    // can propose and read the queue …
    expect(names).toContain("report_correction");
    expect(names).toContain("list_corrections");
    // … but cannot commit curated knowledge
    expect(names).not.toContain("upsert_context");
    expect(names).not.toContain("resolve_correction");
    // and a forged call is rejected, not silently executed
    const res = (await proposeOnly.callTool({
      name: "upsert_context",
      arguments: { type: "gotcha", name: "x", body: "y" },
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => c.text).join("")).toMatch(/not found/i);
    await proposeOnly.close();
  });

  it("a curator token cannot read the lake (mutual exclusion, I2/I9)", async () => {
    const r = await call("run_query", {
      sql: "SELECT 1",
      dialect: "clickhouse",
      purpose: "should be refused",
    });
    expect(r.isError).toBe(true);
    expect(r.text.toLowerCase()).toContain("curator session");
  });
});

describe("get_schema (permission-scoped)", () => {
  it("lists allowed tables and hides denied ones", async () => {
    const { text, isError } = await call("get_schema");
    expect(isError).toBe(false);
    expect(text).toContain("public.customers");
    expect(text).toContain("public.orders");
    expect(text).toContain("public.order_items");
    expect(text).not.toContain("internal_notes");
  });

  it("returns full detail (types, PK, FK) for requested tables", async () => {
    const { text } = await call("get_schema", { tables: ["orders"] });
    expect(text).toContain("public.orders");
    expect(text).toContain("total_cents: integer");
    expect(text).toContain("PK");
    expect(text).toContain("→ public.customers.id");
  });
});

describe("run_query governance", () => {
  it("answers the canonical revenue query correctly", async () => {
    const { text, isError } = await call("run_query", {
      sql: "SELECT SUM(total_cents)/100.0 AS revenue_dollars FROM orders WHERE status = 'paid'",
      purpose: "e2e revenue check",
    });
    expect(isError).toBe(false);
    expect(text).toContain("225"); // 100 + 50 + 75 dollars; refunded 200 excluded
  });

  it("rejects INSERT", async () => {
    const { text, isError } = await call("run_query", {
      sql: "INSERT INTO customers (email, name) VALUES ('x@x.com','X')",
    });
    expect(isError).toBe(true);
    expect(text).toContain("Only read statements");
  });

  it("rejects multiple statements", async () => {
    const { text, isError } = await call("run_query", {
      sql: "SELECT 1; SELECT 2",
    });
    expect(isError).toBe(true);
    expect(text).toContain("Multiple statements");
  });

  it("rejects a write smuggled through a CTE (READ ONLY transaction)", async () => {
    const { text, isError } = await call("run_query", {
      sql: "WITH x AS (UPDATE orders SET status = 'paid' RETURNING id) SELECT * FROM x",
    });
    expect(isError).toBe(true);
    // blocked either by the row-cap subquery wrap (modifying CTEs must be top-level)
    // or by the READ ONLY transaction — both layers reject the write
    expect(text.toLowerCase()).toMatch(/read-only|must be at the top level/);
  });

  it("verifies the smuggled write did not happen", async () => {
    const { text } = await call("run_query", {
      sql: "SELECT count(*) AS n FROM orders WHERE status = 'refunded'",
    });
    expect(text).toContain("1"); // still exactly one refunded order
  });

  it("truncates at the row cap", async () => {
    const { text, isError } = await call("run_query", {
      sql: "SELECT generate_series(1, 1000) AS n",
    });
    expect(isError).toBe(false);
    expect(text).toContain("TRUNCATED");
    expect(text).toContain("50"); // fixture rowCap
  });

  it("enforces the statement timeout", async () => {
    const { text, isError } = await call("run_query", {
      sql: "SELECT pg_sleep(5)",
    });
    expect(isError).toBe(true);
    expect(text.toLowerCase()).toContain("timeout");
  }, 10_000);
});

describe("context retrieval", () => {
  it("find_context surfaces the revenue metric AND the refund gotcha", async () => {
    const { text, isError } = await call("find_context", {
      question: "How much revenue did we make last month?",
    });
    expect(isError).toBe(false);
    expect(text).toContain("Gotchas");
    expect(text).toContain("Refunded orders must be excluded");
    expect(text).toContain("[metric] revenue");
    expect(text).toContain("status = 'paid'");
  });

  it("find_context surfaces soft-delete context for customer counts", async () => {
    const { text } = await call("find_context", {
      question: "how many customers do we have",
    });
    expect(text).toContain("soft-deleted");
    expect(text).toContain("Customer");
  });

  it("list_entities returns the artifact index", async () => {
    const { text } = await call("list_entities");
    expect(text).toContain("Customer");
    expect(text).toContain("Order");
    expect(text).toContain("revenue");
  });

  it("describe_entity resolves by name and by table", async () => {
    const byName = await call("describe_entity", { name: "Order" });
    expect(byName.text).toContain("Semantics");
    const byTable = await call("describe_entity", { name: "public.customers" });
    expect(byTable.text).toContain("Customer");
  });

  it("get_metric returns canonical SQL; unknown metric lists known ones", async () => {
    const ok = await call("get_metric", { name: "revenue" });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("SUM(total_cents)");
    const missing = await call("get_metric", { name: "churn" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("revenue");
  });
});

describe("curation + knowledge store + audit", () => {
  it("report_correction stores an attributed pending candidate", async () => {
    const { text, isError } = await call("report_correction", {
      kind: "gotcha",
      fact: "Pending orders are excluded from conversion-rate denominators",
      relates_to: "Order",
    });
    expect(isError).toBe(false);
    expect(text).toContain("e2e@test");
    const listed = await call("list_corrections", {});
    expect(listed.text).toContain("Pending orders are excluded");
    expect(listed.text).toContain("e2e@test");
    expect(listed.text).toContain("re: Order");
  });

  it("pending corrections are live immediately as labeled unverified knowledge (D10)", async () => {
    const { text, isError } = await call("find_context", {
      question: "what is our conversion rate?",
    });
    expect(isError).toBe(false);
    expect(text).toContain("Unverified team knowledge");
    expect(text).toContain(
      "Pending orders are excluded from conversion-rate denominators",
    );
    expect(text).toContain("e2e@test"); // attributed
  });

  it("resolve_correction clears the candidate from pending + unverified surfacing", async () => {
    const resolved = await call("resolve_correction", { id: 1, action: "rejected" });
    expect(resolved.isError).toBe(false);
    const listed = await call("list_corrections", {});
    expect(listed.text).toContain("No pending corrections");
    const fc = await call("find_context", { question: "what is our conversion rate?" });
    expect(fc.text).not.toContain("Unverified team knowledge");
  });

  it("upsert_context writes through to retrieval immediately", async () => {
    const saved = await call("upsert_context", {
      type: "gotcha",
      name: "tax-exclusive",
      body: "All revenue figures exclude sales tax — tax lives in a separate ledger",
    });
    expect(saved.isError).toBe(false);
    const fc = await call("find_context", { question: "does revenue include tax?" });
    expect(fc.text).toContain("exclude sales tax");
    const metric = await call("upsert_context", {
      type: "metric",
      name: "aov",
      meta: { summary: "Average order value (paid orders)", keywords: ["basket", "average"] },
      body: "## Canonical SQL\n```sql\nSELECT AVG(total_cents)/100.0 FROM orders WHERE status = 'paid';\n```",
    });
    expect(metric.isError).toBe(false);
    const got = await call("get_metric", { name: "aov" });
    expect(got.text).toContain("AVG(total_cents)");
  });

  it("knowledge survives a gateway restart (it lives in the service DB, not the process)", async () => {
    await mcp.close();
    proc.kill();
    await proc.exited;
    boot();
    await waitHealthy(BASE);
    mcp = await connect(BASE, CURATOR, "setoku-e2e-2");
    const got = await call("get_metric", { name: "aov" });
    expect(got.isError).toBe(false);
    expect(got.text).toContain("AVG(total_cents)");
    // seed-import did not re-run / duplicate (store was non-empty on boot)
    const listed = await call("list_entities", {});
    expect((listed.text.match(/- revenue/g) ?? []).length).toBe(1);
  }, 15_000);

  it("every tool call is attributed in the audit table (seed is system)", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const records = (
      db.query("SELECT user, tool, payload FROM audit").all() as {
        user: string;
        tool: string;
        payload: string;
      }[]
    ).map((r) => ({ ...r, payload: JSON.parse(r.payload ?? "{}") }));
    db.close();
    expect(records.length).toBeGreaterThan(10);
    // tool calls are attributed to the token identity; seed_from_files is a system action
    const calls = records.filter((r) => r.tool !== "seed_from_files");
    expect(calls.every((r) => r.user === "e2e@test")).toBe(true);
    const tools = new Set(records.map((r) => r.tool));
    for (const t of [
      "find_context",
      "get_schema",
      "run_query",
      "report_correction",
      "resolve_correction",
      "upsert_context",
      "seed_from_files",
    ]) {
      expect(tools.has(t)).toBe(true);
    }
    const rejected = records.find(
      (r) =>
        r.tool === "run_query" &&
        r.payload.ok === false &&
        /INSERT/i.test(r.payload.sql ?? ""),
    );
    expect(rejected).toBeTruthy();
  });
});
