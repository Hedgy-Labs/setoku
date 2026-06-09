/**
 * End-to-end test of the Setoku gateway:
 *   real Postgres (synthetic shop schema) ⇄ real MCP client over stdio ⇄ the
 *   exact server.ts the plugin ships, launched the way Claude Code launches it.
 *
 * No LLM is involved — this proves the deterministic layer (tools, governance,
 * retrieval). The inference layer (skills) is exercised live in Claude Code.
 *
 * Requires a local Postgres. Default connection is via unix socket as the
 * current OS user; override with SETOKU_E2E_PG_HOST / SETOKU_E2E_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pgPkg from "pg";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { Client: PgClient } = pgPkg;

const ROOT = path.resolve(import.meta.dir, "..");
const SERVER = path.join(ROOT, "plugin", "gateway", "server.ts");
const FIXTURES = path.join(ROOT, "test", "fixtures");

const PG_HOST = process.env.SETOKU_E2E_PG_HOST ?? "/tmp"; // unix socket dir or hostname
const DB_NAME = "setoku_e2e";
const DB_URL =
  process.env.SETOKU_E2E_DB_URL ??
  `postgresql:///${DB_NAME}?host=${encodeURIComponent(PG_HOST)}`;

let tmpRepo: string;
let mcp: McpClient;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const res = (await mcp.callTool({
    name,
    arguments: args,
  })) as unknown as ToolResult;
  const text = (res.content ?? []).map((c) => c.text).join("\n");
  return { text, isError: !!res.isError };
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

  // 2. fake "business repo" with a .setoku dir (copied from fixtures)
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-e2e-"));
  fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), {
    recursive: true,
  });

  // 3. connect a real MCP client to the real server over stdio
  mcp = new McpClient({ name: "setoku-e2e", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER],
    cwd: tmpRepo,
    env: {
      ...(process.env as Record<string, string>),
      SETOKU_PROJECT_DIR: tmpRepo,
      SETOKU_E2E_DB_URL: DB_URL,
      SETOKU_USER: "e2e@test",
    },
  });
  await mcp.connect(transport);
}, 30_000);

afterAll(async () => {
  await mcp?.close();
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe("tool surface", () => {
  it("exposes the seven v0 tools", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "describe_entity",
        "find_context",
        "get_metric",
        "get_schema",
        "list_entities",
        "report_correction",
        "run_query",
      ].sort(),
    );
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

describe("curation + audit", () => {
  it("report_correction appends an attributed candidate to corrections.jsonl", async () => {
    const { text, isError } = await call("report_correction", {
      kind: "gotcha",
      content: "Pending orders are excluded from conversion-rate denominators",
      relates_to: "Order",
    });
    expect(isError).toBe(false);
    expect(text).toContain("e2e@test");
    const file = path.join(tmpRepo, ".setoku", "corrections.jsonl");
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].user).toBe("e2e@test");
    expect(lines[0].kind).toBe("gotcha");
    expect(lines[0].relatesTo).toBe("Order");
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

  it("every call (including rejected writes) is in the audit log", async () => {
    const auditDir = path.join(tmpRepo, ".setoku", "audit");
    const files = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);
    const records = fs
      .readFileSync(path.join(auditDir, files[0]), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(records.every((r) => r.user === "e2e@test")).toBe(true);
    const tools = new Set(records.map((r) => r.tool));
    for (const t of [
      "find_context",
      "get_schema",
      "run_query",
      "report_correction",
    ]) {
      expect(tools.has(t)).toBe(true);
    }
    const rejected = records.find(
      (r) =>
        r.tool === "run_query" && r.ok === false && /INSERT/i.test(r.sql ?? ""),
    );
    expect(rejected).toBeTruthy();
    // audit dir is kept out of git
    expect(
      fs.readFileSync(path.join(auditDir, ".gitignore"), "utf8"),
    ).toContain("*");
  });
});
