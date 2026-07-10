// SPDX-License-Identifier: Apache-2.0
/**
 * pg-mirror tests.
 *
 * 1. Pure units (type map, DDL, serialization, allowlist) — no services.
 * 2. Integration: a REAL local Postgres (the fast suite already requires one —
 *    same socket convention as test/e2e.test.ts) streamed into a FakeClickHouse
 *    that models the DDL/insert/swap surface the mirror drives.
 * 3. Full end-to-end against a REAL ClickHouse, gated on SETOKU_E2E_CH_URL
 *    (same gate as test/lake.test.ts) — this is where the fiddly input-format
 *    semantics (Decimal-from-string, best_effort timestamps, arrays, EXCHANGE)
 *    are proven against the actual engine.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  tableMatches,
  isTableAllowed,
  isColumnDenied,
  loadMirrorConfig,
  schemaSignature,
  fetchChangeCounters,
  mapColumn,
  numericTypmod,
  bizTableName,
  chIdent,
  stagingDDL,
  buildSelect,
  serializeRow,
  pgOptions,
  discoverTables,
  runOnce,
  ensureMirrorObjects,
  type ChOptions,
  type MirrorColumn,
} from "./mirror";

/** Pack a pg numeric typmod the way the catalog stores it. */
const tm = (p: number, s: number): number => ((p << 16) | (s & 0x7ff)) + 4;

/* ------------------------------ units ------------------------------- */

describe("allowlist semantics (parity with gateway lib/config.ts)", () => {
  it("glob * stays within one dot-segment", () => {
    expect(tableMatches("public.*", "public.orders")).toBe(true);
    expect(tableMatches("public.*", "crm.orders")).toBe(false);
    expect(tableMatches("*.orders", "crm.orders")).toBe(true);
    expect(tableMatches("public.*", "public.a.b")).toBe(false);
  });
  it("deny wins over allow", () => {
    const cfg = { allowTables: ["public.*"], denyTables: ["public.internal_notes"], denyColumns: [] };
    expect(isTableAllowed(cfg, "public", "orders")).toBe(true);
    expect(isTableAllowed(cfg, "public", "internal_notes")).toBe(false);
    expect(isTableAllowed(cfg, "ticketing", "seat_txn")).toBe(false);
  });
  it("denyColumns matches schema.table.column with the same glob semantics", () => {
    const cfg = { allowTables: ["public.*"], denyTables: [], denyColumns: ["public.orders.blob", "public.*.raw_html"] };
    expect(isColumnDenied(cfg, "public", "orders", "blob")).toBe(true);
    expect(isColumnDenied(cfg, "public", "orders", "note")).toBe(false);
    expect(isColumnDenied(cfg, "public", "scrapes", "raw_html")).toBe(true);
    expect(isColumnDenied(cfg, "crm", "scrapes", "raw_html")).toBe(false); // * stays within a segment
  });
});

const col = (over: Partial<Parameters<typeof mapColumn>[0]>): Parameters<typeof mapColumn>[0] => ({
  column_name: "c",
  udt_name: "text",
  typtype: "b",
  elem_udt: null,
  elem_typtype: null,
  not_null: false,
  atttypmod: null,
  ...over,
});

describe("loadMirrorConfig fails closed (I2 — never mirror with an unknown list)", () => {
  it("throws on missing and on corrupt config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-mirror-cfg-"));
    expect(() => loadMirrorConfig(dir)).toThrow(/refusing to mirror/);
    fs.mkdirSync(path.join(dir, ".setoku"));
    fs.writeFileSync(path.join(dir, ".setoku", "config.json"), "{not json");
    expect(() => loadMirrorConfig(dir)).toThrow(/refusing to mirror/);
    fs.writeFileSync(path.join(dir, ".setoku", "config.json"), JSON.stringify({ denyTables: ["public.x"] }));
    expect(loadMirrorConfig(dir)).toEqual({ allowTables: ["public.*"], denyTables: ["public.x"], denyColumns: [] });
  });
  it("SETOKU_MIRROR_DENY_COLUMNS merges into (never replaces) the config's denyColumns", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-mirror-cfg-"));
    fs.mkdirSync(path.join(dir, ".setoku"));
    fs.writeFileSync(path.join(dir, ".setoku", "config.json"), JSON.stringify({ denyColumns: ["public.a.b"] }));
    const prev = process.env.SETOKU_MIRROR_DENY_COLUMNS;
    process.env.SETOKU_MIRROR_DENY_COLUMNS = " public.c.d ,,public.e.f ";
    try {
      expect(loadMirrorConfig(dir).denyColumns).toEqual(["public.a.b", "public.c.d", "public.e.f"]);
    } finally {
      if (prev === undefined) delete process.env.SETOKU_MIRROR_DENY_COLUMNS;
      else process.env.SETOKU_MIRROR_DENY_COLUMNS = prev;
    }
  });
});

describe("type mapping", () => {
  it("maps scalars with nullability", () => {
    expect(mapColumn(col({ udt_name: "int8", not_null: true })).chType).toBe("Int64");
    expect(mapColumn(col({ udt_name: "int4" })).chType).toBe("Nullable(Int32)");
    expect(mapColumn(col({ udt_name: "timestamptz", not_null: true })).chType).toBe("DateTime64(6, 'UTC')");
    expect(mapColumn(col({ udt_name: "jsonb" })).kind).toBe("json");
    expect(mapColumn(col({ udt_name: "uuid", not_null: true })).chType).toBe("UUID");
  });
  it("numeric: declared precision carries; bare numeric gets Decimal(38,9)", () => {
    expect(mapColumn(col({ udt_name: "numeric", atttypmod: tm(10, 2), not_null: true })).chType).toBe("Decimal(10, 2)");
    expect(mapColumn(col({ udt_name: "numeric", not_null: true })).chType).toBe("Decimal(38, 9)");
  });
  it("numeric typmod decodes signed scale and clamps to valid ClickHouse Decimals", () => {
    expect(numericTypmod(tm(10, 2))).toEqual({ precision: 10, scale: 2 });
    expect(numericTypmod(tm(5, -2))).toEqual({ precision: 5, scale: -2 }); // pg ≥ 15 negative scale
    expect(numericTypmod(null)).toEqual({ precision: null, scale: 0 });
    // negative scale → integer-digit capacity, scale 0
    expect(mapColumn(col({ udt_name: "numeric", atttypmod: tm(5, -2), not_null: true })).chType).toBe("Decimal(7, 0)");
    // pg ≥ 15 scale > precision → widen precision to the scale
    expect(mapColumn(col({ udt_name: "numeric", atttypmod: tm(3, 5), not_null: true })).chType).toBe("Decimal(5, 5)");
    // beyond ClickHouse's Decimal range → loud failure, not invalid DDL
    expect(() => mapColumn(col({ udt_name: "numeric", atttypmod: tm(100, 50) }))).toThrow(/exceeds ClickHouse Decimal precision/);
  });
  it("pg enums become LowCardinality(String)", () => {
    expect(mapColumn(col({ udt_name: "order_status", typtype: "e", not_null: true })).chType).toBe("LowCardinality(String)");
  });
  it("NULLABLE enums nest Nullable inside LowCardinality (ClickHouse rejects the inverse)", () => {
    // hit on the hedgy pilot: Prisma optional enums → Nullable(LowCardinality(…)) is ILLEGAL_TYPE_OF_ARGUMENT
    expect(mapColumn(col({ udt_name: "order_status", typtype: "e" })).chType).toBe("LowCardinality(Nullable(String))");
  });
  it("arrays wrap the element and are never Nullable", () => {
    const a = mapColumn(col({ udt_name: "_int4", elem_udt: "int4", elem_typtype: "b" }));
    expect(a.chType).toBe("Array(Int32)");
    expect(a.isArray).toBe(true);
  });
  it("unmapped types throw loudly (never guess)", () => {
    expect(() => mapColumn(col({ udt_name: "interval" }))).toThrow(/unmapped Postgres type "interval"/);
  });
});

describe("naming / DDL / select", () => {
  it("biz names drop the public schema, prefix others", () => {
    expect(bizTableName("public", "orders")).toBe("orders");
    expect(bizTableName("ticketing", "seat_txn")).toBe("ticketing_seat_txn");
  });
  it("stagingDDL orders by the pg primary key, tuple() without one", () => {
    const cols: MirrorColumn[] = [
      mapColumn(col({ column_name: "id", udt_name: "int8", not_null: true })),
      mapColumn(col({ column_name: "note", udt_name: "text" })),
    ];
    const t = { schema: "public", name: "orders", columns: cols, pk: ["id"] };
    const ddl = stagingDDL("biz", "orders__staging", t);
    expect(ddl).toContain("CREATE TABLE `biz`.`orders__staging`");
    expect(ddl).toContain("ORDER BY (`id`)");
    expect(ddl).toContain("ENGINE = MergeTree");
    expect(ddl).toContain("`_mirrored_at` DateTime64(3) DEFAULT now64(3)"); // per-row "data as of"
    expect(stagingDDL("biz", "x", { ...t, pk: [] })).toContain("ORDER BY tuple()");
    // a source column named _mirrored_at wins — no duplicate column in the DDL
    const clash = { ...t, columns: [...cols, mapColumn(col({ column_name: "_mirrored_at", udt_name: "timestamptz" }))] };
    expect(stagingDDL("biz", "y", clash).match(/_mirrored_at/g)!.length).toBe(1);
  });
  it("buildSelect casts timestamps/dates to pg text (driver-timezone-proof)", () => {
    const t = {
      schema: "public",
      name: "orders",
      pk: [],
      columns: [
        mapColumn(col({ column_name: "id", udt_name: "int8", not_null: true })),
        mapColumn(col({ column_name: "placed_at", udt_name: "timestamptz" })),
        mapColumn(col({ column_name: "statuses", udt_name: "_order_status", elem_udt: "order_status", elem_typtype: "e" })),
      ],
    };
    const sel = buildSelect(t);
    expect(sel).toContain(`"placed_at"::text AS "placed_at"`);
    expect(sel).toContain(`"statuses"::text[] AS "statuses"`);
    expect(sel).toContain(`FROM "public"."orders"`);
  });
  it("chIdent escapes backticks", () => {
    expect(chIdent("we`ird")).toBe("`we\\`ird`");
  });
});

describe("row serialization", () => {
  const columns: MirrorColumn[] = [
    mapColumn(col({ column_name: "id", udt_name: "int8", not_null: true })),
    mapColumn(col({ column_name: "meta", udt_name: "jsonb" })),
    mapColumn(col({ column_name: "tags", udt_name: "_text", elem_udt: "text", elem_typtype: "b" })),
    mapColumn(col({ column_name: "blob", udt_name: "bytea" })),
    mapColumn(col({ column_name: "amount", udt_name: "numeric", atttypmod: tm(10, 2) })),
    mapColumn(col({ column_name: "ratio", udt_name: "float8" })),
  ];
  it("serializes bigint→string, jsonb→string, null array→[], bytea→pg hex", () => {
    const line = serializeRow(
      { id: 9223372036854775807n, meta: { a: 1 }, tags: null, blob: new Uint8Array([0xde, 0xad]), amount: "12.34" },
      columns,
    );
    const parsed = JSON.parse(line);
    expect(parsed.id).toBe("9223372036854775807");
    expect(parsed.meta).toBe('{"a":1}');
    expect(parsed.tags).toEqual([]);
    expect(parsed.blob).toBe("\\xdead");
    expect(parsed.amount).toBe("12.34");
    expect(line.endsWith("\n")).toBe(true);
  });
  it("passes nulls through for nullable scalars", () => {
    const parsed = JSON.parse(serializeRow({ id: 1, meta: null, tags: [], blob: null, amount: null, ratio: null }, columns));
    expect(parsed.meta).toBeNull();
    expect(parsed.amount).toBeNull();
  });
  it("float NaN/±Infinity become ClickHouse-parseable strings, never JSON null", () => {
    const p1 = JSON.parse(serializeRow({ id: 1, ratio: NaN }, columns));
    const p2 = JSON.parse(serializeRow({ id: 1, ratio: Infinity }, columns));
    const p3 = JSON.parse(serializeRow({ id: 1, ratio: -Infinity }, columns));
    expect(p1.ratio).toBe("nan");
    expect(p2.ratio).toBe("inf");
    expect(p3.ratio).toBe("-inf");
  });
});

describe("pgOptions", () => {
  it("libpq socket-dir host param becomes a unix socket path", () => {
    const o = pgOptions("postgresql:///mydb?host=/tmp");
    expect(o.path).toBe("/tmp/.s.PGSQL.5432");
    expect(o.database).toBe("mydb");
  });
  it("hostname host param is a TCP host", () => {
    const o = pgOptions("postgresql:///mydb?host=db.example.com");
    expect(o.hostname).toBe("db.example.com");
  });
  it("remote hosts get TLS, local/compose hosts don't", () => {
    expect(pgOptions("postgres://u:p@db.example.com:5432/d").tls).toBeTruthy();
    expect(pgOptions("postgres://u:p@localhost:5432/d").tls).toBeUndefined();
    expect(pgOptions("postgres://u:p@postgres:5432/d").tls).toBeUndefined();
    expect(pgOptions("postgres://u:p@db.example.com/d?sslmode=disable").tls).toBeUndefined();
  });
});

/* --------------------- FakeClickHouse (unit-level) --------------------- */

/** Models exactly the surface the mirror drives: DDL (CREATE/DROP/EXCHANGE/
 *  RENAME), JSONEachRow inserts, count()/system.tables selects. */
class FakeClickHouse {
  server: ReturnType<typeof Bun.serve>;
  tables = new Map<string, Record<string, unknown>[]>(); // "db.name" → rows
  queries: string[] = [];
  heartbeats: Record<string, unknown>[] = [];
  runs: Record<string, unknown>[] = [];
  state: Record<string, unknown>[] = []; // pg_mirror_state, insert order
  failInserts = false;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = await req.text();
        const q = (url.searchParams.get("query") ?? body).trim();
        this.queries.push(q);
        return this.handle(q, url.searchParams.has("query") ? body : "");
      },
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  private key(ref: string): string {
    return ref.replace(/`/g, "");
  }

  handle(q: string, body: string): Response {
    const ok = (s = ""): Response => new Response(s, { status: 200 });
    let m: RegExpMatchArray | null;
    if ((m = q.match(/^INSERT INTO (\S+) FORMAT JSONEachRow/i))) {
      const key = this.key(m[1]);
      const rows = body.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (key.endsWith(".ingest_heartbeats")) this.heartbeats.push(...rows);
      else if (key.endsWith(".pg_mirror_runs")) this.runs.push(...rows);
      else if (key.endsWith(".pg_mirror_state")) this.state.push(...rows);
      else {
        if (this.failInserts) return new Response("boom", { status: 500 });
        if (!this.tables.has(key)) return new Response(`no such table ${key}`, { status: 404 });
        this.tables.get(key)!.push(...rows);
      }
      return ok();
    }
    if ((m = q.match(/^CREATE DATABASE IF NOT EXISTS/i))) return ok();
    if ((m = q.match(/^CREATE TABLE IF NOT EXISTS/i))) return ok();
    if ((m = q.match(/^ALTER TABLE \S+ ADD COLUMN IF NOT EXISTS/i))) return ok();
    if ((m = q.match(/^CREATE TABLE (\S+)/i))) {
      this.tables.set(this.key(m[1]), []);
      return ok();
    }
    if ((m = q.match(/^DROP TABLE IF EXISTS (\S+)/i))) {
      this.tables.delete(this.key(m[1]));
      return ok();
    }
    if ((m = q.match(/^EXCHANGE TABLES (\S+) AND (\S+)/i))) {
      const a = this.key(m[1]);
      const b = this.key(m[2]);
      if (!this.tables.has(a) || !this.tables.has(b)) return new Response("missing table", { status: 404 });
      const tmp = this.tables.get(a)!;
      this.tables.set(a, this.tables.get(b)!);
      this.tables.set(b, tmp);
      return ok();
    }
    if ((m = q.match(/^RENAME TABLE (\S+) TO (\S+)/i))) {
      const a = this.key(m[1]);
      if (!this.tables.has(a)) return new Response("missing table", { status: 404 });
      this.tables.set(this.key(m[2]), this.tables.get(a)!);
      this.tables.delete(a);
      return ok();
    }
    if ((m = q.match(/^SELECT count\(\) AS c FROM (\S+)/i))) {
      const rows = this.tables.get(this.key(m[1]));
      if (!rows) return new Response("missing table", { status: 404 });
      return ok(JSON.stringify({ data: [{ c: String(rows.length) }] }));
    }
    if ((m = q.match(/^SELECT target, signature FROM \S+\.pg_mirror_state FINAL/i))) {
      // ReplacingMergeTree(checked_at) ORDER BY target — last write per target wins
      const latest = new Map<string, Record<string, unknown>>();
      for (const r of this.state) latest.set(String(r.target), r);
      return ok(JSON.stringify({ data: [...latest.values()].map((r) => ({ target: r.target, signature: r.signature })) }));
    }
    if ((m = q.match(/^SELECT name FROM system\.tables WHERE database = '([^']*)'/i))) {
      const db = m[1];
      const names = [...this.tables.keys()].filter((k) => k.startsWith(`${db}.`)).map((k) => ({ name: k.slice(db.length + 1) }));
      return ok(JSON.stringify({ data: names }));
    }
    return new Response(`FakeClickHouse: unhandled query: ${q.slice(0, 120)}`, { status: 400 });
  }

  stop(): void {
    this.server.stop(true);
  }
}

/* --------------------- integration: real pg + fake CH --------------------- */

const PG_HOST = process.env.SETOKU_E2E_PG_HOST ?? "/tmp";
const DB_NAME = "setoku_mirror_test";
const DB_URL = process.env.SETOKU_E2E_DB_URL_MIRROR ?? `postgresql:///${DB_NAME}?host=${encodeURIComponent(PG_HOST)}`;

const SCHEMA_STATEMENTS = [
  `CREATE TYPE order_status AS ENUM ('pending', 'paid', 'refunded')`,
  `CREATE SCHEMA ticketing`,
  `CREATE TABLE public.orders (
     id bigint PRIMARY KEY,
     amount numeric(10,2) NOT NULL,
     loose numeric,
     placed_at timestamptz NOT NULL,
     day date,
     naive timestamp,
     meta jsonb,
     tags text[],
     nums int4[],
     status order_status NOT NULL DEFAULT 'pending',
     status_note order_status,
     active boolean NOT NULL DEFAULT true,
     uid uuid,
     note text,
     blob bytea,
     ratio float8
   )`,
  `CREATE TABLE ticketing.seat_txn (
     acct_id int NOT NULL,
     seq int NOT NULL,
     price_cents bigint NOT NULL,
     email text,
     PRIMARY KEY (acct_id, seq)
   )`,
  `CREATE TABLE public.no_pk (v text)`,
  `CREATE TABLE public.internal_notes (id int PRIMARY KEY, secret text)`,
  `CREATE TABLE public.has_interval (id int PRIMARY KEY, span interval)`,
  `CREATE TABLE public.evil__staging (id int PRIMARY KEY)`, // reserved-suffix guard
  `INSERT INTO public.orders (id, amount, loose, placed_at, day, naive, meta, tags, nums, status, status_note, active, uid, note, blob, ratio) VALUES
     (1, 12.34, 0.000000001, '2026-05-01T10:00:00Z', '2026-05-01', '2026-05-01 10:00:00', '{"a":1}', ARRAY['x','y''z'], ARRAY[1,2], 'paid', 'refunded', true, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'héllo — ''quoted''', '\\xdead', 'NaN'),
     (2, 0.05, NULL, '2026-05-02T00:00:00Z', NULL, NULL, NULL, NULL, NULL, 'pending', NULL, false, NULL, NULL, NULL, '-Infinity')`,
  `INSERT INTO ticketing.seat_txn SELECT g, 1, g * 100, 'fan' || g || '@example.com' FROM generate_series(1, 25000) g`,
  `INSERT INTO public.no_pk VALUES ('a'), ('b')`,
  `INSERT INTO public.internal_notes VALUES (1, 'do not mirror')`,
];

const CFG = { allowTables: ["public.*", "ticketing.*"], denyTables: ["public.internal_notes"], denyColumns: [] as string[] };

/** pg flushes pg_stat counters asynchronously (on backend idle/exit) — poll
 *  until a write becomes visible so the unchanged-skip tests can't flake. */
async function waitForCounterChange(pgc: unknown, schema: string, name: string, before: string | null): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await fetchChangeCounters(pgc as never, schema, name)) !== before) return;
    await Bun.sleep(50);
  }
  throw new Error(`pg_stat counters for ${schema}.${name} never moved`);
}

async function pgAdmin(statements: string[], database: string): Promise<void> {
  const sql = new SQL(pgOptions(`postgresql:///${database}?host=${encodeURIComponent(PG_HOST)}`) as never);
  try {
    for (const s of statements) await sql.unsafe(s);
  } finally {
    await sql.end();
  }
}

let pg: SQL;
let fake: FakeClickHouse;
let ch: ChOptions;

describe("mirror integration (real Postgres → FakeClickHouse)", () => {
  beforeAll(async () => {
    const maint = process.env.SETOKU_E2E_PG_MAINTENANCE_DB ?? "template1";
    await pgAdmin([`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`, `CREATE DATABASE ${DB_NAME}`], maint);
    await pgAdmin(SCHEMA_STATEMENTS, DB_NAME);
    pg = new SQL(pgOptions(DB_URL) as never);
    fake = new FakeClickHouse();
    ch = { url: fake.url, user: "setoku", password: "pw", db: "setoku", mirrorDb: "biz" };
  });
  afterAll(async () => {
    await pg?.end();
    fake?.stop();
  });

  it("discovers allowlisted tables with columns and PKs; denied and unmapped fail cleanly", async () => {
    const { tables, failed } = await discoverTables(pg as never, CFG);
    const names = tables.map((t) => `${t.schema}.${t.name}`).sort();
    expect(names).toEqual(["public.no_pk", "public.orders", "ticketing.seat_txn"]);
    expect(names).not.toContain("public.internal_notes");
    const orders = tables.find((t) => t.name === "orders")!;
    expect(orders.pk).toEqual(["id"]);
    const seat = tables.find((t) => t.name === "seat_txn")!;
    expect(seat.pk).toEqual(["acct_id", "seq"]);
    expect(failed.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { schema: "public", name: "evil__staging", error: expect.stringContaining('reserved "__staging" suffix') },
      { schema: "public", name: "has_interval", error: expect.stringContaining('unmapped Postgres type "interval"') },
    ]);
  });

  it("full run: stages, streams, verifies, swaps, records runs, beats", async () => {
    await ensureMirrorObjects(ch);
    const r = await runOnce(pg as never, ch, CFG);
    expect(r.ok).toBe(3);
    expect(r.failed).toBe(2); // has_interval (unmapped) + evil__staging (reserved suffix)
    expect(r.rows).toBe(2 + 25000 + 2);

    // rows landed under the biz names, staging cleaned up
    expect([...fake.tables.keys()].sort()).toEqual(["biz.no_pk", "biz.orders", "biz.ticketing_seat_txn"]);
    expect(fake.tables.get("biz.ticketing_seat_txn")!.length).toBe(25000);

    // serialized values survive the trip
    const [o1, o2] = fake.tables.get("biz.orders")!;
    expect(o1.amount).toBe("12.34");
    expect(String(o1.placed_at)).toMatch(/^\d{4}-\d{2}-\d{2} /); // pg text, offset included
    expect(o1.meta).toBe('{"a":1}');
    expect(o1.tags).toEqual(["x", "y'z"]);
    expect(o1.status).toBe("paid");
    expect(o1.active).toBe(true);
    expect(o1.blob).toBe("\\xdead");
    expect(o1.ratio).toBe("NaN"); // floats stream as pg text — specials survive the driver
    expect(o2.ratio).toBe("-Infinity");
    expect(o2.meta).toBeNull();
    expect(o2.tags).toEqual([]);

    // run records: one per attempted table, error rows for the unmirrorable ones
    expect(fake.runs.length).toBe(5);
    const errs = fake.runs.filter((r2) => r2.status === "error").map((r2) => r2.target_table).sort();
    expect(errs).toEqual(["evil__staging", "has_interval"]);
    const okRun = fake.runs.find((r2) => r2.target_table === "ticketing_seat_txn")!;
    expect(okRun.rows).toBe(25000);
    expect(okRun.source_table).toBe("ticketing.seat_txn");
    // the egress ledger: streamed NDJSON bytes land on the run record
    expect(Number(okRun.bytes)).toBeGreaterThan(25000 * 30); // 25k rows of several fields each
    expect(r.bytes).toBeGreaterThan(0);
  });

  it("second run reloads only what changed (EXCHANGE swap), skips the rest as unchanged", async () => {
    const before = await fetchChangeCounters(pg as never, "public", "no_pk");
    await pgAdmin([`INSERT INTO public.no_pk VALUES ('c')`], DB_NAME);
    await waitForCounterChange(pg, "public", "no_pk", before);
    fake.queries.length = 0;
    fake.runs.length = 0;
    const r = await runOnce(pg as never, ch, CFG);
    // no_pk changed → restreamed via EXCHANGE; orders and seat_txn are
    // verifiably unchanged → no restream (the egress point of the skip)
    expect(r.ok).toBe(1);
    expect(r.unchanged).toBe(2);
    expect(fake.tables.get("biz.no_pk")!.length).toBe(3);
    expect(fake.queries.some((q) => q.startsWith("EXCHANGE TABLES `biz`.`no_pk` AND `biz`.`no_pk__staging`"))).toBe(true);
    expect(fake.queries.some((q) => q.includes("`biz`.`orders__staging`"))).toBe(false);
    expect(fake.queries.some((q) => q.includes("`biz`.`ticketing_seat_txn__staging`"))).toBe(false);
    // unchanged checks still land in pg_mirror_runs — freshness advances
    const unchangedRuns = fake.runs.filter((r2) => r2.status === "unchanged").map((r2) => r2.target_table).sort();
    expect(unchangedRuns).toEqual(["orders", "ticketing_seat_txn"]);
    // staging never survives a run
    expect([...fake.tables.keys()].filter((k) => k.includes("__staging"))).toEqual([]);
  });

  it("prunes mirrors that left the allowlist (revocation removes the lake copy)", async () => {
    fake.tables.set("biz.stale_thing", [{ v: 1 }]);
    await runOnce(pg as never, ch, { ...CFG, denyTables: [...CFG.denyTables, "public.no_pk"] });
    expect(fake.tables.has("biz.stale_thing")).toBe(false);
    expect(fake.tables.has("biz.no_pk")).toBe(false); // newly denied → pruned
    expect(fake.tables.has("biz.orders")).toBe(true);
  });

  it("zero-discovery guard: an empty discovery never prunes the mirror", async () => {
    const before = [...fake.tables.keys()].sort();
    const r = await runOnce(pg as never, ch, { allowTables: ["nosuch.*"], denyTables: [], denyColumns: [] });
    expect(r).toEqual({ ok: 0, failed: 0, rows: 0, bytes: 0, unchanged: 0 });
    expect([...fake.tables.keys()].sort()).toEqual(before); // nothing dropped
  });

  it("a failed load keeps the previous good mirror, records the error, and retries (no skip on a stale signature)", async () => {
    // touch orders so the unchanged-skip can't bypass the failing load
    const counters = await fetchChangeCounters(pg as never, "public", "orders");
    // id 2: the e2e below re-mirrors this fixture and asserts id 1's original note
    await pgAdmin([`UPDATE public.orders SET note = 'touched' WHERE id = 2`], DB_NAME);
    await waitForCounterChange(pg, "public", "orders", counters);
    const before = fake.tables.get("biz.orders")!;
    fake.failInserts = true;
    fake.runs.length = 0;
    const cfg = { allowTables: ["public.orders"], denyTables: [], denyColumns: [] };
    const r = await runOnce(pg as never, ch, cfg);
    fake.failInserts = false;
    expect(r.failed).toBe(1);
    expect(fake.tables.get("biz.orders")).toBe(before); // untouched
    expect(fake.runs.length).toBe(1);
    expect(fake.runs[0].status).toBe("error");
    // the failed stream still PULLED bytes from the source — the ledger must
    // see them (a failing table retries every pass; recording 0 hides exactly
    // the repeated-restream overage the ledger exists to catch)
    expect(Number(fake.runs[0].bytes)).toBeGreaterThan(0);
    expect(r.bytes).toBeGreaterThan(0);
    // the failure must NOT have stored the new signature — the next pass
    // reloads instead of skipping on a mirror that never got the change
    const retry = await runOnce(pg as never, ch, cfg);
    expect(retry.ok).toBe(1);
    expect(retry.unchanged).toBe(0);
    expect(fake.tables.get("biz.orders")!.find((o) => String(o.id) === "2")!.note).toBe("touched");
  });

  it("denyColumns drops the column from the mirror and can rescue an unmappable table", async () => {
    await pgAdmin([`INSERT INTO public.has_interval VALUES (1, interval '1 day')`], DB_NAME);
    const cfg = {
      allowTables: ["public.orders", "public.has_interval"],
      denyTables: [],
      denyColumns: ["public.orders.blob", "public.has_interval.span"],
    };
    const r = await runOnce(pg as never, ch, cfg);
    // orders reloads (its shape changed vs the stored signature) without blob;
    // has_interval becomes mirrorable once its interval column is excluded
    expect(r.ok).toBe(2);
    expect(r.failed).toBe(0);
    const o1 = fake.tables.get("biz.orders")!.find((o) => String(o.id) === "1")!;
    expect("blob" in o1).toBe(false);
    expect(fake.tables.get("biz.orders")!.find((o) => String(o.id) === "2")!.note).toBe("touched");
    expect(fake.tables.get("biz.has_interval")!.length).toBe(1);
    expect("span" in fake.tables.get("biz.has_interval")![0]).toBe(false);
    // a table with EVERY column denied fails loudly instead of mirroring nothing
    const { failed } = await discoverTables(pg as never, { ...cfg, denyColumns: ["public.has_interval.*"] });
    expect(failed.find((f) => f.name === "has_interval")!.error).toContain("every column is deny-listed");
    // same source, same config → the denyColumns shape is IN the signature, so
    // an immediate re-run skips both
    const again = await runOnce(pg as never, ch, cfg);
    expect(again.unchanged).toBe(2);
    expect(again.ok).toBe(0);
  });
});

/* ------------------- e2e: real pg + REAL ClickHouse ------------------- */

const CH_URL = process.env.SETOKU_E2E_CH_URL;

describe.skipIf(!CH_URL)("mirror e2e (real ClickHouse)", () => {
  let rpg: SQL;
  let rch: ChOptions;

  const admin = async (q: string): Promise<string> => {
    const u = new URL(CH_URL!);
    const res = await fetch(`${u.origin}/?${new URLSearchParams({ default_format: "JSON" })}`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${decodeURIComponent(u.username) || "default"}:${decodeURIComponent(u.password)}`)}` },
      body: q,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ch admin: ${text.slice(0, 300)}`);
    return text;
  };
  const adminRows = async (q: string): Promise<Record<string, unknown>[]> =>
    (JSON.parse(await admin(q)) as { data: Record<string, unknown>[] }).data;

  beforeAll(async () => {
    const u = new URL(CH_URL!);
    rch = {
      url: u.origin,
      user: decodeURIComponent(u.username) || "default",
      password: decodeURIComponent(u.password),
      db: "setoku_mirror_meta_test",
      mirrorDb: "biz_mirror_test",
    };
    await admin(`DROP DATABASE IF EXISTS ${rch.db}`);
    await admin(`DROP DATABASE IF EXISTS ${rch.mirrorDb}`);
    await admin(`CREATE DATABASE ${rch.db}`);
    rpg = new SQL(pgOptions(DB_URL) as never); // reuses the pg fixture DB above
    await ensureMirrorObjects(rch);
  });
  afterAll(async () => {
    await rpg?.end();
    await admin(`DROP DATABASE IF EXISTS ${rch.db}`).catch(() => {});
    await admin(`DROP DATABASE IF EXISTS ${rch.mirrorDb}`).catch(() => {});
  });

  it("round-trips types through a real engine and swaps atomically", async () => {
    const r1 = await runOnce(rpg as never, rch, CFG);
    expect(r1.ok).toBe(3);

    // Decimal-from-string survived exactly (money math, not Float64 drift)
    const sums = await adminRows(`SELECT toString(sum(amount)) AS s, toString(sum(loose)) AS l FROM ${rch.mirrorDb}.orders`);
    expect(sums[0].s).toBe("12.39");
    expect(sums[0].l).toBe("0.000000001");

    // timestamptz landed as the right UTC instant regardless of pg server tz
    const ts = await adminRows(`SELECT toString(placed_at) AS t FROM ${rch.mirrorDb}.orders WHERE id = 1`);
    expect(ts[0].t).toBe("2026-05-01 10:00:00.000000");

    // arrays, enums, uuid, bool, nullables
    const row = await adminRows(
      `SELECT tags, nums, status, status_note, active, toString(uid) AS uid, note, day, meta FROM ${rch.mirrorDb}.orders WHERE id = 1`,
    );
    expect(row[0].tags).toEqual(["x", "y'z"]);
    expect(row[0].nums).toEqual([1, 2]);
    expect(row[0].status).toBe("paid");
    expect(row[0].status_note).toBe("refunded"); // nullable enum → LowCardinality(Nullable(String))
    expect(row[0].active).toBe(true);
    expect(row[0].uid).toBe("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    expect(row[0].note).toBe("héllo — 'quoted'");
    expect(String(row[0].day)).toBe("2026-05-01");
    expect(row[0].meta).toBe('{"a":1}');

    // float specials round-trip as real NaN/-Inf, not 0/NULL
    const specials = await adminRows(
      `SELECT isNaN(ratio) AS n FROM ${rch.mirrorDb}.orders WHERE id = 1
       UNION ALL SELECT isInfinite(ratio) FROM ${rch.mirrorDb}.orders WHERE id = 2`,
    );
    expect(specials.map((s) => Number(s.n))).toEqual([1, 1]);
    const nulls = await adminRows(`SELECT meta, uid, tags FROM ${rch.mirrorDb}.orders WHERE id = 2`);
    expect(nulls[0].meta).toBeNull();
    expect(nulls[0].uid).toBeNull();
    expect(nulls[0].tags).toEqual([]);

    // per-row freshness stamp DEFAULT-fills at load and is sane
    const stamp = await adminRows(
      `SELECT countIf(_mirrored_at IS NULL) AS nulls, max(_mirrored_at) > now() - INTERVAL 10 MINUTE AS fresh FROM ${rch.mirrorDb}.orders`,
    );
    expect(Number(stamp[0].nulls)).toBe(0);
    expect(Number(stamp[0].fresh)).toBe(1);

    // volume + ORDER BY key present
    const cnt = await adminRows(`SELECT count() AS c FROM ${rch.mirrorDb}.ticketing_seat_txn`);
    expect(Number(cnt[0].c)).toBe(25000);
    const key = await adminRows(`SELECT sorting_key FROM system.tables WHERE database = '${rch.mirrorDb}' AND name = 'ticketing_seat_txn'`);
    expect(key[0].sorting_key).toBe("acct_id, seq");

    // second run: the changed table takes the EXCHANGE path, the quiet ones
    // are verified unchanged and skipped — no staging leftovers either way
    const before = await fetchChangeCounters(rpg as never, "public", "no_pk");
    await rpg.unsafe(`INSERT INTO public.no_pk VALUES ('d')`);
    await waitForCounterChange(rpg, "public", "no_pk", before);
    const r2 = await runOnce(rpg as never, rch, CFG);
    expect(r2.ok).toBe(1);
    expect(r2.unchanged).toBe(2);
    const tables = await adminRows(`SELECT name FROM system.tables WHERE database = '${rch.mirrorDb}' ORDER BY name`);
    expect(tables.map((t) => t.name)).toEqual(["no_pk", "orders", "ticketing_seat_txn"]);

    // runs + heartbeat + state metadata landed in the meta db; unchanged
    // checks advance freshness the way the gateway reads it (ok OR unchanged)
    const runs = await adminRows(`SELECT count() AS c FROM ${rch.db}.pg_mirror_runs WHERE status = 'ok'`);
    expect(Number(runs[0].c)).toBeGreaterThanOrEqual(4);
    const unchangedRuns = await adminRows(`SELECT count() AS c FROM ${rch.db}.pg_mirror_runs WHERE status = 'unchanged'`);
    expect(Number(unchangedRuns[0].c)).toBe(2);
    const stateRows = await adminRows(`SELECT target, signature FROM ${rch.db}.pg_mirror_state FINAL ORDER BY target`);
    expect(stateRows.map((s) => s.target)).toEqual(["no_pk", "orders", "ticketing_seat_txn"]);
  });
});
