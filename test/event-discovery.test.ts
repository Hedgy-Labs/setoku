// SPDX-License-Identifier: Apache-2.0
/**
 * Event discovery over the real tool surface: the derived catalog in the
 * capability tools, and find_context's coverage check pointing at it.
 *
 * The failure this pins: an agent asks about a product event, the knowledge
 * store has nothing, and every discovery tool describes the events table as a
 * category with an opaque JSON column — so the agent concludes the data isn't
 * there while it sits one GROUP BY away. Spawns the deployed entry (http.ts)
 * against a fake lake, like the other HTTP suites.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  spawnGateway,
  waitHealthy,
  connect as gwConnect,
  call,
  FIXTURES,
} from "./lib/gateway";
import { startFakeLake, innerSql, type FakeLake } from "./lib/fakelake";

const PORT = 38777;
const BASE = `http://127.0.0.1:${PORT}`;

let tmpRepo: string;
let proc: Subprocess;
let lake: FakeLake;

const connect = (token: string) => gwConnect(BASE, token, "event-discovery");

beforeAll(async () => {
  lake = startFakeLake((sql) => {
    const q = innerSql(sql);
    if (q.includes("JSONExtractKeys"))
      return {
        rows: [
          {
            name: "page_viewed",
            n: 38,
            first_ts: "2026-07-01 10:00:00.000",
            last_ts: "2026-07-02 11:00:00.000",
            actors: 5,
            keys: ["admin", "path", "route"],
          },
          {
            name: "order_placed",
            n: 4,
            first_ts: "2026-07-01 12:00:00.000",
            last_ts: "2026-07-01 12:30:00.000",
            actors: 2,
            keys: ["order_id"],
          },
        ],
      };
    if (q.startsWith("SHOW TABLES")) return { rows: [{ name: "app_events" }] };
    if (q.includes("system.columns"))
      return {
        rows: [
          {
            database: "setoku",
            table: "app_events",
            name: "ts",
            type: "DateTime64(3)",
          },
          {
            database: "setoku",
            table: "app_events",
            name: "event_name",
            type: "String",
          },
          {
            database: "setoku",
            table: "app_events",
            name: "actor",
            type: "String",
          },
          {
            database: "setoku",
            table: "app_events",
            name: "properties",
            type: "String",
          },
          { database: "biz", table: "orders", name: "id", type: "Int64" },
          {
            database: "biz",
            table: "orders",
            name: "total_cents",
            type: "Int64",
          },
        ],
      };
    if (q.includes("count()")) return { rows: [{ n: 42 }] };
    return { rows: [] };
  });

  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-events-"));
  fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), {
    recursive: true,
  });
  proc = spawnGateway({
    SETOKU_PROJECT_DIR: tmpRepo,
    SETOKU_DB_PATH: path.join(tmpRepo, "knowledge.db"),
    SETOKU_LAKE_URL: lake.url,
    SETOKU_HTTP_PORT: String(PORT),
    SETOKU_TOKENS: "tok-analyst=analyst@co.test",
    SETOKU_CURATOR_TOKENS: "tok-curator=curator@co.test",
  });
  await waitHealthy(BASE);
}, 30_000);

afterAll(async () => {
  proc?.kill();
  lake?.stop();
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe("derived event catalog", () => {
  it("get_schema names the events actually emitted, not just `properties String`", async () => {
    const c = await connect("tok-analyst");
    const r = await call(c, "get_schema", { tables: ["app_events"] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("properties: String");
    expect(r.text).toContain("event_name values");
    expect(r.text).toContain("- page_viewed — 38 events, 5 actors");
    expect(r.text).toContain("properties: admin, path, route");
    expect(r.text).toContain("- order_placed");
    // the keys are a sample of recent rows — never claim they're the full set
    expect(r.text).toContain("sampled, not exhaustive");
    await c.close();
  });

  it("list_sources advertises the vocabulary, not just the category", async () => {
    const c = await connect("tok-analyst");
    const r = await call(c, "list_sources");
    expect(r.isError).toBe(false);
    expect(r.text).toContain("setoku.app_events");
    expect(r.text).toContain("emits page_viewed (admin, path, route)");
    expect(r.text).toContain("2 event kinds, 42 events");
    await c.close();
  });
});

describe("find_context coverage check", () => {
  it("flags the term nothing curated covers and points at where it lives", async () => {
    const c = await connect("tok-analyst");
    const r = await call(c, "find_context", { question: "any pageviews yet?" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Coverage check");
    expect(r.text).toContain("No curated context mentions: pageviews");
    // undocumented is not absent — the pointer is the whole point
    expect(r.text).toContain("undocumented is not absent");
    expect(r.text).toContain("setoku.app_events event_name='page_viewed'");
    await c.close();
  });

  it("stays silent on a question the store actually covers", async () => {
    const c = await connect("tok-analyst");
    const r = await call(c, "find_context", {
      question: "how much revenue did we make last month?",
    });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("Coverage check");
    await c.close();
  });

  it("a curator gets the coverage line but no lake-derived pointer (I2/I9)", async () => {
    const c = await connect("tok-curator");
    const r = await call(c, "find_context", { question: "any pageviews yet?" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("No curated context mentions: pageviews");
    // the membrane holds: a write-capable session never reads the lake
    expect(r.text).not.toContain("setoku.app_events");
    expect(r.text).toContain("Confirm against get_schema");
    await c.close();
  });
});
