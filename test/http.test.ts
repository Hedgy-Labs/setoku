/**
 * e2e for the deployed (HTTP) profile: spawn the actual http.ts entry, connect
 * with the SDK's Streamable-HTTP client using bearer tokens, verify auth →
 * identity → audit attribution, and that knowledge + data tools work over HTTP.
 * Reuses the Postgres database created by e2e.test.ts's fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pgPkg from "pg";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { Client: PgClient } = pgPkg;

const ROOT = path.resolve(import.meta.dir, "..");
const HTTP_SERVER = path.join(ROOT, "plugin", "gateway", "http.ts");
const FIXTURES = path.join(ROOT, "test", "fixtures");

const PG_HOST = process.env.SETOKU_E2E_PG_HOST ?? "/tmp";
const DB_NAME = "setoku_e2e_http";
const DB_URL =
  process.env.SETOKU_E2E_HTTP_DB_URL ??
  `postgresql:///${DB_NAME}?host=${encodeURIComponent(PG_HOST)}`;
const PORT = 38719;
const BASE = `http://127.0.0.1:${PORT}`;

let tmpRepo: string;
let proc: Subprocess;

function clientFor(token: string | null): McpClient {
  const client = new McpClient({ name: "http-e2e", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  // connect() is awaited by callers
  (
    client as unknown as { __transport: StreamableHTTPClientTransport }
  ).__transport = transport;
  return client;
}

async function connect(token: string | null): Promise<McpClient> {
  const client = clientFor(token);
  const transport = (
    client as unknown as { __transport: StreamableHTTPClientTransport }
  ).__transport;
  await client.connect(transport);
  return client;
}

async function call(
  client: McpClient,
  name: string,
  args: Record<string, unknown> = {},
) {
  const res = (await client.callTool({ name, arguments: args })) as unknown as {
    content: { text: string }[];
    isError?: boolean;
  };
  return {
    text: (res.content ?? []).map((c) => c.text).join("\n"),
    isError: !!res.isError,
  };
}

beforeAll(async () => {
  // database
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

  // project dir with config + seed context
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-http-"));
  fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), {
    recursive: true,
  });

  // spawn the HTTP gateway exactly as a container would run it
  proc = spawn({
    cmd: ["bun", HTTP_SERVER],
    env: {
      ...(process.env as Record<string, string>),
      SETOKU_PROJECT_DIR: tmpRepo,
      SETOKU_DB_PATH: path.join(tmpRepo, "knowledge.db"),
      SETOKU_E2E_DB_URL: DB_URL,
      SETOKU_HTTP_PORT: String(PORT),
      SETOKU_TOKENS: "tok-alice=alice@co.test,tok-bob=bob@co.test",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  // wait for /health
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("http gateway did not become healthy");
}, 30_000);

afterAll(async () => {
  proc?.kill();
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe("auth", () => {
  it("rejects missing token", async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(401);
  });

  it("rejects a bogus token", async () => {
    expect(connect("tok-evil")).rejects.toThrow();
  });
});

describe("tools over HTTP", () => {
  it("serves knowledge + data with a valid token", async () => {
    const alice = await connect("tok-alice");
    const { tools } = await alice.listTools();
    expect(tools.map((t) => t.name)).toContain("find_context");
    const fc = await call(alice, "find_context", {
      question: "how much revenue last month?",
    });
    expect(fc.text).toContain("Refunded orders must be excluded");
    const rq = await call(alice, "run_query", {
      sql: "SELECT SUM(total_cents)/100.0 AS rev FROM orders WHERE status='paid'",
      purpose: "http e2e",
    });
    expect(rq.isError).toBe(false);
    expect(rq.text).toContain("225");
    await alice.close();
  });

  it("attributes each token's calls to its own identity in the shared audit log", async () => {
    const bob = await connect("tok-bob");
    await call(bob, "report_correction", {
      kind: "gotcha",
      content:
        "Gift-card orders have total_cents = 0 and are excluded from AOV",
    });
    await bob.close();

    const { Database } = await import("bun:sqlite");
    const db = new Database(path.join(tmpRepo, "knowledge.db"), {
      readonly: true,
    });
    const users = (
      db.query("SELECT DISTINCT user FROM audit ORDER BY user").all() as {
        user: string;
      }[]
    ).map((r) => r.user);
    const bobCorrection = db
      .query("SELECT user FROM corrections WHERE content LIKE '%Gift-card%'")
      .get() as { user: string } | null;
    db.close();
    expect(users).toContain("alice@co.test");
    expect(users).toContain("bob@co.test");
    expect(bobCorrection?.user).toBe("bob@co.test");
  });

  it("bob sees alice-era knowledge instantly (one shared store)", async () => {
    const alice = await connect("tok-alice");
    await call(alice, "upsert_context", {
      type: "gotcha",
      name: "http-shared",
      body: "Wholesale orders are tagged via order_items.sku prefix WS- and excluded from retail metrics",
    });
    await alice.close();
    const bob = await connect("tok-bob");
    const fc = await call(bob, "find_context", {
      question: "do retail metrics include wholesale orders?",
    });
    expect(fc.text).toContain("WS-");
    await bob.close();
  });
});
