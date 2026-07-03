// SPDX-License-Identifier: Apache-2.0
/**
 * pg-mirror tests: allow/deny glob semantics, the explicit type map (unmapped
 * types fail loudly), and a full tick against a real throwaway Postgres with a
 * FAKE ClickHouse (loopback Bun.serve, no real lake — same pattern as the
 * slack-listener tests). The fake records every query so the staging→verify→
 * EXCHANGE→DROP sequence and the heartbeat are asserted, not assumed.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import pgPkg from "pg";
import { tableAllowed, chType, encodeValue, mirrorName, tick, type ClickHouseOptions } from "./mirror";

const { Client: PgClient } = pgPkg;
const PG_HOST = process.env.SETOKU_E2E_PG_HOST ?? "/tmp";
const DB_NAME = "setoku_pg_mirror_test";

describe("tableAllowed — same glob semantics as .setoku allowTables", () => {
  it("allows within-segment globs, deny wins, bare names default to public", () => {
    expect(tableAllowed("public.orders", ["public.*"], [])).toBe(true);
    expect(tableAllowed("orders", ["public.*"], [])).toBe(true);
    expect(tableAllowed("ticketing.seat_txn", ["public.*"], [])).toBe(false);
    expect(tableAllowed("ticketing.seat_txn", ["ticketing.*"], [])).toBe(true);
    expect(tableAllowed("public.users", ["public.*"], ["public.users"])).toBe(false);
    // `*` must not cross the schema.table dot
    expect(tableAllowed("secret.thing", ["*"], [])).toBe(false);
  });
});

describe("chType — explicit map, loud failure", () => {
  const col = (dataType: string, nullable = false) => ({ name: "c", dataType, nullable });
  it("maps the supported types", () => {
    expect(chType(col("integer"), { inKey: false })).toBe("Int32");
    expect(chType(col("bigint"), { inKey: false })).toBe("Int64");
    expect(chType(col("numeric"), { inKey: false })).toBe("Float64");
    expect(chType(col("timestamp with time zone"), { inKey: false })).toBe("DateTime64(3)");
    expect(chType(col("uuid"), { inKey: false })).toBe("UUID");
    expect(chType(col("jsonb"), { inKey: false })).toBe("String");
  });
  it("wraps nullable columns except in the ORDER BY key", () => {
    expect(chType(col("text", true), { inKey: false })).toBe("Nullable(String)");
    expect(chType(col("text", true), { inKey: true })).toBe("String");
  });
  it("throws on an unmapped type instead of coercing", () => {
    expect(() => chType(col("bytea"), { inKey: false })).toThrow(/unmapped/);
  });
});

describe("encodeValue — JSONEachRow encoding", () => {
  it("formats timestamps as UTC DateTime64 text and dates as YYYY-MM-DD", () => {
    const d = new Date("2026-07-03T12:34:56.789Z");
    expect(encodeValue(d, "timestamp with time zone")).toBe("2026-07-03 12:34:56.789");
    expect(encodeValue(d, "date")).toBe("2026-07-03");
  });
  it("stringifies json/array values and passes null through", () => {
    expect(encodeValue({ a: 1 }, "jsonb")).toBe('{"a":1}');
    expect(encodeValue([1, 2], "ARRAY")).toBe("[1,2]");
    expect(encodeValue(null, "text")).toBeNull();
  });
});

describe("mirrorName", () => {
  it("prefixes biz_ and schema-qualifies outside public", () => {
    expect(mirrorName({ schema: "public", table: "orders" })).toBe("biz_orders");
    expect(mirrorName({ schema: "ticketing", table: "seat_txn" })).toBe("biz_ticketing_seat_txn");
  });
});

/** Loopback fake ClickHouse: 200s everything, records queries, counts inserted
 *  NDJSON lines per table, and answers `SELECT count()` from those counts. */
function fakeClickHouse() {
  const queries: string[] = [];
  const beats: string[] = []; // heartbeat NDJSON bodies (the detail line)
  const inserted = new Map<string, number>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const query = url.searchParams.get("query") ?? body;
      queries.push(query);
      const ins = query.match(/^INSERT INTO \S+\.`?([\w]+)`?/);
      if (ins && url.searchParams.get("query")) {
        if (ins[1] === "ingest_heartbeats") beats.push(body);
        const lines = body.split("\n").filter(Boolean).length;
        inserted.set(ins[1], (inserted.get(ins[1]) ?? 0) + lines);
        return new Response("");
      }
      const cnt = query.match(/^SELECT count\(\) AS c FROM \S+\.`?([\w]+)`?/);
      if (cnt) return Response.json({ data: [{ c: String(inserted.get(cnt[1]) ?? 0) }] });
      return new Response("");
    },
  });
  return {
    queries,
    beats,
    inserted,
    ch: { url: `http://127.0.0.1:${server.port}`, user: "setoku", password: "x", db: "setoku" } as ClickHouseOptions,
    stop: () => server.stop(true),
  };
}

describe("tick — full reload against a real throwaway Postgres", () => {
  let sql: SQL;

  beforeAll(async () => {
    const admin = new PgClient({ host: PG_HOST, database: process.env.SETOKU_E2E_PG_MAINTENANCE_DB ?? "template1" });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
    const db = new PgClient({ host: PG_HOST, database: DB_NAME });
    await db.connect();
    await db.query(`CREATE TABLE orders (
      id bigint PRIMARY KEY, customer text, total numeric(10,2), paid boolean,
      placed_at timestamptz, ship_by date, meta jsonb, note text
    )`);
    for (let i = 1; i <= 5; i++)
      await db.query(
        `INSERT INTO orders VALUES ($1, $2, $3, $4, now(), current_date, '{"k":1}', $5)`,
        [i, `cust-${i}`, i * 10.5, i % 2 === 0, i === 3 ? null : `note ${i}`],
      );
    await db.query("CREATE TABLE no_pk (label text)");
    await db.query("INSERT INTO no_pk VALUES ('a'), ('b')");
    await db.query("CREATE TABLE secrets (id int PRIMARY KEY, ssn text)");
    await db.query("INSERT INTO secrets VALUES (1, 'nope')");
    await db.end();
    sql = new SQL({ path: `${PG_HOST}/.s.PGSQL.5432`, database: DB_NAME });
  });

  afterAll(async () => {
    await sql?.end().catch(() => {});
  });

  it("mirrors allowed tables in keyset batches, swaps atomically, skips denied, beats", async () => {
    const fake = fakeClickHouse();
    try {
      const r = await tick(sql, {
        ch: fake.ch,
        allow: ["public.*"],
        deny: ["public.secrets"],
        batchRows: 2, // force multiple keyset pages over the 5-row table
      });
      expect(r.failed).toEqual([]);
      expect(r.mirrored).toContainEqual({ table: "biz_orders", rows: 5 });
      expect(r.mirrored).toContainEqual({ table: "biz_no_pk", rows: 2 });
      // The denied table never left Postgres — no query mentions it.
      expect(fake.queries.some((q) => q.includes("secrets"))).toBe(false);

      // Staging DDL derived from the pg catalog, with the freshness column.
      const ddl = fake.queries.find((q) => q.includes("CREATE TABLE setoku.`biz_orders__staging`"))!;
      expect(ddl).toContain("`id` Int64");
      expect(ddl).toContain("`total` Nullable(Float64)");
      expect(ddl).toContain("`placed_at` Nullable(DateTime64(3))");
      expect(ddl).toContain("`meta` Nullable(String)");
      expect(ddl).toContain("`_mirrored_at` DateTime64(3) DEFAULT now64(3)");
      expect(ddl).toContain("ORDER BY (`id`)");

      // Verify-then-swap sequence, in order: count staging, create-if-missing
      // target, EXCHANGE, drop staging.
      const seq = fake.queries.filter((q) => /biz_orders/.test(q)).map((q) => q.split(" ").slice(0, 2).join(" "));
      const exchangeIdx = fake.queries.findIndex((q) => q.startsWith("EXCHANGE TABLES setoku.`biz_orders`"));
      const countIdx = fake.queries.findIndex((q) => q.startsWith("SELECT count() AS c FROM setoku.`biz_orders__staging`"));
      const dropIdx = fake.queries.findIndex((q, i) => i > exchangeIdx && q.startsWith("DROP TABLE IF EXISTS setoku.`biz_orders__staging`"));
      expect(countIdx).toBeGreaterThan(-1);
      expect(exchangeIdx).toBeGreaterThan(countIdx);
      expect(dropIdx).toBeGreaterThan(exchangeIdx);
      expect(seq.length).toBeGreaterThan(0);

      // 5 rows over batchRows=2 → 3 insert batches, all landed in staging.
      const orderInserts = fake.queries.filter((q) => q.startsWith("INSERT INTO setoku.`biz_orders__staging`"));
      expect(orderInserts.length).toBe(3);
      expect(fake.inserted.get("biz_orders__staging")).toBe(5);

      // Liveness beat with the run summary.
      expect(fake.beats.length).toBe(1);
      expect(fake.beats[0]).toContain("mirrored 2/2 table(s), 7 row(s)");
    } finally {
      fake.stop();
    }
  });

  it("fails loudly per table without wedging the run (no-PK cap)", async () => {
    const fake = fakeClickHouse();
    try {
      const r = await tick(sql, { ch: fake.ch, allow: ["public.no_pk", "public.orders"], deny: [], noPkRowCap: 1 });
      expect(r.mirrored).toContainEqual({ table: "biz_orders", rows: 5 });
      expect(r.failed.length).toBe(1);
      expect(r.failed[0].table).toBe("public.no_pk");
      expect(r.failed[0].error).toContain("no primary key");
      // The failure is visible in the heartbeat detail, not swallowed.
      expect(fake.beats.length).toBe(1);
      expect(fake.beats[0]).toContain("FAILED");
      expect(fake.beats[0]).toContain("no_pk");
    } finally {
      fake.stop();
    }
  });
});
