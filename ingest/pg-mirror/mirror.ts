#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Business-DB → lake mirror (issue #47). Full-reloads every allowlisted
 * Postgres table into the bundled ClickHouse on a poller-style loop, so heavy
 * app panels read the mirror (`biz.*`, clickhouse dialect) instead of
 * seq-scanning prod. Per table, per run:
 *
 *   1. derive DDL from the pg catalog (explicit type map — unmapped types fail
 *      that table LOUDLY, they never guess),
 *   2. create `biz.<table>__staging` and SELECT-stream rows in through a
 *      cursor (bounded memory) using the SAME read-only role the gateway
 *      queries with — the allow/deny list and the role's grants are inherited,
 *      so a table denied to run_query never leaves prod (I1/I2 unchanged),
 *   3. verify the staged row count, then atomically EXCHANGE/RENAME into
 *      place — readers never see a half-loaded table,
 *   4. record the reload in `setoku.pg_mirror_runs` (freshness + failure
 *      legibility for /healthz, /admin, and the app frame's "as of" stamp)
 *      and beat `ingest_heartbeats` like every other connector.
 *
 * Full reload every run = no CDC, no replica-identity footguns; schema drift
 * is a non-event (the next run picks up the new shape), and a table dropped
 * from prod or from the allowlist is pruned from the mirror on the next run.
 * Mirrored tables are re-derivable from prod, so `biz` is deliberately a
 * SEPARATE ClickHouse database: excluded from clickhouse-backup
 * (CLICKHOUSE_SKIP_TABLES) and from the parquet export (both walk `setoku`) —
 * the precious lake data (I4) stays exactly what it was.
 *
 * Env:
 *   SETOKU_DATABASE_URL        read-only Postgres URL (same one the gateway uses) [required]
 *   CLICKHOUSE_URL             default http://clickhouse:8123
 *   CLICKHOUSE_USER            default setoku   (full-privilege ingest user — needs CREATE/INSERT/EXCHANGE)
 *   CLICKHOUSE_PASSWORD        default ""
 *   CLICKHOUSE_DB              metadata db (heartbeats, runs), default setoku
 *   SETOKU_MIRROR_INTERVAL_MS  default 900000 (15 min between full reloads)
 *   SETOKU_PROJECT_DIR         default /project — reads .setoku/config.json for allow/denyTables
 *   SETOKU_PG_SSL_STRICT       "1" = verify TLS certs (default: encrypt, don't verify — matches gateway lib/db.ts)
 */
import fs from "node:fs";
import path from "node:path";
import { SQL } from "bun";

/* ------------------------------ config ------------------------------ */

export interface MirrorConfig {
  allowTables: string[];
  denyTables: string[];
}

/** Same allow/deny source of truth as the gateway: .setoku/config.json in the
 *  baked project dir (deploy/project-template, or the operator's own bake).
 *  FAILS CLOSED: a missing or corrupt config throws (the loop skips the run and
 *  keeps the previous mirror) — silently falling back to defaults could mirror
 *  a deny-listed table into the analyst-readable lake (I2). NB the config is
 *  baked at image build: after editing allow/denyTables, rebuild BOTH images
 *  (`docker compose up -d --build server pg-mirror`) or the lists drift. */
export function loadMirrorConfig(projectDir: string): MirrorConfig {
  const file = path.join(projectDir, ".setoku", "config.json");
  let raw: { allowTables?: string[]; denyTables?: string[] };
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${file} (${(e as Error).message}) — refusing to mirror with an unknown allow/deny list`);
  }
  return {
    allowTables: raw.allowTables ?? ["public.*"],
    denyTables: raw.denyTables ?? [],
  };
}

/** Glob match for "schema.table" patterns where * matches within a segment —
 *  IDENTICAL semantics to the gateway's lib/config.ts (tested against it). */
export function tableMatches(pattern: string, qualified: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^.]*") +
      "$",
  );
  return re.test(qualified);
}

export function isTableAllowed(cfg: MirrorConfig, schema: string, table: string): boolean {
  const qualified = `${schema}.${table}`;
  if (cfg.denyTables.some((p) => tableMatches(p, qualified))) return false;
  return cfg.allowTables.some((p) => tableMatches(p, qualified));
}

/* --------------------------- type mapping --------------------------- */

/** How a value serializes into JSONEachRow for its ClickHouse column. */
export type ColKind = "plain" | "datetime" | "date" | "json" | "bytea";

export interface MirrorColumn {
  name: string;
  /** ClickHouse type, Nullable(…) already applied. */
  chType: string;
  kind: ColKind;
  /** Set for pg arrays — the element's serialization kind. */
  elemKind?: ColKind;
  nullable: boolean;
  /** pg udt name (element udt for arrays) — drives the SELECT-list cast. */
  udt: string;
  isArray: boolean;
  isEnum: boolean;
}

interface PgColumnRow {
  column_name: string;
  udt_name: string; // "_int4" for int4[]
  typtype: string; // b base, e enum, …
  elem_udt: string | null;
  elem_typtype: string | null;
  not_null: boolean;
  atttypmod: number | null; // raw typmod (numeric precision/scale packing)
}

/** The explicit pg → ClickHouse scalar map. Small on purpose: an unmapped type
 *  fails its table loudly rather than guessing (add here deliberately). */
const PG_TO_CH: Record<string, { ch: string; kind: ColKind }> = {
  int2: { ch: "Int16", kind: "plain" },
  int4: { ch: "Int32", kind: "plain" },
  int8: { ch: "Int64", kind: "plain" },
  oid: { ch: "UInt32", kind: "plain" },
  float4: { ch: "Float32", kind: "plain" },
  float8: { ch: "Float64", kind: "plain" },
  bool: { ch: "Bool", kind: "plain" },
  text: { ch: "String", kind: "plain" },
  varchar: { ch: "String", kind: "plain" },
  bpchar: { ch: "String", kind: "plain" },
  name: { ch: "String", kind: "plain" },
  citext: { ch: "String", kind: "plain" },
  uuid: { ch: "UUID", kind: "plain" },
  date: { ch: "Date32", kind: "date" },
  timestamp: { ch: "DateTime64(6)", kind: "datetime" },
  timestamptz: { ch: "DateTime64(6, 'UTC')", kind: "datetime" },
  time: { ch: "String", kind: "plain" },
  timetz: { ch: "String", kind: "plain" },
  json: { ch: "String", kind: "json" },
  jsonb: { ch: "String", kind: "json" },
  bytea: { ch: "String", kind: "bytea" },
};

/** Decode a pg numeric atttypmod → declared precision/scale. The scale lives in
 *  the low 11 bits as a SIGNED value (pg ≥ 15 allows negative scale), so it
 *  must be sign-extended — a plain mask reads numeric(5,-2) as scale 2046. */
export function numericTypmod(atttypmod: number | null): { precision: number | null; scale: number } {
  if (atttypmod == null || atttypmod < 4) return { precision: null, scale: 0 }; // bare numeric
  const packed = atttypmod - 4;
  return { precision: (packed >> 16) & 0xffff, scale: ((packed & 0x7ff) ^ 0x400) - 0x400 };
}

function scalarType(udt: string, typtype: string, atttypmod: number | null): { ch: string; kind: ColKind } {
  if (udt === "numeric") {
    // Declared precision carries over; bare `numeric` (arbitrary precision) gets
    // Decimal(38,9) — exact for money-scale values, and an out-of-range value
    // fails the reload loudly rather than silently rounding through Float64.
    const { precision, scale } = numericTypmod(atttypmod);
    if (precision == null) return { ch: "Decimal(38, 9)", kind: "plain" };
    let p = precision;
    let s = scale;
    if (s < 0) {
      p -= s; // numeric(5,-2) holds up to 7 integer digits
      s = 0;
    }
    if (s > p) p = s; // pg ≥ 15 allows scale > precision; ClickHouse doesn't
    if (p > 76) throw new Error(`numeric(${precision},${scale}) exceeds ClickHouse Decimal precision (76) — deny the table or narrow the column`);
    return { ch: `Decimal(${p}, ${s})`, kind: "plain" };
  }
  if (typtype === "e") return { ch: "LowCardinality(String)", kind: "plain" }; // pg enum
  const hit = PG_TO_CH[udt];
  if (!hit) throw new Error(`unmapped Postgres type "${udt}" — add it to PG_TO_CH in ingest/pg-mirror/mirror.ts or deny the table`);
  return hit;
}

/** Map one pg catalog column row to its mirror column, or throw (unmapped). */
export function mapColumn(c: PgColumnRow): MirrorColumn {
  const isArray = c.udt_name.startsWith("_");
  const udt = isArray ? (c.elem_udt ?? c.udt_name.slice(1)) : c.udt_name;
  const typtype = isArray ? (c.elem_typtype ?? "b") : c.typtype;
  const base = scalarType(udt, typtype, c.atttypmod);
  const nullable = !c.not_null;
  if (isArray) {
    // ClickHouse arrays can't be Nullable — a NULL pg array lands as [] (the
    // null-vs-empty distinction is lost; acceptable for analytics).
    const elem = base.ch === "Bool" ? "UInt8" : base.ch; // Array(Bool) quirks avoided
    return { name: c.column_name, chType: `Array(${elem})`, kind: "plain", elemKind: base.kind, nullable, udt, isArray, isEnum: typtype === "e" };
  }
  return {
    name: c.column_name,
    chType: nullable ? `Nullable(${base.ch})` : base.ch,
    kind: base.kind,
    nullable,
    udt,
    isArray,
    isEnum: typtype === "e",
  };
}

/* --------------------------- naming / DDL --------------------------- */

/** biz-side table name: public.orders → orders; ticketing.seat_txn → ticketing_seat_txn. */
export function bizTableName(schema: string, table: string): string {
  return schema === "public" ? table : `${schema}_${table}`;
}

/** Quote a ClickHouse identifier. */
export const chIdent = (name: string): string => "`" + name.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";

/** Quote a Postgres identifier. */
export const pgIdent = (name: string): string => '"' + name.replace(/"/g, '""') + '"';

const sqlString = (s: string): string => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

export interface MirrorTable {
  schema: string;
  name: string;
  columns: MirrorColumn[];
  pk: string[]; // primary-key column names, index order
}

/** CREATE TABLE for the staging copy. ORDER BY = the pg primary key (that's the
 *  entire tuning story); PK-less tables get ORDER BY tuple(). */
export function stagingDDL(db: string, staging: string, t: MirrorTable): string {
  const cols = t.columns.map((c) => `  ${chIdent(c.name)} ${c.chType}`).join(",\n");
  const orderBy = t.pk.length ? `(${t.pk.map(chIdent).join(", ")})` : "tuple()";
  return (
    `CREATE TABLE ${chIdent(db)}.${chIdent(staging)}\n(\n${cols}\n)\n` +
    `ENGINE = MergeTree\nORDER BY ${orderBy}\n` +
    `COMMENT ${sqlString(`mirror of ${t.schema}.${t.name} (pg-mirror, full reload)`)}`
  );
}

/** The SELECT list streamed out of pg. Timestamps/dates go out as pg TEXT (so
 *  the mirror never depends on the driver's timezone interpretation — ClickHouse
 *  parses them with best_effort). Floats go out as TEXT too: pg's shortest-exact
 *  form round-trips precisely and keeps NaN/±Infinity intact (Bun's driver
 *  collapses all three specials to NaN), and ClickHouse parses "Infinity" /
 *  "-Infinity" / "NaN" strings into real Float specials. Enum arrays cast to
 *  text[]. */
export function buildSelect(t: MirrorTable): string {
  const asText = (c: MirrorColumn): boolean =>
    c.kind === "datetime" || c.kind === "date" || c.udt === "float4" || c.udt === "float8";
  const cols = t.columns.map((c) => {
    const q = pgIdent(c.name);
    if (!c.isArray && asText(c)) return `${q}::text AS ${q}`;
    if (c.isArray && (c.isEnum || asText({ ...c, kind: c.elemKind ?? "plain" }))) return `${q}::text[] AS ${q}`;
    return q;
  });
  return `SELECT ${cols.join(", ")} FROM ${pgIdent(t.schema)}.${pgIdent(t.name)}`;
}

/* -------------------------- serialization --------------------------- */

const hex = (b: Uint8Array): string => {
  let out = "\\x";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
};

function serializeScalar(v: unknown, kind: ColKind): unknown {
  if (v === null || v === undefined) return null;
  // JSON has no NaN/Infinity (JSON.stringify would emit null → silent 0/NULL in
  // ClickHouse); the engine parses these quoted forms back into real Float
  // NaN/Inf, so pg float specials survive the trip instead of corrupting.
  if (typeof v === "number" && !Number.isFinite(v)) return Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return String(v);
  if (v instanceof Uint8Array) return kind === "bytea" ? hex(v) : String(v);
  if (kind === "json" && typeof v === "object") return JSON.stringify(v);
  return v;
}

/** One pg row → one JSONEachRow line (keys = ClickHouse column names). */
export function serializeRow(row: Record<string, unknown>, columns: MirrorColumn[]): string {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    const v = row[c.name];
    if (c.isArray) {
      // pg text[] casts arrive as JS arrays; a NULL array lands as [].
      out[c.name] = Array.isArray(v) ? v.map((x) => serializeScalar(x, c.elemKind ?? "plain")) : [];
    } else {
      out[c.name] = serializeScalar(v, c.kind);
    }
  }
  return JSON.stringify(out) + "\n";
}

/* -------------------------- ClickHouse I/O -------------------------- */

export interface ChOptions {
  url: string;
  user: string;
  password: string;
  /** Metadata database (heartbeats, pg_mirror_runs). */
  db: string;
  /** Mirror target database. */
  mirrorDb: string;
}

async function chFetch(ch: ChOptions, params: URLSearchParams, body: string, timeoutMs: number): Promise<string> {
  const res = await fetch(`${ch.url}/?${params}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${ch.user}:${ch.password}`),
      "content-type": "text/plain",
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`clickhouse HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

/** DDL / management statement (CREATE, DROP, EXCHANGE, RENAME). */
export async function chCommand(ch: ChOptions, sql: string): Promise<void> {
  await chFetch(ch, new URLSearchParams(), sql, 60_000);
}

/** SELECT returning rows (FORMAT JSON). */
export async function chSelect(ch: ChOptions, sql: string): Promise<Record<string, unknown>[]> {
  const text = await chFetch(ch, new URLSearchParams({ default_format: "JSON" }), sql, 60_000);
  if (!text) return [];
  const parsed = JSON.parse(text) as { data?: Record<string, unknown>[] };
  return parsed.data ?? [];
}

/** Stream one NDJSON batch into a table. best_effort covers pg's timestamp
 *  text ("2026-01-02 03:04:05.123456+00"); 64-bit ints and Decimals arrive as
 *  JSON strings, which ClickHouse parses natively. */
export async function chInsert(ch: ChOptions, db: string, table: string, ndjson: string): Promise<void> {
  const params = new URLSearchParams({
    query: `INSERT INTO ${chIdent(db)}.${chIdent(table)} FORMAT JSONEachRow`,
    date_time_input_format: "best_effort",
    // a null reaching a NOT NULL column is a serialization bug — fail the
    // reload loudly instead of ClickHouse silently substituting 0/''
    input_format_null_as_default: "0",
  });
  await chFetch(ch, params, ndjson, 300_000);
}

export async function beatHeartbeat(ch: ChOptions, detail: string): Promise<void> {
  const beat_at = new Date().toISOString().replace("T", " ").replace("Z", "");
  const params = new URLSearchParams({ query: `INSERT INTO ${chIdent(ch.db)}.ingest_heartbeats FORMAT JSONEachRow` });
  await chFetch(ch, params, JSON.stringify({ connector: "pg-mirror", beat_at, detail }) + "\n", 10_000);
}

/** Startup self-heal (the numbered schema files only run on a FRESH ClickHouse,
 *  same pattern as slack-listener's ensureHeartbeatTable). Idempotent. */
export async function ensureMirrorObjects(ch: ChOptions): Promise<void> {
  await chCommand(ch, `CREATE DATABASE IF NOT EXISTS ${chIdent(ch.mirrorDb)}`);
  await chCommand(
    ch,
    `CREATE TABLE IF NOT EXISTS ${chIdent(ch.db)}.ingest_heartbeats
     (connector LowCardinality(String), beat_at DateTime64(3), detail String)
     ENGINE = ReplacingMergeTree(beat_at) ORDER BY connector`,
  );
  await chCommand(
    ch,
    `CREATE TABLE IF NOT EXISTS ${chIdent(ch.db)}.pg_mirror_runs
     (started_at DateTime64(3), finished_at DateTime64(3),
      target_table LowCardinality(String), source_table String,
      rows UInt64, status LowCardinality(String), error String)
     ENGINE = MergeTree ORDER BY (finished_at, target_table)
     TTL toDateTime(finished_at) + INTERVAL 90 DAY`,
  );
}

/* ---------------------------- discovery ----------------------------- */

// Bun.sql client — kept `any`-shaped so tests can hand in a plain connection.
type Pg = { unsafe(q: string): Promise<any>; begin<T>(fn: (tx: Pg) => Promise<T>): Promise<T>; end(): Promise<void> };

/** Enumerate allowlisted, SELECT-granted base tables with columns + PK from the
 *  pg catalog. Partition children are skipped (the parent covers them); views
 *  and matviews are not mirrored. A table with an unmappable column is returned
 *  in `failed` so the run can record it loudly without blocking the rest. */
export async function discoverTables(
  pg: Pg,
  cfg: MirrorConfig,
): Promise<{ tables: MirrorTable[]; failed: { schema: string; name: string; error: string }[] }> {
  const tableRows: { schema: string; name: string }[] = await pg.unsafe(`
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND has_table_privilege(c.oid, 'SELECT')
    ORDER BY 1, 2`);
  const wanted = tableRows.filter((t) => isTableAllowed(cfg, t.schema, t.name));
  if (!wanted.length) return { tables: [], failed: [] };

  const colRows: (PgColumnRow & { table_schema: string; table_name: string })[] = await pg.unsafe(`
    SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name,
           t.typname AS udt_name, t.typtype AS typtype,
           et.typname AS elem_udt, et.typtype AS elem_typtype,
           a.attnotnull AS not_null,
           a.atttypmod AS atttypmod
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_type et ON et.oid = t.typelem AND t.typcategory = 'A'
    WHERE a.attnum > 0 AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname, a.attnum`);

  const pkRows: { table_schema: string; table_name: string; column_name: string; pos: number }[] = await pg.unsafe(`
    SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name, ord.n AS pos
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS ord(attnum, n)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ord.attnum
    WHERE i.indisprimary
    ORDER BY 1, 2, 4`);

  const key = (s: string, t: string): string => `${s}.${t}`;
  const colsByTable = new Map<string, PgColumnRow[]>();
  for (const r of colRows) {
    const k = key(r.table_schema, r.table_name);
    if (!colsByTable.has(k)) colsByTable.set(k, []);
    colsByTable.get(k)!.push(r);
  }
  const pkByTable = new Map<string, string[]>();
  for (const r of pkRows) {
    const k = key(r.table_schema, r.table_name);
    if (!pkByTable.has(k)) pkByTable.set(k, []);
    pkByTable.get(k)!.push(r.column_name);
  }

  const tables: MirrorTable[] = [];
  const failed: { schema: string; name: string; error: string }[] = [];
  for (const t of wanted) {
    const raw = colsByTable.get(key(t.schema, t.name)) ?? [];
    if (!raw.length) {
      failed.push({ schema: t.schema, name: t.name, error: "no columns visible in pg_attribute" });
      continue;
    }
    // "__staging" is the swap workspace — a source table mapping onto it would
    // have its LIVE mirror clobbered by another table's reload mid-run.
    if (bizTableName(t.schema, t.name).endsWith("__staging")) {
      failed.push({ schema: t.schema, name: t.name, error: 'mirror name ends in the reserved "__staging" suffix — rename or deny the table' });
      continue;
    }
    try {
      const columns = raw.map(mapColumn);
      // A PK column that is somehow nullable can't anchor ORDER BY — fall back.
      const pk = (pkByTable.get(key(t.schema, t.name)) ?? []).filter((name) =>
        columns.some((c) => c.name === name && !c.nullable),
      );
      tables.push({ schema: t.schema, name: t.name, columns, pk });
    } catch (e) {
      failed.push({ schema: t.schema, name: t.name, error: (e as Error).message });
    }
  }

  // biz names must be unique (public.orders vs orders.public would collide).
  const byBiz = new Map<string, MirrorTable[]>();
  for (const t of tables) {
    const b = bizTableName(t.schema, t.name);
    if (!byBiz.has(b)) byBiz.set(b, []);
    byBiz.get(b)!.push(t);
  }
  const unique: MirrorTable[] = [];
  for (const [b, group] of byBiz) {
    if (group.length === 1) {
      unique.push(group[0]);
    } else {
      for (const t of group)
        failed.push({ schema: t.schema, name: t.name, error: `mirror name collision on "${b}" — rename or deny one of the colliding tables` });
    }
  }
  return { tables: unique, failed };
}

/* ----------------------------- reload ------------------------------- */

const FETCH_ROWS = 10_000; // cursor batch out of pg
const FLUSH_BYTES = 32 * 1024 * 1024; // NDJSON buffer per ClickHouse insert

export interface TableResult {
  target: string;
  source: string;
  rows: number;
  status: "ok" | "error";
  error: string;
}

/** Reload one table: staging → stream → verify count → atomic swap. `existing`
 *  is this run's snapshot of biz tables (kept current across the run). */
export async function mirrorTable(
  pg: Pg,
  ch: ChOptions,
  t: MirrorTable,
  existing: Set<string>,
  onProgress?: (rows: number) => void,
): Promise<number> {
  const target = bizTableName(t.schema, t.name);
  const staging = `${target}__staging`;
  const db = ch.mirrorDb;

  await chCommand(ch, `DROP TABLE IF EXISTS ${chIdent(db)}.${chIdent(staging)} SYNC`);
  existing.delete(staging);
  await chCommand(ch, stagingDDL(db, staging, t));
  existing.add(staging);

  // One READ ONLY transaction per table = one consistent snapshot per table
  // (works through transaction-pooling proxies like Supabase's pooler, where a
  // session-level cursor wouldn't survive outside an explicit transaction).
  let streamed = 0;
  await pg.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ ONLY");
    await tx.unsafe(`DECLARE setoku_mirror_cur CURSOR FOR ${buildSelect(t)}`);
    let buf = "";
    for (;;) {
      const batch: Record<string, unknown>[] = await tx.unsafe(`FETCH ${FETCH_ROWS} FROM setoku_mirror_cur`);
      for (const row of batch) buf += serializeRow(row, t.columns);
      streamed += batch.length;
      if (buf.length >= FLUSH_BYTES || (batch.length < FETCH_ROWS && buf.length)) {
        await chInsert(ch, db, staging, buf);
        buf = "";
        onProgress?.(streamed);
      }
      if (batch.length < FETCH_ROWS) break;
    }
  });

  // Verify the staged copy before swapping — a mid-stream failure already threw,
  // but a silent count mismatch must never replace a good mirror.
  const counted = await chSelect(ch, `SELECT count() AS c FROM ${chIdent(db)}.${chIdent(staging)}`);
  const c = Number(counted[0]?.c ?? -1);
  if (c !== streamed) throw new Error(`row-count mismatch after load: streamed ${streamed}, staged ${c}`);

  if (existing.has(target)) {
    await chCommand(ch, `EXCHANGE TABLES ${chIdent(db)}.${chIdent(target)} AND ${chIdent(db)}.${chIdent(staging)}`);
    // staging now holds the previous copy — the swap already succeeded, so a
    // failed cleanup must not record this reload as an error (next run's
    // DROP IF EXISTS retries it).
    await chCommand(ch, `DROP TABLE IF EXISTS ${chIdent(db)}.${chIdent(staging)} SYNC`).catch((e) =>
      console.error(`pg-mirror: post-swap cleanup of ${staging} failed: ${e}`),
    );
  } else {
    await chCommand(ch, `RENAME TABLE ${chIdent(db)}.${chIdent(staging)} TO ${chIdent(db)}.${chIdent(target)}`);
    existing.add(target);
  }
  existing.delete(staging);
  return streamed;
}

const runStamp = (d: Date): string => d.toISOString().replace("T", " ").replace("Z", "");

async function recordRun(ch: ChOptions, startedAt: Date, r: TableResult): Promise<void> {
  const params = new URLSearchParams({ query: `INSERT INTO ${chIdent(ch.db)}.pg_mirror_runs FORMAT JSONEachRow` });
  const line = JSON.stringify({
    started_at: runStamp(startedAt),
    finished_at: runStamp(new Date()),
    target_table: r.target,
    source_table: r.source,
    rows: r.rows,
    status: r.status,
    error: r.error,
  });
  await chFetch(ch, params, line + "\n", 10_000);
}

/** One full mirror pass: discover → reload each table → prune stale mirrors. */
export async function runOnce(
  pg: Pg,
  ch: ChOptions,
  cfg: MirrorConfig,
  setState?: (s: string) => void,
): Promise<{ ok: number; failed: number; rows: number }> {
  const { tables, failed: discoveryFailed } = await discoverTables(pg, cfg);
  const existing = new Set<string>(
    (await chSelect(ch, `SELECT name FROM system.tables WHERE database = ${sqlString(ch.mirrorDb)}`)).map((r) => String(r.name)),
  );

  // Zero-discovery guard: an empty result usually means a transient grant loss
  // or a misrouted connection, not "mirror nothing" — pruning here would drop
  // the ENTIRE mirror and break every biz.* panel until grants recover AND a
  // full reload completes. Keep the last good copy and say so.
  if (!tables.length && !discoveryFailed.length) {
    if (existing.size)
      console.error(
        `pg-mirror: discovery returned no allowlisted tables — refusing to prune ${existing.size} existing mirror table(s) (revoked grants or misconfig? fix the source, the next pass reconciles)`,
      );
    return { ok: 0, failed: 0, rows: 0 };
  }

  const results: TableResult[] = [];
  for (const f of discoveryFailed) {
    const r: TableResult = { target: bizTableName(f.schema, f.name), source: `${f.schema}.${f.name}`, rows: 0, status: "error", error: f.error };
    results.push(r);
    console.error(`pg-mirror: ${r.source} not mirrorable: ${f.error}`);
    await recordRun(ch, new Date(), r).catch(() => {});
  }

  let n = 0;
  for (const t of tables) {
    n += 1;
    const target = bizTableName(t.schema, t.name);
    const source = `${t.schema}.${t.name}`;
    setState?.(`reloading ${target} (${n}/${tables.length})`);
    const startedAt = new Date();
    try {
      const rows = await mirrorTable(pg, ch, t, existing);
      results.push({ target, source, rows, status: "ok", error: "" });
    } catch (e) {
      // Best-effort staging cleanup; the previous good copy (if any) stays live.
      await chCommand(ch, `DROP TABLE IF EXISTS ${chIdent(ch.mirrorDb)}.${chIdent(`${target}__staging`)} SYNC`).catch(() => {});
      existing.delete(`${target}__staging`);
      results.push({ target, source, rows: 0, status: "error", error: (e as Error).message.slice(0, 500) });
      console.error(`pg-mirror: ${source} failed: ${(e as Error).message}`);
    }
    await recordRun(ch, startedAt, results[results.length - 1]).catch((e) =>
      console.error(`pg-mirror: could not record run for ${target}: ${e}`),
    );
  }

  // Prune mirrors whose source vanished or left the allowlist — revoking a
  // table's grant removes its lake copy on the next pass (the mirror must
  // never OUTLIVE what the postgres path allows). Failed tables stay: their
  // target is still in the discovered set.
  const keep = new Set([...tables, ...discoveryFailed.map((f) => ({ schema: f.schema, name: f.name }))].map((t) => bizTableName(t.schema, t.name)));
  for (const name of existing) {
    if (keep.has(name)) continue;
    console.error(`pg-mirror: pruning ${ch.mirrorDb}.${name} (no longer allowlisted or gone from source)`);
    await chCommand(ch, `DROP TABLE IF EXISTS ${chIdent(ch.mirrorDb)}.${chIdent(name)} SYNC`).catch((e) =>
      console.error(`pg-mirror: prune of ${name} failed: ${e}`),
    );
  }

  const ok = results.filter((r) => r.status === "ok");
  const rows = ok.reduce((a, r) => a + r.rows, 0);
  return { ok: ok.length, failed: results.length - ok.length, rows };
}

/* ------------------------------- main -------------------------------- */

/** postgres URL → Bun.sql options. Handles libpq-style `?host=/socket/dir`
 *  (tests) and mirrors the gateway's TLS heuristic (lib/db.ts): local and
 *  compose-network hosts skip TLS; anything else encrypts, with cert
 *  verification opt-in via SETOKU_PG_SSL_STRICT=1. */
export function pgOptions(raw: string): Record<string, unknown> {
  const u = new URL(raw);
  const opts: Record<string, unknown> = { max: 1 };
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (db) opts.database = db;
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  const hostParam = u.searchParams.get("host"); // libpq-style: socket dir or hostname
  if (hostParam?.startsWith("/")) {
    opts.path = path.join(hostParam, `.s.PGSQL.${u.port || "5432"}`);
    return opts;
  }
  const host = u.hostname || hostParam || "localhost";
  opts.hostname = host;
  opts.port = Number(u.port || "5432");
  const local =
    host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    host.endsWith(".internal") || host.endsWith(".local") || !host.includes(".");
  const sslmode = u.searchParams.get("sslmode");
  if (!local && sslmode !== "disable") {
    opts.tls = process.env.SETOKU_PG_SSL_STRICT === "1" ? true : { rejectUnauthorized: false };
  }
  return opts;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`pg-mirror: ${name} is required`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const DB_URL = required("SETOKU_DATABASE_URL");
  const INTERVAL = Number(process.env.SETOKU_MIRROR_INTERVAL_MS ?? 900_000);
  const PROJECT_DIR = process.env.SETOKU_PROJECT_DIR ?? "/project";
  const ch: ChOptions = {
    url: process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
    user: process.env.CLICKHOUSE_USER ?? "setoku",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    db: process.env.CLICKHOUSE_DB ?? "setoku",
    // "biz" is a contract, not a knob: the gateway's steering/freshness surfaces
    // and the setoku_ro grant all name it (deploy/clickhouse/lake-users.xml).
    mirrorDb: "biz",
  };
  const cfg = loadMirrorConfig(PROJECT_DIR); // fail-fast at startup (fails closed)
  console.error(
    `pg-mirror: full reload every ${INTERVAL}ms → ${ch.url} db ${ch.mirrorDb} ` +
      `(allow ${JSON.stringify(cfg.allowTables)}, deny ${JSON.stringify(cfg.denyTables)})`,
  );

  await ensureMirrorObjects(ch);

  // Liveness beats on their own timer so a long reload still reads "flowing"
  // (<10 min beat) on the Sources page; detail carries what the loop is doing.
  let state = "starting";
  const beat = (): void => {
    beatHeartbeat(ch, state).catch((e) => console.error(`pg-mirror: heartbeat failed: ${e}`));
  };
  beat();
  setInterval(beat, 60_000);

  for (;;) {
    const t0 = Date.now();
    try {
      const pg = new SQL(pgOptions(DB_URL)) as unknown as Pg;
      try {
        // Re-read per tick (fails closed — a broken config skips the run and
        // keeps the previous mirror) so a bind-mounted /project picks up
        // allow/deny edits without a restart.
        const r = await runOnce(pg, ch, loadMirrorConfig(PROJECT_DIR), (s) => {
          state = s;
        });
        state = r.failed
          ? `partial: ${r.ok} table(s) ok, ${r.failed} failed — see setoku.pg_mirror_runs`
          : `ok: ${r.ok} table(s), ${r.rows} row(s) in ${Math.round((Date.now() - t0) / 1000)}s`;
        console.error(`pg-mirror: ${state}`);
      } finally {
        await pg.end().catch(() => {});
      }
    } catch (e) {
      state = `run failed: ${String(e).slice(0, 200)}`;
      console.error(`pg-mirror: ${state}`);
    }
    beat();
    await Bun.sleep(INTERVAL);
  }
}

if (import.meta.main) void main();
