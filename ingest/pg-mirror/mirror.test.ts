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
  parseQuietHours,
  inQuietHours,
  wallClockHour,
  intervalFor,
  nextPassAt,
  capReached,
  positiveMs,
  parseDailyCap,
  nextUtcMidnight,
  chooseKey,
  xminWindow,
  parseReconcileHours,
  quietWindowStart,
  fetchServerInfo,
  INCREMENTAL_MIN_VERSION,
  type Cadence,
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
 *  RENAME), JSONEachRow inserts, count()/system.tables selects. A
 *  ReplacingMergeTree is modeled as already merged: an insert REPLACES any
 *  row with the same ORDER BY key (the real engine's read-time dedup via
 *  FINAL is proven in the real-ClickHouse e2e below). */
class FakeClickHouse {
  server: ReturnType<typeof Bun.serve>;
  tables = new Map<string, Record<string, unknown>[]>(); // "db.name" → rows
  engines = new Map<string, { replacing: boolean; key: string[] }>(); // "db.name" → engine
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
        const target = this.tables.get(key)!;
        const eng = this.engines.get(key);
        if (eng?.replacing) {
          const id = (r: Record<string, unknown>): string => JSON.stringify(eng.key.map((k) => r[k]));
          const at = new Map(target.map((x, i) => [id(x), i]));
          for (const row of rows) {
            const i = at.get(id(row));
            if (i !== undefined) target[i] = row;
            else at.set(id(row), target.push(row) - 1);
          }
        } else target.push(...rows);
      }
      return ok();
    }
    if ((m = q.match(/^CREATE DATABASE IF NOT EXISTS/i))) return ok();
    if ((m = q.match(/^CREATE TABLE IF NOT EXISTS/i))) return ok();
    if ((m = q.match(/^ALTER TABLE \S+ ADD COLUMN IF NOT EXISTS/i))) return ok();
    if ((m = q.match(/^CREATE TABLE (\S+)/i))) {
      const order = q.match(/ORDER BY \((.*)\)\n/);
      this.tables.set(this.key(m[1]), []);
      this.engines.set(this.key(m[1]), {
        replacing: /ENGINE = ReplacingMergeTree/.test(q),
        key: order ? order[1].split(", ").map((k) => k.replace(/`/g, "")) : [],
      });
      return ok();
    }
    if ((m = q.match(/^DROP TABLE IF EXISTS (\S+)/i))) {
      this.tables.delete(this.key(m[1]));
      this.engines.delete(this.key(m[1]));
      return ok();
    }
    if ((m = q.match(/^EXCHANGE TABLES (\S+) AND (\S+)/i))) {
      const a = this.key(m[1]);
      const b = this.key(m[2]);
      if (!this.tables.has(a) || !this.tables.has(b)) return new Response("missing table", { status: 404 });
      const tmp = this.tables.get(a)!;
      this.tables.set(a, this.tables.get(b)!);
      this.tables.set(b, tmp);
      const tmpEngine = this.engines.get(a)!;
      this.engines.set(a, this.engines.get(b)!);
      this.engines.set(b, tmpEngine);
      return ok();
    }
    if ((m = q.match(/^RENAME TABLE (\S+) TO (\S+)/i))) {
      const a = this.key(m[1]);
      if (!this.tables.has(a)) return new Response("missing table", { status: 404 });
      this.tables.set(this.key(m[2]), this.tables.get(a)!);
      this.tables.delete(a);
      this.engines.set(this.key(m[2]), this.engines.get(a)!);
      this.engines.delete(a);
      return ok();
    }
    if ((m = q.match(/^SELECT count\(\) AS c FROM (\S+)/i))) {
      const rows = this.tables.get(this.key(m[1]));
      if (!rows) return new Response("missing table", { status: 404 });
      return ok(JSON.stringify({ data: [{ c: String(rows.length) }] }));
    }
    if ((m = q.match(/^SELECT target, signature, cursor, toUnixTimestamp64Milli\(full_at\) AS full_at, deltas FROM \S+\.pg_mirror_state FINAL/i))) {
      // ReplacingMergeTree(checked_at) ORDER BY target — last write per target wins
      const latest = new Map<string, Record<string, unknown>>();
      for (const r of this.state) latest.set(String(r.target), r);
      const ms = (stamp: unknown): string => {
        const t = String(stamp);
        return String(Date.parse(/Z$/.test(t) ? t : t.replace(" ", "T") + "Z") || 0);
      };
      return ok(
        JSON.stringify({
          data: [...latest.values()].map((r) => ({ target: r.target, signature: r.signature, cursor: r.cursor ?? "", full_at: ms(r.full_at), deltas: r.deltas ?? 0 })),
        }),
      );
    }
    if ((m = q.match(/^SELECT countIf\(l\.h IS NULL\) AS missing.*? FROM (\S+) FINAL\) AS l FULL OUTER JOIN .*? FROM (\S+)\) AS f /i))) {
      // drift: key-joined row comparison, _mirrored_at excluded
      const live = this.tables.get(this.key(m[1]))!;
      const fresh = this.tables.get(this.key(m[2]))!;
      const keyCols = this.engines.get(this.key(m[1]))!.key;
      const id = (r: Record<string, unknown>): string => JSON.stringify(keyCols.map((k) => r[k]));
      const body = (r: Record<string, unknown>): string =>
        JSON.stringify(Object.keys(r).filter((k) => k !== "_mirrored_at").sort().map((k) => [k, r[k]]));
      const l = new Map(live.map((r) => [id(r), body(r)]));
      const f = new Map(fresh.map((r) => [id(r), body(r)]));
      let missing = 0, extra = 0, changed = 0;
      for (const [k, v] of f) if (!l.has(k)) missing++; else if (l.get(k) !== v) changed++;
      for (const k of l.keys()) if (!f.has(k)) extra++;
      return ok(JSON.stringify({ data: [{ missing: String(missing), extra: String(extra), changed: String(changed) }] }));
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

  it("a spent byte budget records changed tables as capped and streams nothing more", async () => {
    const before = await fetchChangeCounters(pg as never, "public", "no_pk");
    await pgAdmin([`INSERT INTO public.no_pk VALUES ('d')`], DB_NAME);
    await waitForCounterChange(pg, "public", "no_pk", before);
    fake.queries.length = 0;
    fake.runs.length = 0;
    const r = await runOnce(pg as never, ch, CFG, undefined, 0);
    // no_pk changed but the budget is spent → capped, not streamed; the
    // unchanged tables are still verified (that costs no egress)
    expect(r.capped).toBe(1);
    expect(r.ok).toBe(0);
    expect(r.failed).toBe(2); // the two discovery failures (evil__staging, has_interval), as in every pass
    expect(r.unchanged).toBe(2);
    expect(fake.queries.some((q) => q.includes("__staging"))).toBe(false); // no stream started
    expect(fake.tables.get("biz.no_pk")!.length).toBe(3); // previous copy untouched
    const capped = fake.runs.filter((x) => x.status === "capped");
    expect(capped.map((x) => x.target_table)).toEqual(["no_pk"]);
    expect(String(capped[0].error)).toMatch(/daily egress cap/);
    // the signature was not saved, so the table reloads on the next unbudgeted pass
    const again = await runOnce(pg as never, ch, CFG);
    expect(again.ok).toBe(1);
    expect(again.capped).toBe(0);
    expect(fake.tables.get("biz.no_pk")!.length).toBe(4);
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
    expect(r).toEqual({ ok: 0, failed: 0, rows: 0, bytes: 0, unchanged: 0, capped: 0, incremental: 0 });
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

/* -------------------- incremental (xmin) pull -------------------- */

describe("incremental units", () => {
  const id = mapColumn(col({ column_name: "id", udt_name: "int8", not_null: true }));
  const email = mapColumn(col({ column_name: "email", udt_name: "text", not_null: true }));
  const nick = mapColumn(col({ column_name: "nick", udt_name: "text" })); // nullable
  const org = mapColumn(col({ column_name: "org", udt_name: "int4", not_null: true }));

  it("chooseKey: the PK wins; else the narrowest NOT NULL unique index; never a partial key", () => {
    const pk: [string, { isPk: boolean; cols: string[] }] = ["t_pkey", { isPk: true, cols: ["id"] }];
    const wide: [string, { isPk: boolean; cols: string[] }] = ["t_org_email_key", { isPk: false, cols: ["org", "email"] }];
    const narrow: [string, { isPk: boolean; cols: string[] }] = ["t_email_key", { isPk: false, cols: ["email"] }];
    const onNullable: [string, { isPk: boolean; cols: string[] }] = ["t_nick_key", { isPk: false, cols: ["nick"] }];
    expect(chooseKey([wide, pk, narrow], [id, email, org])).toEqual(["id"]);
    expect(chooseKey([wide, narrow], [id, email, org])).toEqual(["email"]);
    // a nullable unique column lets NULLs repeat — not an identity
    expect(chooseKey([onNullable], [id, nick])).toEqual([]);
    // PK column deny-listed (absent from the mirror) → fall back, never a prefix
    expect(chooseKey([pk, wide], [email, org])).toEqual(["org", "email"]);
    expect(chooseKey([pk], [email])).toEqual([]);
  });

  it("xminWindow: modulo-2^32 window from the boundary to the snapshot's xmax", () => {
    expect(xminWindow(1000n, 1500n)).toBe("((xmin::text::bigint - 1000) & 4294967295) < 500");
    // an epoch boundary inside the window: lo is the 32-bit part, width stays exact
    const from = 2n ** 32n * 3n - 10n;
    expect(xminWindow(from, from + 30n)).toBe(`((xmin::text::bigint - ${2n ** 32n - 10n}) & 4294967295) < 30`);
    expect(xminWindow(1000n, 900n)).toBeNull(); // cursor from the future: a repointed source
    expect(xminWindow(0n, 2n ** 31n)).toBeNull(); // too wide to be unambiguous
    expect(xminWindow(5n, 5n)).toBe("((xmin::text::bigint - 5) & 4294967295) < 0"); // idle source: pulls nothing
  });

  it("the modulo window selects exactly the xids in [from, xmax) across a wraparound", () => {
    // mirror the SQL predicate in JS over 32-bit raw xids
    const inWin = (raw: bigint, from: bigint, xmax: bigint): boolean =>
      ((raw - (from % 2n ** 32n)) & 0xffffffffn) < xmax - from;
    const from = 2n ** 32n * 2n - 3n; // 3 xids before epoch 2 begins
    const xmax = from + 6n;
    const raw = (full: bigint): bigint => full % 2n ** 32n;
    expect(inWin(raw(from - 1n), from, xmax)).toBe(false);
    for (let d = 0n; d < 6n; d++) expect(inWin(raw(from + d), from, xmax)).toBe(true);
    expect(inWin(raw(xmax), from, xmax)).toBe(false);
  });

  it("schemaSignature: full-reload tables hash as before; incremental adds the engine", () => {
    const t = { schema: "public", name: "t", columns: [id], pk: ["id"] };
    const legacy = Bun.hash(JSON.stringify([[["id", "Int64"]], ["id"]])).toString(36);
    expect(schemaSignature(t)).toBe(legacy); // no spurious reload on upgrade
    expect(schemaSignature({ ...t, incremental: false })).toBe(legacy);
    expect(schemaSignature({ ...t, incremental: true })).not.toBe(legacy); // engine flip forces a full reload
  });

  it("stagingDDL: incremental tables are ReplacingMergeTree versioned by _mirrored_at", () => {
    const ddl = stagingDDL("biz", "t__staging", { schema: "public", name: "t", columns: [id], pk: ["id"], incremental: true });
    expect(ddl).toContain("ENGINE = ReplacingMergeTree(`_mirrored_at`)");
    expect(ddl).toContain("ORDER BY (`id`)");
  });

  it("quietWindowStart: when the current quiet window began, across midnight; null outside", () => {
    const c: Cadence = { baseMs: 20 * 60_000, quietMs: 2 * 3_600_000, quiet: { start: 23, end: 8 }, tz: "America/Los_Angeles" };
    const at = (iso: string): number => Date.parse(iso);
    // 01:30 PDT (08:30Z) → the window opened 23:00 PDT the evening before (06:00Z)
    expect(quietWindowStart(at("2026-09-23T08:30:00Z"), c)).toBe(at("2026-09-23T06:00:00Z"));
    // 23:10 PDT → 23:00 PDT the same evening
    expect(quietWindowStart(at("2026-09-23T06:10:00Z"), c)).toBe(at("2026-09-23T06:00:00Z"));
    // 14:00 PDT → outside
    expect(quietWindowStart(at("2026-09-22T21:00:00Z"), c)).toBeNull();
    expect(quietWindowStart(at("2026-09-23T08:30:00Z"), { ...c, quiet: null })).toBeNull();
  });

  it("parseReconcileHours: default 24 h, 0 = never, garbage fails fast", () => {
    expect(parseReconcileHours(undefined)).toBe(24 * 3_600_000);
    expect(parseReconcileHours(" ")).toBe(24 * 3_600_000);
    expect(parseReconcileHours("0")).toBeNull();
    expect(parseReconcileHours("6")).toBe(6 * 3_600_000);
    expect(() => parseReconcileHours("daily")).toThrow(/RECONCILE_HOURS/);
    expect(() => parseReconcileHours("-1")).toThrow(/RECONCILE_HOURS/);
  });
});

const INCR_DB = "setoku_mirror_incr_test";
const INCR_URL = `postgresql:///${INCR_DB}?host=${encodeURIComponent(PG_HOST)}`;
const INCR_CFG = { allowTables: ["public.*"], denyTables: [], denyColumns: [] as string[] };

describe("incremental pull (real Postgres → FakeClickHouse)", () => {
  let ipg: SQL;
  let ifake: FakeClickHouse;
  let ich: ChOptions;

  const runsFor = (target: string): Record<string, unknown>[] => ifake.runs.filter((r) => r.target_table === target);
  const lastRun = (target: string): Record<string, unknown> => runsFor(target).at(-1)!;
  const events = (): Record<string, unknown>[] => ifake.tables.get("biz.events")!;
  const eventIds = (): number[] => events().map((e) => Number(e.id)).sort((a, b) => a - b);
  /** Write, then wait until pg_stat shows it — the unchanged-skip must not
   *  race the stats flush. */
  const write = async (statements: string[], table = "events"): Promise<void> => {
    const before = await fetchChangeCounters(ipg as never, "public", table);
    await pgAdmin(statements, INCR_DB);
    await waitForCounterChange(ipg, "public", table, before);
  };

  beforeAll(async () => {
    const maint = process.env.SETOKU_E2E_PG_MAINTENANCE_DB ?? "template1";
    await pgAdmin([`DROP DATABASE IF EXISTS ${INCR_DB} WITH (FORCE)`, `CREATE DATABASE ${INCR_DB}`], maint);
    await pgAdmin(
      [
        `CREATE TABLE public.events (id bigint PRIMARY KEY, kind text NOT NULL, payload text)`,
        `INSERT INTO public.events SELECT g, 'k' || (g % 7), repeat('x', 200) FROM generate_series(1, 1000) g`,
        // no PK, only a unique index over NOT NULL columns
        `CREATE TABLE public.tokens (identifier text NOT NULL, token text NOT NULL, expires timestamptz, UNIQUE (identifier, token))`,
        `INSERT INTO public.tokens VALUES ('a@example.com', 't1', now())`,
        `CREATE TABLE public.loose (v text)`, // no key → full reload
        `INSERT INTO public.loose VALUES ('a')`,
        `CREATE TABLE public.float_key (k float8 PRIMARY KEY)`, // inexact key → full reload
        `CREATE TABLE public.parted (id int NOT NULL, k int NOT NULL, PRIMARY KEY (id, k)) PARTITION BY RANGE (k)`,
        `CREATE TABLE public.parted_0 PARTITION OF public.parted FOR VALUES FROM (0) TO (100)`,
        `INSERT INTO public.parted VALUES (1, 1), (2, 2)`,
      ],
      INCR_DB,
    );
    ipg = new SQL(pgOptions(INCR_URL) as never);
    ifake = new FakeClickHouse();
    ich = { url: ifake.url, user: "setoku", password: "pw", db: "setoku", mirrorDb: "biz" };
    await ensureMirrorObjects(ich);
  });
  afterAll(async () => {
    await ipg?.end();
    ifake?.stop();
  });

  it("discovery marks heap tables with an exact key as incremental — and nothing else", async () => {
    const server = await fetchServerInfo(ipg as never);
    expect(server.version).toBeGreaterThanOrEqual(INCREMENTAL_MIN_VERSION);
    expect(server.replica).toBe(false);
    const { tables } = await discoverTables(ipg as never, INCR_CFG, { server });
    const by = Object.fromEntries(tables.map((t) => [t.name, t]));
    expect(by.events.incremental).toBe(true);
    expect(by.tokens.incremental).toBe(true);
    expect(by.tokens.pk).toEqual(["identifier", "token"]); // unique-index fallback
    expect(by.parted.incremental).toBe(true); // partitioned, every leaf heap
    expect(by.loose.incremental).toBe(false);
    expect(by.float_key.incremental).toBe(false);
    // opt-out and old servers keep everything on the full-reload path
    const off = await discoverTables(ipg as never, INCR_CFG, { server, incremental: false });
    expect(off.tables.some((t) => t.incremental)).toBe(false);
    const old = await discoverTables(ipg as never, INCR_CFG, { server: { version: 120000, replica: false } });
    expect(old.tables.some((t) => t.incremental)).toBe(false);
  });

  it("first pass full-reloads into ReplacingMergeTree and stores an xmin boundary", async () => {
    const r = await runOnce(ipg as never, ich, INCR_CFG);
    expect(r.ok).toBe(5);
    expect(r.incremental).toBe(0);
    expect(eventIds().length).toBe(1000);
    expect(ifake.engines.get("biz.events")!.replacing).toBe(true);
    expect(ifake.engines.get("biz.loose")!.replacing).toBe(false);
    expect(lastRun("events").mode).toBe("full");
    const st = ifake.state.filter((s) => s.target === "events").at(-1)!;
    expect(String(st.cursor)).toMatch(/^\d+$/);
    expect(ifake.state.filter((s) => s.target === "loose").at(-1)!.cursor).toBe("");
  });

  it("a changed table pulls ONLY rows written since the boundary, upserted in place", async () => {
    const fullBytes = Number(lastRun("events").bytes);
    await write([
      `INSERT INTO public.events VALUES (1001, 'new', 'a'), (1002, 'new', 'b'), (1003, 'new', 'c')`,
      `UPDATE public.events SET payload = 'edited' WHERE id IN (10, 20)`,
    ]);
    ifake.queries.length = 0;
    const r = await runOnce(ipg as never, ich, INCR_CFG);
    const run = lastRun("events");
    expect(run.mode).toBe("incremental");
    expect(run.rows).toBe(5);
    expect(Number(run.bytes)).toBeLessThan(fullBytes / 50); // the whole point: egress ∝ change
    expect(eventIds().length).toBe(1003);
    expect(events().find((e) => Number(e.id) === 10)!.payload).toBe("edited");
    // no staging table, no swap — upserted straight into the live mirror
    expect(ifake.queries.some((q) => q.includes("`biz`.`events__staging`"))).toBe(false);
    expect(ifake.queries.some((q) => q.startsWith("SELECT count() AS c FROM `biz`.`events` FINAL"))).toBe(true);
    // untouched tables are still skipped outright on a primary
    expect(lastRun("tokens").status).toBe("unchanged");
    expect(r.incremental).toBeGreaterThanOrEqual(1);
  });

  it("a row written under a SAVEPOINT in a transaction straddling the pass is not lost", async () => {
    // pg_visible_in_snapshot() misjudges subxids; the snapshot-xmin boundary doesn't
    const open = new SQL({ ...pgOptions(INCR_URL), max: 1 } as never);
    let before: string | null;
    try {
      await open.unsafe("BEGIN");
      await open.unsafe("SELECT txid_current()");
      await open.unsafe("SAVEPOINT s1");
      await open.unsafe(`INSERT INTO public.events VALUES (5000, 'savepoint', 'late')`);
      // a later transaction commits meanwhile, pushing the snapshot's xmax past the subxid
      await write([`INSERT INTO public.events VALUES (5001, 'other', 'early')`]);
      await runOnce(ipg as never, ich, INCR_CFG);
      expect(lastRun("events").mode).toBe("incremental");
      expect(eventIds()).toContain(5001);
      expect(eventIds()).not.toContain(5000); // not committed yet
      before = await fetchChangeCounters(ipg as never, "public", "events");
      await open.unsafe("COMMIT");
    } finally {
      await open.end(); // a live backend may sit on its stats; exiting flushes them
    }
    await waitForCounterChange(ipg, "public", "events", before);
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("events").mode).toBe("incremental");
    expect(eventIds()).toContain(5000);
  });

  it("a delete makes the counts disagree → full reload in the same pass", async () => {
    await write([`DELETE FROM public.events WHERE id = 1`]);
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("events").mode).toBe("full");
    expect(lastRun("events").status).toBe("ok");
    expect(eventIds()).not.toContain(1);
    expect(eventIds().length).toBe(1004);
    // and the chain resumes incrementally afterwards
    await write([`INSERT INTO public.events VALUES (6000, 'after', 'x')`]);
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("events").mode).toBe("incremental");
    expect(eventIds()).toContain(6000);
  });

  it("a primary-key change leaves the old key behind → caught by the count, full reload", async () => {
    await write([`UPDATE public.events SET id = 9999 WHERE id = 2`]);
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("events").mode).toBe("full");
    expect(eventIds()).not.toContain(2);
    expect(eventIds()).toContain(9999);
  });

  it("TRUNCATE (which moves no xmin) is caught the same way", async () => {
    await write([`TRUNCATE public.tokens`, `INSERT INTO public.tokens VALUES ('b@example.com', 't2', now())`], "tokens");
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("tokens").mode).toBe("full");
    expect(ifake.tables.get("biz.tokens")!.map((t) => t.identifier)).toEqual(["b@example.com"]);
  });

  it("on a hot standby the stats skip is off: every table is pulled, incremental ones as tiny deltas", async () => {
    const r = await runOnce(ipg as never, ich, { ...INCR_CFG }, undefined, { server: { version: 150000, replica: true } });
    expect(r.unchanged).toBe(0); // standby counters never move — skipping would freeze the mirror
    expect(lastRun("events").mode).toBe("incremental");
    expect(lastRun("events").rows).toBe(0);
    expect(lastRun("loose").mode).toBe("full");
  });

  const eventsState = (): Record<string, unknown> => ifake.state.filter((s) => s.target === "events").at(-1)!;

  it("age mode: a mirror that absorbed deltas reconciles once due — even with no new writes", async () => {
    await write([`INSERT INTO public.events VALUES (7000, 'r', 'x')`]);
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("events").mode).toBe("incremental");
    expect(eventsState().deltas).toBe(1);
    // quiet now, but busy earlier: the backstop still rebuilds it
    await runOnce(ipg as never, ich, INCR_CFG, undefined, { reconcileMs: 1 });
    expect(lastRun("events").mode).toBe("reconcile");
    expect(eventsState().deltas).toBe(0);
    expect(eventIds()).toContain(7000);
    // an exact full reload has nothing to reconcile: back to the plain skip
    await runOnce(ipg as never, ich, INCR_CFG, undefined, { reconcileMs: 1 });
    expect(lastRun("events").status).toBe("unchanged");
    // a table that never took a delta is never reconciled
    expect(lastRun("tokens").status).toBe("unchanged");
  });

  it("reconcile audits the incremental mirror: drift 0 when the deltas were exact", async () => {
    await write([`UPDATE public.events SET payload = 'audited' WHERE id = 4`]);
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("events").mode).toBe("incremental");
    ifake.queries.length = 0;
    await runOnce(ipg as never, ich, INCR_CFG, undefined, { reconcileMs: 1 });
    const run = lastRun("events");
    expect(run.mode).toBe("reconcile");
    expect(run.drift).toBe(0);
    // the diff ran against the staged copy BEFORE the swap
    const diffAt = ifake.queries.findIndex((q) => q.startsWith("SELECT countIf(l.h IS NULL)") && q.includes("`biz`.`events__staging`"));
    const swapAt = ifake.queries.findIndex((q) => q.startsWith("EXCHANGE TABLES `biz`.`events`"));
    expect(diffAt).toBeGreaterThanOrEqual(0);
    expect(diffAt).toBeLessThan(swapAt);
    // a table that never went through the incremental path isn't reconciled, so no drift figure
    expect(lastRun("loose").drift ?? null).toBeNull();
  });

  it("reconcile reports — and repairs — drift the incremental path missed", async () => {
    await write([`INSERT INTO public.events VALUES (7200, 'r', 'x')`]);
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("events").mode).toBe("incremental");
    // corrupt the live mirror behind the mirror's back, keeping the row count
    // equal so the per-pass count check can't see it: one changed row, one
    // missing (a lost insert), one extra (a lost delete)
    const live = events();
    live.find((e) => Number(e.id) === 5)!.payload = "corrupt";
    live.splice(live.findIndex((e) => Number(e.id) === 6), 1);
    live.push({ id: "424242", kind: "ghost", payload: "never existed" });
    await runOnce(ipg as never, ich, INCR_CFG, undefined, { reconcileMs: 1 });
    const run = lastRun("events");
    expect(run.mode).toBe("reconcile");
    expect(run.drift).toBe(3);
    // and the reload fixed it
    expect(events().find((e) => Number(e.id) === 5)!.payload).not.toBe("corrupt");
    expect(eventIds()).toContain(6);
    expect(eventIds()).not.toContain(424242);
  });

  it("window mode: reconcile only inside the quiet window, once per window", async () => {
    await write([`INSERT INTO public.events VALUES (7100, 'r', 'x')`]);
    const outside = { reconcileMs: 1, reconcileWindowStart: (): number | null => null };
    await runOnce(ipg as never, ich, INCR_CFG, undefined, outside);
    expect(lastRun("events").mode).toBe("incremental"); // age alone doesn't count in window mode
    await runOnce(ipg as never, ich, INCR_CFG, undefined, outside);
    expect(lastRun("events").status).toBe("unchanged"); // outside the window: no reconcile
    const windowBegan = Date.now();
    const inside = { reconcileWindowStart: (): number | null => windowBegan };
    await runOnce(ipg as never, ich, INCR_CFG, undefined, inside);
    expect(lastRun("events").mode).toBe("reconcile");
    expect(lastRun("tokens").status).toBe("unchanged"); // no deltas → nothing to reconcile
    // same window, busy again: deltas resume, no second reconcile this window
    await write([`INSERT INTO public.events VALUES (7101, 'r', 'x')`]);
    await runOnce(ipg as never, ich, INCR_CFG, undefined, inside);
    expect(lastRun("events").mode).toBe("incremental");
    await runOnce(ipg as never, ich, INCR_CFG, undefined, inside);
    expect(lastRun("events").status).toBe("unchanged");
  });

  it("an unusable boundary (source repointed to a younger database) falls back to a full reload", async () => {
    const st = ifake.state.filter((s) => s.target === "events").at(-1)!;
    ifake.state.push({ ...st, cursor: String(2n ** 40n) }); // "from the future"
    await write([`INSERT INTO public.events VALUES (8000, 'r', 'x')`]);
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("events").mode).toBe("full");
    expect(eventIds()).toContain(8000);
    expect(BigInt(String(ifake.state.filter((s) => s.target === "events").at(-1)!.cursor))).toBeLessThan(2n ** 40n);
  });

  it("switching incremental off rebuilds as MergeTree (shape changed) and back again", async () => {
    await runOnce(ipg as never, ich, INCR_CFG, undefined, { incremental: false });
    expect(ifake.engines.get("biz.events")!.replacing).toBe(false);
    expect(lastRun("events").mode).toBe("full");
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(ifake.engines.get("biz.events")!.replacing).toBe(true);
    expect(lastRun("events").mode).toBe("full"); // the flip back goes through a full reload too
    await write([`INSERT INTO public.events VALUES (9000, 'r', 'x')`]);
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("events").mode).toBe("incremental");
  });

  it("a delta that fails mid-upsert keeps the old boundary and re-pulls next pass", async () => {
    const before = String(ifake.state.filter((s) => s.target === "events").at(-1)!.cursor);
    await write([`UPDATE public.events SET payload = 'retry-me' WHERE id = 3`]);
    ifake.failInserts = true;
    const r = await runOnce(ipg as never, ich, INCR_CFG);
    ifake.failInserts = false;
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(lastRun("events").status).toBe("error");
    expect(lastRun("events").mode).toBe("incremental");
    expect(Number(lastRun("events").bytes)).toBeGreaterThan(0); // the pulled row still hits the ledger
    expect(String(ifake.state.filter((s) => s.target === "events").at(-1)!.cursor)).toBe(before);
    await runOnce(ipg as never, ich, INCR_CFG);
    expect(lastRun("events").status).toBe("ok");
    expect(events().find((e) => Number(e.id) === 3)!.payload).toBe("retry-me");
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

describe.skipIf(!CH_URL)("incremental e2e (real ClickHouse)", () => {
  const PG_DB = "setoku_mirror_incr_e2e";
  let epg: SQL;
  let ech: ChOptions;
  const chq = async (q: string): Promise<Record<string, unknown>[]> => {
    const u = new URL(CH_URL!);
    const res = await fetch(`${u.origin}/?${new URLSearchParams({ default_format: "JSON" })}`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${decodeURIComponent(u.username) || "default"}:${decodeURIComponent(u.password)}`)}` },
      body: q,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ch: ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as { data: Record<string, unknown>[] }).data : [];
  };
  const write = async (statements: string[]): Promise<void> => {
    const before = await fetchChangeCounters(epg as never, "public", "events");
    await pgAdmin(statements, PG_DB);
    await waitForCounterChange(epg, "public", "events", before);
  };

  beforeAll(async () => {
    const maint = process.env.SETOKU_E2E_PG_MAINTENANCE_DB ?? "template1";
    await pgAdmin([`DROP DATABASE IF EXISTS ${PG_DB} WITH (FORCE)`, `CREATE DATABASE ${PG_DB}`], maint);
    await pgAdmin(
      [
        `CREATE TABLE public.events (id bigint PRIMARY KEY, payload text)`,
        `INSERT INTO public.events SELECT g, 'v1' FROM generate_series(1, 1000) g`,
        `CREATE TABLE public.loose (v text)`,
        `INSERT INTO public.loose VALUES ('a'), ('a')`,
        // every mapped type family, so a clean reconcile proves the row hash
        // has no false positives (NULLs, NaN, arrays, json, enums, decimals…)
        `CREATE TYPE mood AS ENUM ('ok', 'meh')`,
        `CREATE TABLE public.typed (
           id int PRIMARY KEY, amount numeric(10,2), loose numeric, placed timestamptz, day date,
           meta jsonb, tags text[], nums int4[], m mood, m2 mood, flag boolean, uid uuid, note text,
           blob bytea, ratio float8)`,
        `INSERT INTO public.typed VALUES
           (1, 12.34, 0.000000001, '2026-05-01T10:00:00Z', '2026-05-01', '{"a":[1,{"b":null}]}', ARRAY['x','y\tz'], ARRAY[1,2], 'ok', NULL, true, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '', '\\xdead', 'NaN'),
           (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'meh', 'ok', NULL, NULL, NULL, NULL, '-Infinity')`,
      ],
      PG_DB,
    );
    epg = new SQL(pgOptions(`postgresql:///${PG_DB}?host=${encodeURIComponent(PG_HOST)}`) as never);
    ech = { url: new URL(CH_URL!).origin, user: decodeURIComponent(new URL(CH_URL!).username) || "default", password: decodeURIComponent(new URL(CH_URL!).password), db: "setoku_mirror_incr_meta", mirrorDb: "biz_mirror_incr" };
    await chq(`DROP DATABASE IF EXISTS ${ech.db}`);
    await chq(`DROP DATABASE IF EXISTS ${ech.mirrorDb}`);
    await chq(`CREATE DATABASE ${ech.db}`);
    await ensureMirrorObjects(ech);
  });
  afterAll(async () => {
    await epg?.end();
    await chq(`DROP DATABASE IF EXISTS ${ech.db}`).catch(() => {});
    await chq(`DROP DATABASE IF EXISTS ${ech.mirrorDb}`).catch(() => {});
  });

  it("upserts deltas into a ReplacingMergeTree that readers see deduped under final=1", async () => {
    const r1 = await runOnce(epg as never, ech, INCR_CFG);
    expect(r1.ok).toBe(3); // events, loose, typed
    const eng = await chq(`SELECT engine FROM system.tables WHERE database = '${ech.mirrorDb}' AND name = 'events'`);
    expect(eng[0].engine).toBe("ReplacingMergeTree");

    await write([`UPDATE public.events SET payload = 'v2' WHERE id <= 10`, `INSERT INTO public.events VALUES (1001, 'new')`]);
    const r2 = await runOnce(epg as never, ech, INCR_CFG);
    expect(r2.incremental).toBe(1);
    const run = await chq(`SELECT mode, rows FROM ${ech.db}.pg_mirror_runs WHERE target_table = 'events' ORDER BY finished_at DESC LIMIT 1`);
    expect({ mode: run[0].mode, rows: Number(run[0].rows) }).toEqual({ mode: "incremental", rows: 11 }); // UInt64 JSON is quoted on 25.x, bare on 26.x

    // the profile setting (lake-users.xml final=1) — no FINAL keyword in the query
    const viaSetting = await chq(
      `SELECT count() AS c, countIf(payload = 'v2') AS v2 FROM ${ech.mirrorDb}.events SETTINGS final = 1`,
    );
    expect([Number(viaSetting[0].c), Number(viaSetting[0].v2)]).toEqual([1001, 10]);
    const viaKeyword = await chq(`SELECT payload FROM ${ech.mirrorDb}.events FINAL WHERE id = 5`);
    expect(viaKeyword.map((x) => x.payload)).toEqual(["v2"]);
    // final=1 is a no-op on plain MergeTree mirrors (the profile applies it to EVERY table)
    const plain = await chq(`SELECT count() AS c FROM ${ech.mirrorDb}.loose SETTINGS final = 1`);
    expect(Number(plain[0].c)).toBe(2);

    // a delete falls back to a full reload through the real EXCHANGE path
    await write([`DELETE FROM public.events WHERE id = 1`]);
    await runOnce(epg as never, ech, INCR_CFG);
    const after = await chq(`SELECT count() AS c, countIf(id = 1) AS gone FROM ${ech.mirrorDb}.events SETTINGS final = 1`);
    expect([Number(after[0].c), Number(after[0].gone)]).toEqual([1000, 0]);
    const modes = await chq(`SELECT mode FROM ${ech.db}.pg_mirror_runs WHERE target_table = 'events' ORDER BY finished_at`);
    expect(modes.map((m) => m.mode)).toEqual(["full", "incremental", "full"]);
    // |full_at - now| < 1 min: on a non-UTC server a zone-less stamp would land hours off
    const state = await chq(`SELECT cursor, abs(dateDiff('second', full_at, now())) < 60 AS recent FROM ${ech.db}.pg_mirror_state FINAL WHERE target = 'events'`);
    expect(String(state[0].cursor)).toMatch(/^\d+$/);
    expect(Number(state[0].recent)).toBe(1);
  });

  it("reconcile's drift check: 0 on an exact mirror of every type, exact counts on a tampered one", async () => {
    const runOf = async (target: string): Promise<{ mode: string; drift: number | null }> => {
      const r = await chq(
        `SELECT mode, drift FROM ${ech.db}.pg_mirror_runs WHERE target_table = '${target}' ORDER BY finished_at DESC LIMIT 1`,
      );
      return { mode: String(r[0].mode), drift: r[0].drift === null ? null : Number(r[0].drift) };
    };
    // both tables take a delta, so both are reconcile candidates
    const before = await fetchChangeCounters(epg as never, "public", "typed");
    await pgAdmin([`UPDATE public.typed SET note = 'touched' WHERE id = 2`], PG_DB);
    await waitForCounterChange(epg, "public", "typed", before);
    await write([`UPDATE public.events SET payload = 'v3' WHERE id = 20`]);
    await runOnce(epg as never, ech, INCR_CFG);
    expect((await runOf("typed")).mode).toBe("incremental");
    expect((await runOf("events")).mode).toBe("incremental");

    // tamper with the live events mirror, keeping its FINAL count unchanged so
    // only the reconcile can notice: a newer bogus version of id 5 (changed),
    // a row that never existed (extra), and a real row dropped (missing)
    await chq(`INSERT INTO ${ech.mirrorDb}.events (id, payload) VALUES (5, 'corrupt'), (424242, 'ghost')`);
    await chq(`ALTER TABLE ${ech.mirrorDb}.events DELETE WHERE id IN (7, 8) SETTINGS mutations_sync = 2`);
    // re-add 8 exactly as the source has it (ids ≤ 10 were updated to 'v2'
    // above): not drift. (The check caught this line when it said 'v1'.)
    await chq(`INSERT INTO ${ech.mirrorDb}.events (id, payload) VALUES (8, 'v2')`);

    await runOnce(epg as never, ech, INCR_CFG, undefined, { reconcileMs: 1 });
    expect(await runOf("typed")).toEqual({ mode: "reconcile", drift: 0 });
    expect(await runOf("events")).toEqual({ mode: "reconcile", drift: 3 });
    // repaired by the swap
    const fixed = await chq(
      `SELECT countIf(id = 5 AND payload = 'corrupt') AS corrupt, countIf(id = 424242) AS ghost, countIf(id = 7) AS seven FROM ${ech.mirrorDb}.events SETTINGS final = 1`,
    );
    expect([Number(fixed[0].corrupt), Number(fixed[0].ghost), Number(fixed[0].seven)]).toEqual([0, 0, 1]);
  });
});

/* ------------------------------ cadence ----------------------------- */

describe("cadence: quiet hours + daily cap", () => {
  const base: Cadence = { baseMs: 20 * 60_000, quietMs: 2 * 3_600_000, quiet: { start: 23, end: 8 }, tz: "UTC" };
  const at = (iso: string): number => Date.parse(iso);

  it("parseQuietHours: H-H, wrap or same-day; blank = none; garbage fails fast", () => {
    expect(parseQuietHours("23-8")).toEqual({ start: 23, end: 8 });
    expect(parseQuietHours(" 9 - 17 ")).toEqual({ start: 9, end: 17 });
    expect(parseQuietHours(undefined)).toBeNull();
    expect(parseQuietHours("")).toBeNull();
    for (const bad of ["23", "25-8", "8-24", "9-9", "night", "23-8-1"]) {
      expect(() => parseQuietHours(bad)).toThrow(/SETOKU_MIRROR_QUIET_HOURS/);
    }
  });

  it("inQuietHours: half-open and wrap-aware", () => {
    const wrap = { start: 23, end: 8 };
    for (const h of [23, 0, 1, 7]) expect(inQuietHours(h, wrap)).toBe(true);
    for (const h of [8, 12, 22]) expect(inQuietHours(h, wrap)).toBe(false);
    const day = { start: 9, end: 17 };
    expect(inQuietHours(9, day)).toBe(true);
    expect(inQuietHours(16, day)).toBe(true);
    expect(inQuietHours(17, day)).toBe(false);
    expect(inQuietHours(3, null)).toBe(false);
  });

  it("wallClockHour: reads the hour in the given zone (PDT, PST, UTC, midnight)", () => {
    expect(wallClockHour(new Date("2026-07-01T12:00:00Z"), "America/Los_Angeles")).toBe(5); // PDT = UTC-7
    expect(wallClockHour(new Date("2026-01-15T12:00:00Z"), "America/Los_Angeles")).toBe(4); // PST = UTC-8
    expect(wallClockHour(new Date("2026-07-01T07:30:00Z"), "America/Los_Angeles")).toBe(0); // the ICU "24" guard
    expect(wallClockHour(new Date("2026-07-01T12:00:00Z"), "UTC")).toBe(12);
  });

  it("intervalFor: quiet interval inside the window, base outside, base with no window", () => {
    expect(intervalFor(new Date("2026-01-01T12:00:00Z"), base)).toBe(base.baseMs);
    expect(intervalFor(new Date("2026-01-01T23:30:00Z"), base)).toBe(base.quietMs);
    expect(intervalFor(new Date("2026-01-02T03:00:00Z"), base)).toBe(base.quietMs);
    expect(intervalFor(new Date("2026-01-02T03:00:00Z"), { ...base, quiet: null })).toBe(base.baseMs);
  });

  it("nextPassAt: base cadence by day, quiet cadence by night, and the window's end wins", () => {
    // daytime: 20 min later
    expect(nextPassAt(at("2026-01-01T12:00:00Z"), base)).toBe(at("2026-01-01T12:20:00Z"));
    // a pass ending inside the window waits the quiet interval
    expect(nextPassAt(at("2026-01-01T23:30:00Z"), base)).toBe(at("2026-01-02T01:30:00Z"));
    // a pass ending at 07:50 is due at 08:00 (base interval in force by then,
    // elapsed 10 min < 20 min → 08:10), NOT two hours later
    expect(nextPassAt(at("2026-01-02T07:50:00Z"), base)).toBe(at("2026-01-02T08:10:00Z"));
    // a pass ending at 07:30 is overdue the moment the window ends
    expect(nextPassAt(at("2026-01-02T07:30:00Z"), base)).toBe(at("2026-01-02T08:00:00Z"));
    // entering the window: a 22:50 pass would be due 23:10, but by then the
    // quiet interval applies → 00:50
    expect(nextPassAt(at("2026-01-01T22:50:00Z"), base)).toBe(at("2026-01-02T00:50:00Z"));
    // no window: plain cadence
    expect(nextPassAt(at("2026-01-02T03:00:00Z"), { ...base, quiet: null })).toBe(at("2026-01-02T03:20:00Z"));
  });

  it("capReached: skips at/over the cap, runs under it or with no cap, fails OPEN on a read error", async () => {
    expect(await capReached(null, async () => 1e12)).toEqual({ skip: false, bytes: null });
    expect(await capReached(12e9, async () => 11e9)).toEqual({ skip: false, bytes: 11e9 });
    expect(await capReached(12e9, async () => 12e9)).toEqual({ skip: true, bytes: 12e9 });
    expect(await capReached(12e9, async () => 30e9)).toEqual({ skip: true, bytes: 30e9 });
    const origErr = console.error;
    console.error = () => {};
    try {
      expect(await capReached(12e9, async () => { throw new Error("lake down"); })).toEqual({ skip: false, bytes: null });
    } finally {
      console.error = origErr;
    }
  });
});

describe("cadence: env validation + resume instant", () => {
  it("positiveMs: default on blank, value when sane, throws on NaN/zero/negative", () => {
    expect(positiveMs("X", undefined, 900_000)).toBe(900_000);
    expect(positiveMs("X", "", 900_000)).toBe(900_000);
    expect(positiveMs("X", "1200000", 900_000)).toBe(1_200_000);
    for (const bad of ["2h", "0", "-5", "NaN"]) expect(() => positiveMs("X", bad, 1)).toThrow(/X must be/);
  });
  it("parseDailyCap: off on unset/blank/0, bytes otherwise, throws on garbage (never silently off)", () => {
    expect(parseDailyCap(undefined)).toBeNull();
    expect(parseDailyCap("")).toBeNull();
    expect(parseDailyCap("0")).toBeNull();
    expect(parseDailyCap("12000000000")).toBe(12e9);
    for (const bad of ["12GB", "12_000_000_000", "-1"]) expect(() => parseDailyCap(bad)).toThrow(/DAILY_BYTES_CAP/);
  });
  it("nextUtcMidnight: the next 00:00:30 UTC, also across a month boundary", () => {
    expect(nextUtcMidnight(Date.parse("2026-01-01T23:50:00Z"))).toBe(Date.parse("2026-01-02T00:00:30Z"));
    expect(nextUtcMidnight(Date.parse("2026-01-31T00:00:00Z"))).toBe(Date.parse("2026-02-01T00:00:30Z"));
  });
});
