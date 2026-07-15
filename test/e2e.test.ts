// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end test of the Setoku gateway:
 *   fake ClickHouse lake (wire-level) ⇄ real MCP client over HTTP ⇄ the
 *   exact http.ts the box runs. Exercises both token classes: a **curator**
 *   token (may commit curated knowledge, blocked from the lake) drives the
 *   generate/curate surface; an **analyst** token is propose-only (I2/I9) but
 *   owns every data read — the gateway's only query engine is ClickHouse (the
 *   direct business-Postgres path is retired; business tables are the biz.*
 *   mirror), so run_query / panels / get_schema run here against canned rows
 *   from test/lib/fakelake plus assertions on what actually reached the
 *   engine (SQL text + the readonly/cap params). Real-engine semantics live
 *   in the CH-gated suite (test/lake.test.ts).
 *
 * No LLM is involved — this proves the deterministic layer (tools, governance,
 * retrieval). The inference layer (skills) is exercised live in Claude Code.
 *
 * Needs NO local services: the lake is faked in-process.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { spawnGateway, waitHealthy, connect, call as gwCall, FIXTURES } from "./lib/gateway";
import { startFakeLake, innerSql, type FakeLake } from "./lib/fakelake";

const PORT = 38731;
const BASE = `http://127.0.0.1:${PORT}`;
const CURATOR = "tok-curator";
const ANALYST = "tok-analyst";

let tmpRepo: string;
let dbPath: string;
let proc: Subprocess;
let lake: FakeLake;
let mcp: McpClient; // connected with the curator token
let analyst: McpClient; // analyst token — the only session that may read data

const call = (name: string, args: Record<string, unknown> = {}) =>
  gwCall(mcp, name, args);
const acall = (name: string, args: Record<string, unknown> = {}) =>
  gwCall(analyst, name, args);

// What ClickHouse system.columns would grant this box: the biz.* business-DB
// mirror (the synthetic shop) plus one lake table. get_schema renders straight
// from this — permission scoping is the ENGINE's, so what the fake returns IS
// the queryable surface.
const SCHEMA_ROWS = [
  { database: "biz", table: "customers", name: "id", type: "Int64" },
  { database: "biz", table: "customers", name: "email", type: "String" },
  { database: "biz", table: "customers", name: "deleted_at", type: "Nullable(DateTime64(3))" },
  { database: "biz", table: "orders", name: "id", type: "Int64" },
  { database: "biz", table: "orders", name: "customer_id", type: "Int64" },
  { database: "biz", table: "orders", name: "status", type: "String" },
  { database: "biz", table: "orders", name: "total_cents", type: "Int64" },
  { database: "biz", table: "order_items", name: "id", type: "Int64" },
  { database: "biz", table: "order_items", name: "order_id", type: "Int64" },
  { database: "setoku", table: "slack_messages", name: "event_ts", type: "DateTime64(3)" },
  { database: "setoku", table: "slack_messages", name: "text", type: "String" },
];

function boot(): void {
  proc = spawnGateway({
    SETOKU_PROJECT_DIR: tmpRepo,
    SETOKU_DB_PATH: dbPath,
    SETOKU_LAKE_URL: lake.url,
    // The retired path must never even be dialed: this URL is unroutable, so
    // any attempted business-Postgres connection would surface as a network
    // error instead of the curated retirement message the tests assert on.
    SETOKU_DATABASE_URL: "postgresql://x:y@127.0.0.1:1/nope",
    SETOKU_HTTP_PORT: String(PORT),
    SETOKU_TOKENS: `${ANALYST}=e2e@test`,
    SETOKU_CURATOR_TOKENS: `${CURATOR}=e2e@test`,
  });
}

beforeAll(async () => {
  // 1. a fake lake with canned answers for everything this suite queries —
  // matched on inner SQL substrings (see test/lib/fakelake.ts)
  lake = startFakeLake((sql) => {
    const q = innerSql(sql);
    if (q.includes("system.columns")) return { rows: SCHEMA_ROWS };
    if (q.includes("sorting_key"))
      return {
        rows: [
          { database: "biz", name: "customers", sorting_key: "id" },
          { database: "biz", name: "orders", sorting_key: "id" },
        ],
      };
    if (q.includes("pg_mirror_runs")) return { rows: [] }; // no mirror metadata on this box
    if (q.includes("SUM(total_cents)")) return { rows: [{ revenue_dollars: 225 }] };
    // the engine wall behind the statement gate: a write that slips past the
    // first-keyword gate (a modifying CTE) dies on readonly, like real CH
    if (q.includes("UPDATE orders"))
      return { exception: "Code: 164. DB::Exception: Cannot execute query in readonly mode" };
    if (q.includes("no_such_table_here"))
      return { exception: "Code: 60. DB::Exception: Unknown table expression identifier 'no_such_table_here'" };
    // rowCap is 50 (fixture config) — 51 rows trips the truncation sentinel
    if (q.includes("system.numbers"))
      return { rows: Array.from({ length: 51 }, (_, i) => ({ number: i })) };
    if (q.includes("count(*)") && q.includes("biz.orders")) return { rows: [{ n: 3 }] };
    return null; // default single-row { ok: 1 }
  });

  // 2. fake "business repo" with a .setoku dir (copied from fixtures).
  // The markdown fixtures double as a test of the file → store seed importer.
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-e2e-"));
  fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), {
    recursive: true,
  });
  dbPath = path.join(tmpRepo, "knowledge.db");

  // 3. spawn the HTTP gateway exactly as the box runs it, then connect a real
  // MCP client per token class (curator drives generate/curate; analyst reads).
  boot();
  await waitHealthy(BASE);
  mcp = await connect(BASE, CURATOR);
  analyst = await connect(BASE, ANALYST, "analyst");
}, 30_000);

afterAll(async () => {
  await mcp?.close();
  await analyst?.close();
  proc?.kill();
  lake?.stop();
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe("tool surface", () => {
  it("exposes the v0 tools (curator token: write tools present)", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "app_guide",
        "describe_entity",
        "find_context",
        "get_app",
        "get_metric",
        "get_schema",
        "list_corrections",
        "list_apps",
        "list_entities",
        "list_sources",
        "publish_app",
        "report_correction",
        "resolve_correction",
        "run_query",
        "unpublish_app",
        "update_app",
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

describe("get_schema (engine-scoped ClickHouse metadata)", () => {
  it("lists every queryable table from system.columns, biz.* first", async () => {
    const { text, isError } = await call("get_schema");
    expect(isError).toBe(false);
    expect(text).toContain('queryable tables (run_query dialect:"clickhouse")');
    expect(text).toContain("biz.customers");
    expect(text).toContain("biz.orders");
    expect(text).toContain("biz.order_items");
    expect(text).toContain("setoku.slack_messages");
    expect(text.indexOf("biz.customers")).toBeLessThan(text.indexOf("setoku.slack_messages"));
    // order_items has no entity doc — the drift note flags the gap
    expect(text).toContain("no context doc yet");
    // scoping is the ENGINE's, not ours: the metadata fetch is pinned to the
    // queryable databases and excludes the heartbeat plumbing up front
    const meta = lake.calls.find((c) => c.sql.includes("system.columns"));
    expect(meta).toBeTruthy();
    expect(meta!.sql).toContain("database IN ('biz','setoku')");
    expect(meta!.sql).toContain("ingest_heartbeats");
  });

  it("returns full detail (types + ORDER BY key) for requested tables", async () => {
    const { text } = await call("get_schema", { tables: ["orders"] });
    expect(text).toContain("# biz.orders (ORDER BY id)");
    expect(text).toContain("- total_cents: Int64");
    expect(text).toContain("- status: String");
    expect(text).not.toContain("biz.customers"); // detail is scoped to the ask
  });
});

describe("run_query governance (analyst session)", () => {
  it("answers the canonical revenue query from the biz.* mirror", async () => {
    const { text, isError } = await acall("run_query", {
      sql: "SELECT SUM(total_cents)/100.0 AS revenue_dollars FROM biz.orders WHERE status = 'paid'",
      purpose: "e2e revenue check",
    });
    expect(isError).toBe(false);
    expect(text).toContain("225"); // canned: 100 + 50 + 75 dollars, refunds excluded
    // …and it reached the engine through the governed wrapper, with the
    // engine-enforced caps pinned on the request itself (I9: the engine is
    // the wall — every query carries readonly + row cap + timeout)
    const req = lake.calls.find((c) => c.sql.includes("SUM(total_cents)"));
    expect(req).toBeTruthy();
    expect(req!.sql).toContain("_setoku_q LIMIT 51"); // fixture rowCap 50 + sentinel
    expect(req!.params.get("readonly")).toBe("2");
    expect(req!.params.get("max_result_rows")).toBe("51");
    expect(req!.params.get("max_execution_time")).toBe("2"); // ceil(1500ms fixture timeout)
  });

  it("rejects INSERT at the statement gate — nothing reaches the engine", async () => {
    const { text, isError } = await acall("run_query", {
      sql: "INSERT INTO biz.customers (email, name) VALUES ('x@x.com','X')",
    });
    expect(isError).toBe(true);
    expect(text).toContain("Only read statements");
    expect(lake.calls.some((c) => c.sql.includes("x@x.com"))).toBe(false);
  });

  it("rejects multiple statements — nothing reaches the engine", async () => {
    const { text, isError } = await acall("run_query", {
      sql: "SELECT 1; SELECT 'smuggle-two'",
    });
    expect(isError).toBe(true);
    expect(text).toContain("Multiple statements");
    expect(lake.calls.some((c) => c.sql.includes("smuggle-two"))).toBe(false);
  });

  it("a write smuggled through a CTE dies on the engine's readonly wall", async () => {
    // WITH passes the first-keyword gate, so the request DOES go out — but the
    // gateway pins readonly=2 on it, and the engine (faked with real CH's
    // answer) rejects the write. Defense in depth: gate in front, wall behind.
    const { text, isError } = await acall("run_query", {
      sql: "WITH x AS (UPDATE orders SET status = 'paid' RETURNING id) SELECT * FROM x",
    });
    expect(isError).toBe(true);
    expect(text.toLowerCase()).toContain("readonly");
    const req = lake.calls.find((c) => c.sql.includes("UPDATE orders"));
    expect(req).toBeTruthy();
    expect(req!.params.get("readonly")).toBe("2");
  });

  it("truncates at the row cap", async () => {
    const { text, isError } = await acall("run_query", {
      sql: "SELECT number FROM system.numbers LIMIT 250",
    });
    expect(isError).toBe(false);
    expect(text).toContain("TRUNCATED");
    expect(text).toContain("(50)"); // fixture rowCap
  });

  it('the postgres dialect is retired — rejected before any connection attempt', async () => {
    // SETOKU_DATABASE_URL points at an unroutable address (see boot()): if the
    // gateway still tried to dial Postgres, this would be a network error, not
    // the curated retirement message with the biz.* rewrite pointer.
    const { text, isError } = await acall("run_query", {
      sql: "SELECT 1 AS legacy_probe",
      dialect: "postgres",
    });
    expect(isError).toBe(true);
    expect(text).toContain("retired");
    expect(text).toContain("biz.");
    // the lake wasn't consulted either — the dialect fails fast, pre-engine
    expect(lake.calls.some((c) => c.sql.includes("legacy_probe"))).toBe(false);
  });
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
    await analyst.close();
    proc.kill();
    await proc.exited;
    boot();
    await waitHealthy(BASE);
    mcp = await connect(BASE, CURATOR, "setoku-e2e-2");
    analyst = await connect(BASE, ANALYST, "analyst-2");
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
    // the retired dialect is audited as such, not as an engine failure
    const retired = records.find(
      (r) => r.tool === "run_query" && r.payload.error === "pg-retired",
    );
    expect(retired).toBeTruthy();
  });
});

describe("app surface", () => {
  it("publishes a live app (dry-runs the panel), inspects it, lists it, then revokes it", async () => {
    const pub = await acall("publish_app", {
      title: "Paid orders",
      html: '<div id="n"></div><script>document.getElementById("n").textContent=window.__SETOKU__.panels.paid.rows[0].n</script>',
      panels: [
        {
          key: "paid",
          title: "Paid order count",
          sql: "SELECT count(*) AS n FROM biz.orders WHERE status = 'paid'",
          dialect: "clickhouse",
          metricId: "revenue",
        },
      ],
      refreshSeconds: 60,
    });
    expect(pub.isError).toBeFalsy();
    expect(pub.text).toContain("TEAM-ONLY");
    expect(pub.text).toContain("1 live panel"); // dry-ran + reported
    expect(pub.text).not.toContain("no curated metric"); // "revenue" exists in the fixture
    const id = (pub.text.match(/\/apps\/([0-9a-f]+)/) ?? [])[1];
    expect(id).toBeTruthy();

    // the dry-run went through the governed lake path with the canned answer
    const dry = lake.calls.find(
      (c) => c.sql.includes("count(*)") && c.sql.includes("biz.orders"),
    );
    expect(dry).toBeTruthy();
    expect(dry!.params.get("readonly")).toBe("2");

    // get_app surfaces how it's calculated: the SQL + the last run
    const got = await acall("get_app", { id });
    expect(got.isError).toBeFalsy();
    expect(got.text).toContain("count(*)");
    expect(got.text).toContain("metric:revenue");
    expect(got.text).toMatch(/1 row\(s\)/); // seeded from the publish dry-run
    // ...and hands back the full HTML/JS template for edit-in-place (#59)
    expect(got.text).toContain("## template");
    expect(got.text).toContain("window.__SETOKU__.panels.paid.rows[0].n");

    const listed = await acall("list_apps");
    expect(listed.text).toContain("Paid orders");
    expect(listed.text).toContain("1 panel");
    expect(listed.text).toContain(id!);

    const off = await acall("unpublish_app", { id });
    expect(off.isError).toBeFalsy();
    // a second revoke is a no-op error (already archived)
    const again = await acall("unpublish_app", { id });
    expect(again.isError).toBe(true);
  });

  it("rejects an app whose panel query is broken (dry-run gate)", async () => {
    const r = await acall("publish_app", {
      title: "broken",
      html: "<div></div>",
      panels: [{ key: "x", sql: "SELECT * FROM no_such_table_here", dialect: "clickhouse" }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Panel "x" failed to run');
  });

  it("rejects a postgres-dialect panel — the direct business-Postgres path is retired", async () => {
    const r = await acall("publish_app", {
      title: "legacy",
      html: "<div></div>",
      panels: [{ key: "legacy", sql: "SELECT count(*) AS n FROM orders", dialect: "postgres" }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Panel "legacy"');
    expect(r.text).toContain("retired");
    expect(r.text).toContain("biz.");
  });

  it("blocks a curator session from authoring a lake-backed panel (I2/I9 membrane)", async () => {
    const r = await call("publish_app", {
      title: "lake panel",
      html: "<div></div>",
      panels: [{ key: "logs", sql: "SELECT count() AS n FROM logs_vercel", dialect: "clickhouse" }],
    });
    expect(r.isError).toBe(true);
    expect(r.text.toLowerCase()).toContain("membrane");
  });

  it("publishes a zero-panel fragment app (state-only / presentational)", async () => {
    const pub = await call("publish_app", {
      title: "Q2 revenue",
      html: "<h1>Q2 revenue</h1><p>$225</p>",
    });
    expect(pub.isError).toBeFalsy();
    const id = (pub.text.match(/\/apps\/([0-9a-f]+)/) ?? [])[1];
    expect(id).toBeTruthy();
    const listed = await call("list_apps");
    expect(listed.text).toContain("Q2 revenue");
    expect(listed.text).toContain("static"); // no live panels
    await call("unpublish_app", { id });
  });

  it("rejects a full HTML document — apps are fragments the runtime wraps", async () => {
    const r = await call("publish_app", {
      title: "full doc",
      html: "<!doctype html><html><body><h1>hi</h1></body></html>",
    });
    expect(r.isError).toBe(true);
    expect(r.text.toLowerCase()).toContain("fragment");
  });

  it("rejects an oversized template", async () => {
    const huge = "x".repeat(2_000_001);
    const r = await call("publish_app", { title: "too big", html: huge });
    expect(r.isError).toBe(true);
    expect(r.text.toLowerCase()).toContain("cap");
  });

  it("edits an app in place — same id, new title + panels", async () => {
    const pub = await acall("publish_app", {
      title: "Editable",
      html: "<div id=x></div>",
      panels: [{ key: "a", sql: "SELECT count(*) AS n FROM biz.orders WHERE status='paid'", dialect: "clickhouse" }],
    });
    const id = (pub.text.match(/\/apps\/([0-9a-f]+)/) ?? [])[1];

    const upd = await acall("update_app", {
      id,
      title: "Edited title",
      panels: [{ key: "b", sql: "SELECT count(*) AS n FROM biz.orders", dialect: "clickhouse" }],
    });
    expect(upd.isError).toBeFalsy();
    expect(upd.text).toContain(id); // same link

    const got = await acall("get_app", { id });
    expect(got.text).toContain("Edited title");
    expect(got.text).toContain("panel b"); // new panel present
    expect(got.text).not.toContain("panel a"); // old panel replaced
    await acall("unpublish_app", { id });
  });
});
