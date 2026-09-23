#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Business-DB → lake mirror (issue #47). Mirrors every allowlisted Postgres
 * table into the bundled ClickHouse on a poller-style loop, so heavy app panels
 * read the mirror (`biz.*`, clickhouse dialect) instead of seq-scanning prod.
 * Per table, per run:
 *
 *   1. derive DDL from the pg catalog (explicit type map — unmapped types fail
 *      that table LOUDLY, they never guess),
 *   2. skip the table if it is verifiably UNCHANGED since its last successful
 *      reload — the pg_stat_user_tables write counters plus the mirrored shape
 *      haven't moved (see `fetchChangeCounters`/`schemaSignature`). The check
 *      costs one tiny stats read instead of restreaming the table, which is
 *      what keeps prod egress (metered on hosted Postgres — the Supabase
 *      overage of 2026-07) proportional to CHANGE, not to size × cadence.
 *      A skip is recorded as status "unchanged" in `setoku.pg_mirror_runs`
 *      (the mirror provably equals the source, so freshness advances). On a
 *      hot standby the counters only see the standby's OWN writes (always 0),
 *      so the skip is disabled there — it would freeze the mirror forever,
 *   3. a table that DID change is pulled INCREMENTALLY when it can be (see
 *      "Incremental pull" below): only rows written since the last pass, by
 *      Postgres `xmin`, upserted into a ReplacingMergeTree — otherwise
 *   4. it is FULLY reloaded: create `biz.<table>__staging` and SELECT-stream
 *      rows in through a cursor (bounded memory) using the SAME read-only role
 *      the gateway queries with — the allow/deny list and the role's grants
 *      are inherited, so a table denied to run_query never leaves prod
 *      (I1/I2 unchanged) — verify the staged row count, then atomically
 *      EXCHANGE/RENAME into place (readers never see a half-loaded table),
 *   5. record the pass in `setoku.pg_mirror_runs` (freshness + failure
 *      legibility for /healthz, /admin, and the app frame's "as of" stamp;
 *      `mode` says full vs incremental) and beat `ingest_heartbeats` like
 *      every other connector.
 *
 * Incremental pull (schema-agnostic — no updatedAt/createdAt convention):
 * every heap row carries `xmin`, the id of the transaction that last wrote it.
 * Each pass runs in one REPEATABLE READ snapshot and remembers that
 * snapshot's xmin — the oldest transaction still running, so every row
 * version the snapshot could NOT see (including rows written under a
 * SAVEPOINT, whose subxids `pg_visible_in_snapshot` misjudges) has
 * xmin ≥ it. The next pass fetches only rows with xmin ≥ that boundary,
 * compared modulo 2^32 so xid wraparound is a non-event. Deletes, TRUNCATE
 * and key changes leave no xmin behind, so every incremental pass also
 * compares `count(*)` (same snapshot) with the mirror's `count() FINAL` —
 * any difference falls back to a full reload in the same pass. A mirror that
 * absorbed deltas is also fully reloaded once a day as a backstop: nightly in
 * the quiet window if there is one (SETOKU_MIRROR_RECONCILE_HOURS).
 * Eligible: a plain-heap table (or partitioned table of heap leaves) with a
 * primary key — or a unique index over NOT NULL columns — of exact key types,
 * on Postgres ≥ 13. Anything else keeps the full-reload path, so a deploy we
 * can't read xmin from (views, FDWs, Postgres-compatible engines) behaves
 * exactly as before. Readers dedupe via `final=1` on the setoku_readonly
 * ClickHouse profile (deploy/clickhouse/lake-users.xml).
 *
 * Full reload stays the fallback = no CDC, no replication slots; schema drift
 * is a non-event (a DDL-only change defeats both the unchanged-skip and the
 * incremental path via the shape signature, so the next pass reloads), and a
 * table dropped from prod or from the allowlist is pruned from the mirror on
 * the next run. Mirrored tables are re-derivable from prod, so `biz` is
 * deliberately a SEPARATE ClickHouse database: excluded from clickhouse-backup
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
 *   SETOKU_MIRROR_QUIET_HOURS  "23-8": wall-clock hours [start, end) that use the
 *                              quiet interval instead (wraps past midnight when
 *                              start > end); unset = one cadence all day
 *   SETOKU_MIRROR_QUIET_INTERVAL_MS  default 7200000 (2 h) — cadence inside the quiet window
 *   SETOKU_MIRROR_DAILY_BYTES_CAP    unset/0 = off — once today's (UTC) ledger bytes
 *                              reach this, the pass stops between tables and
 *                              further passes are skipped until midnight UTC.
 *                              Overshoot is bounded by one table's reload.
 *   TZ                         default UTC — timezone the quiet window is read in
 *   SETOKU_MIRROR_INCREMENTAL  default on; "0" = full reloads only (no xmin pulls)
 *   SETOKU_MIRROR_RECONCILE_HOURS    default 24; "0" = never — the backstop: a
 *                              mirror that absorbed deltas gets a full reload
 *                              in the first pass of each quiet window (when
 *                              SETOKU_MIRROR_QUIET_HOURS is set), else once
 *                              its last full reload is this many hours old
 *   SETOKU_MIRROR_DENY_COLUMNS extra denyColumns patterns, comma-separated — the
 *                              per-box channel for column names that must not
 *                              land in the repo-baked config template (I3)
 *   SETOKU_PROJECT_DIR         default /project — reads .setoku/config.json for allow/denyTables/denyColumns
 *   SETOKU_PG_SSL_STRICT       "1" = verify TLS certs (default: encrypt, don't verify — matches gateway lib/db.ts)
 */
import fs from "node:fs";
import path from "node:path";
import { SQL } from "bun";

/* ------------------------------ config ------------------------------ */

export interface MirrorConfig {
  allowTables: string[];
  denyTables: string[];
  /** "schema.table.column" globs whose columns are left out of the mirror.
   *  An egress/size control, NOT a security boundary: access is enforced by
   *  the engines' grants (I9), and an excluded column stays readable at the
   *  source via `run_query force_postgres`. Because the mirror is a full
   *  reload, un-excluding a column is one config edit — the next pass
   *  repopulates it completely. */
  denyColumns: string[];
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
  let raw: { allowTables?: string[]; denyTables?: string[]; denyColumns?: string[] };
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${file} (${(e as Error).message}) — refusing to mirror with an unknown allow/deny list`);
  }
  // SETOKU_MIRROR_DENY_COLUMNS merges IN (never replaces): the baked template is
  // generic, but real column names are tenant data that can't live in the repo
  // (I3) — the box's .env (rsync-excluded, survives deploys) carries them.
  const envDeny = (process.env.SETOKU_MIRROR_DENY_COLUMNS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    allowTables: raw.allowTables ?? ["public.*"],
    denyTables: raw.denyTables ?? [],
    denyColumns: [...(raw.denyColumns ?? []), ...envDeny],
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

/** Column-level exclusion: "schema.table.column" with the same glob semantics
 *  (* stays within one dot-segment). See MirrorConfig.denyColumns. */
export function isColumnDenied(cfg: MirrorConfig, schema: string, table: string, column: string): boolean {
  const qualified = `${schema}.${table}.${column}`;
  return cfg.denyColumns.some((p) => tableMatches(p, qualified));
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
  // Nullable nests INSIDE LowCardinality — ClickHouse rejects
  // Nullable(LowCardinality(String)) but accepts LowCardinality(Nullable(String)).
  // Hit in the wild by nullable pg enum columns (Prisma optional enums).
  const nullify = (t: string): string =>
    t.startsWith("LowCardinality(") ? `LowCardinality(Nullable(${t.slice("LowCardinality(".length, -1)}))` : `Nullable(${t})`;
  return {
    name: c.column_name,
    chType: nullable ? nullify(base.ch) : base.ch,
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
  /** Row-identity key, index order: the primary key, else the narrowest unique
   *  index over NOT NULL columns; [] when neither exists (or a key column is
   *  deny-listed — a partial key would merge distinct rows). */
  pk: string[];
  /** Pulled by xmin into a ReplacingMergeTree (see "Incremental pull" in the
   *  header) instead of full-reloaded on every change. Set by discovery. */
  incremental?: boolean;
}

/** CREATE TABLE for the staging copy. ORDER BY = the pg primary key (that's the
 *  entire tuning story); PK-less tables get ORDER BY tuple(). Every row also
 *  carries `_mirrored_at` (DEFAULT-filled at load, constant per batch so it
 *  compresses to nothing) — when that row version was last pulled, queryable
 *  inline without knowing about pg_mirror_runs. Skipped, loudly, if the source
 *  already has a column of that name (such a table can't go incremental: the
 *  stamp is its ReplacingMergeTree version). Incremental tables are
 *  ReplacingMergeTree keyed on the pg key, so an upserted row version
 *  replaces the old one — readers see one row per key via `final=1`. */
export function stagingDDL(db: string, staging: string, t: MirrorTable): string {
  const colDefs = t.columns.map((c) => `  ${chIdent(c.name)} ${c.chType}`);
  if (!t.columns.some((c) => c.name === "_mirrored_at")) {
    colDefs.push("  `_mirrored_at` DateTime64(3) DEFAULT now64(3)");
  } else {
    console.error(`pg-mirror: ${t.schema}.${t.name} has its own _mirrored_at column — skipping the freshness stamp`);
  }
  const orderBy = t.pk.length ? `(${t.pk.map(chIdent).join(", ")})` : "tuple()";
  const engine = t.incremental ? "ReplacingMergeTree(`_mirrored_at`)" : "MergeTree";
  return (
    `CREATE TABLE ${chIdent(db)}.${chIdent(staging)}\n(\n${colDefs.join(",\n")}\n)\n` +
    `ENGINE = ${engine}\nORDER BY ${orderBy}\n` +
    `COMMENT ${sqlString(`mirror of ${t.schema}.${t.name} (pg-mirror, ${t.incremental ? "incremental" : "full reload"})`)}`
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

/** A timestamp for the metadata tables: ISO with an explicit Z, parsed
 *  best_effort (see metaInsert). A zone-less "YYYY-MM-DD HH:MM:SS" would be
 *  read in the ClickHouse SERVER's timezone — on a non-UTC server every
 *  instant shifts by its offset, and a value read back and re-saved (full_at)
 *  keeps shifting on every pass. */
const runStamp = (d: Date): string => d.toISOString();

/** Insert rows into a metadata table, parsing timestamps by their offset. */
async function metaInsert(ch: ChOptions, table: string, rows: Record<string, unknown>[], timeoutMs = 10_000): Promise<void> {
  const params = new URLSearchParams({
    query: `INSERT INTO ${chIdent(ch.db)}.${chIdent(table)} FORMAT JSONEachRow`,
    date_time_input_format: "best_effort",
  });
  await chFetch(ch, params, rows.map((r) => JSON.stringify(r) + "\n").join(""), timeoutMs);
}

export async function beatHeartbeat(ch: ChOptions, detail: string): Promise<void> {
  await metaInsert(ch, "ingest_heartbeats", [{ connector: "pg-mirror", beat_at: runStamp(new Date()), detail }]);
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
  await chCommand(
    ch,
    `CREATE TABLE IF NOT EXISTS ${chIdent(ch.db)}.pg_mirror_state
     (target LowCardinality(String), source String, signature String, checked_at DateTime64(3))
     ENGINE = ReplacingMergeTree(checked_at) ORDER BY target`,
  );
  // The mirror's effective cadence + live state, published for the gateway
  // (/admin Sources reads it back — the server can't see this container's env).
  await chCommand(
    ch,
    `CREATE TABLE IF NOT EXISTS ${chIdent(ch.db)}.pg_mirror_settings
     (key LowCardinality(String), value String, updated_at DateTime64(3))
     ENGINE = ReplacingMergeTree(updated_at) ORDER BY key`,
  );
  // Existing boxes predate the bytes column (the numbered schema files only run
  // on a fresh ClickHouse) — idempotent in-place migration, like store.ts's
  // ensureColumn.
  await chCommand(ch, `ALTER TABLE ${chIdent(ch.db)}.pg_mirror_runs ADD COLUMN IF NOT EXISTS bytes UInt64 AFTER rows`);
  await chCommand(ch, `ALTER TABLE ${chIdent(ch.db)}.pg_mirror_runs ADD COLUMN IF NOT EXISTS mode LowCardinality(String)`);
  await chCommand(ch, `ALTER TABLE ${chIdent(ch.db)}.pg_mirror_runs ADD COLUMN IF NOT EXISTS drift Nullable(UInt64)`);
  // Incremental bookkeeping: the xmin boundary the next pass pulls from, and
  // when the table was last FULLY reloaded (the reconcile backstop).
  await chCommand(ch, `ALTER TABLE ${chIdent(ch.db)}.pg_mirror_state ADD COLUMN IF NOT EXISTS cursor String`);
  await chCommand(ch, `ALTER TABLE ${chIdent(ch.db)}.pg_mirror_state ADD COLUMN IF NOT EXISTS full_at DateTime64(3)`);
  await chCommand(ch, `ALTER TABLE ${chIdent(ch.db)}.pg_mirror_state ADD COLUMN IF NOT EXISTS deltas UInt32`);
}

/** Upsert settings/state rows (latest updated_at wins per key). */
export async function publishSettings(ch: ChOptions, kv: Record<string, string>): Promise<void> {
  const updated_at = runStamp(new Date());
  const ndjson = Object.entries(kv)
    .map(([key, value]) => JSON.stringify({ key, value, updated_at }))
    .join("\n");
  await chInsert(ch, ch.db, "pg_mirror_settings", ndjson + "\n");
}

/** Today's (UTC) ledger total — the mirror's own view of what it pulled. */
export async function todayLedgerBytes(ch: ChOptions): Promise<number> {
  const rows = await chSelect(
    ch,
    `SELECT sum(bytes) AS bytes FROM ${chIdent(ch.db)}.pg_mirror_runs WHERE toDate(finished_at) = today()`,
  );
  return Number(rows[0]?.bytes ?? 0);
}

/* ---------------------------- discovery ----------------------------- */

// Bun.sql client — kept `any`-shaped so tests can hand in a plain connection.
type Pg = { unsafe(q: string): Promise<any>; begin<T>(fn: (tx: Pg) => Promise<T>): Promise<T>; end(): Promise<void> };

/** What the source server can do, read once per pass. */
export interface ServerInfo {
  /** server_version_num (150001 for 15.1); 0 when unreadable. */
  version: number;
  /** A hot standby: pg_stat write counters never move there. */
  replica: boolean;
}

/** Fails soft: a Postgres-compatible engine that can't answer gets version 0
 *  (no incremental) and replica false (today's behavior). */
export async function fetchServerInfo(pg: Pg): Promise<ServerInfo> {
  try {
    const rows: { v: number | string; r: boolean }[] = await pg.unsafe(
      `SELECT current_setting('server_version_num')::int AS v, pg_is_in_recovery() AS r`,
    );
    return { version: Number(rows[0]?.v ?? 0) || 0, replica: rows[0]?.r === true };
  } catch {
    return { version: 0, replica: false };
  }
}

/** xmin + pg_current_snapshot()/xid8 arrived in Postgres 13. */
export const INCREMENTAL_MIN_VERSION = 130000;

/** Key column types whose pg → ClickHouse mapping is exact, so two distinct pg
 *  keys can never collapse into one mirror row. (Floats and bare numeric round
 *  or truncate; arrays/json aren't keys.) */
const EXACT_KEY_UDTS = new Set([
  "int2", "int4", "int8", "oid", "text", "varchar", "bpchar", "name", "citext", "uuid", "bool",
  "date", "timestamp", "timestamptz",
]);
const exactKeyColumn = (c: MirrorColumn): boolean => !c.isArray && !c.nullable && (c.isEnum || EXACT_KEY_UDTS.has(c.udt));

/** The mirror's row identity: the primary key if every column of it made it
 *  into the mirror, else the narrowest unique index whose columns all did AND
 *  are NOT NULL (pg unique indexes let NULLs repeat). A key missing a column —
 *  deny-listed, say — is no key at all: ordering by part of it is harmless for
 *  MergeTree, but a ReplacingMergeTree would merge distinct rows. */
export function chooseKey(indexes: [string, { isPk: boolean; cols: string[] }][], columns: MirrorColumn[]): string[] {
  const usable = (cols: string[]): boolean => cols.length > 0 && cols.every((n) => columns.some((c) => c.name === n && !c.nullable));
  const pk = indexes.find(([, ix]) => ix.isPk);
  if (pk && usable(pk[1].cols)) return pk[1].cols;
  const unique = indexes
    .filter(([, ix]) => !ix.isPk && usable(ix.cols))
    .sort(([an, a], [bn, b]) => a.cols.length - b.cols.length || an.localeCompare(bn));
  return unique[0]?.[1].cols ?? [];
}

/** Enumerate allowlisted, SELECT-granted base tables with columns + key from
 *  the pg catalog. Partition children are skipped (the parent covers them);
 *  views and matviews are not mirrored. A table with an unmappable column is
 *  returned in `failed` so the run can record it loudly without blocking the
 *  rest. `incremental: false` (or a server below Postgres 13) keeps every
 *  table on the full-reload path. */
export async function discoverTables(
  pg: Pg,
  cfg: MirrorConfig,
  opts: { incremental?: boolean; server?: ServerInfo } = {},
): Promise<{ tables: MirrorTable[]; failed: { schema: string; name: string; error: string }[] }> {
  const server = opts.server ?? (await fetchServerInfo(pg));
  const allowIncremental = opts.incremental !== false && server.version >= INCREMENTAL_MIN_VERSION;
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

  // Primary keys plus plain unique indexes (no predicate, no expressions,
  // valid) — the fallback identity for PK-less tables (common for ORM-made
  // token/join tables). Only KEY columns count: INCLUDE columns (pg ≥ 11)
  // don't make a row unique.
  const keyAtts = server.version >= 110000 ? "AND ord.n <= i.indnkeyatts" : "";
  const idxRows: { table_schema: string; table_name: string; index_name: string; is_pk: boolean; column_name: string; pos: number }[] =
    await pg.unsafe(`
    SELECT n.nspname AS table_schema, c.relname AS table_name, ic.relname AS index_name,
           i.indisprimary AS is_pk, a.attname AS column_name, ord.n AS pos
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS ord(attnum, n)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ord.attnum
    WHERE (i.indisprimary OR (i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL))
      ${keyAtts}
    ORDER BY 1, 2, 3, 6`);

  // Which tables store rows in plain heap (where xmin means "last writer"): a
  // heap table, or a partitioned table whose every leaf is one. Catalog shape
  // differs by version (relam ≥ 12, pg_partition_tree ≥ 12), so this only runs
  // where incremental is possible at all, and a failure just means "no".
  const heap = new Set<string>();
  if (allowIncremental) {
    const heapRows: { schema: string; name: string }[] = await pg
      .unsafe(`
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_am am ON am.oid = c.relam
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND CASE WHEN c.relkind = 'r' THEN coalesce(am.amname = 'heap', false)
                 ELSE NOT EXISTS (
                   SELECT 1 FROM pg_partition_tree(c.oid) pt
                   JOIN pg_class lc ON lc.oid = pt.relid
                   LEFT JOIN pg_am la ON la.oid = lc.relam
                   WHERE pt.isleaf AND (lc.relkind <> 'r' OR coalesce(la.amname, '') <> 'heap'))
            END`)
      .catch((e: unknown) => {
        console.error(`pg-mirror: heap-storage check failed, incremental disabled this pass: ${e}`);
        return [];
      });
    for (const r of heapRows) heap.add(`${r.schema}.${r.name}`);
  }

  const key = (s: string, t: string): string => `${s}.${t}`;
  const colsByTable = new Map<string, PgColumnRow[]>();
  for (const r of colRows) {
    const k = key(r.table_schema, r.table_name);
    if (!colsByTable.has(k)) colsByTable.set(k, []);
    colsByTable.get(k)!.push(r);
  }
  // table → index name → { is_pk, columns in key order }
  const idxByTable = new Map<string, Map<string, { isPk: boolean; cols: string[] }>>();
  for (const r of idxRows) {
    const k = key(r.table_schema, r.table_name);
    if (!idxByTable.has(k)) idxByTable.set(k, new Map());
    const byName = idxByTable.get(k)!;
    if (!byName.has(r.index_name)) byName.set(r.index_name, { isPk: r.is_pk === true, cols: [] });
    byName.get(r.index_name)!.cols.push(r.column_name);
  }

  const tables: MirrorTable[] = [];
  const failed: { schema: string; name: string; error: string }[] = [];
  for (const t of wanted) {
    const rawAll = colsByTable.get(key(t.schema, t.name)) ?? [];
    if (!rawAll.length) {
      failed.push({ schema: t.schema, name: t.name, error: "no columns visible in pg_attribute" });
      continue;
    }
    // Deny-listed columns drop out BEFORE type mapping — excluding a column
    // with an unmappable type (interval, custom composites) is also the
    // lightest way to make its table mirrorable.
    const raw = rawAll.filter((c) => !isColumnDenied(cfg, t.schema, t.name, c.column_name));
    if (!raw.length) {
      failed.push({ schema: t.schema, name: t.name, error: "every column is deny-listed (denyColumns) — re-allow at least one or deny the table" });
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
      const pk = chooseKey([...(idxByTable.get(key(t.schema, t.name))?.entries() ?? [])], columns);
      const incremental =
        allowIncremental &&
        heap.has(key(t.schema, t.name)) &&
        pk.length > 0 &&
        pk.every((name) => exactKeyColumn(columns.find((c) => c.name === name)!)) &&
        !columns.some((c) => c.name === "_mirrored_at"); // the stamp is the ReplacingMergeTree version
      tables.push({ schema: t.schema, name: t.name, columns, pk, incremental });
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

/* ------------------------ unchanged detection ------------------------ */

/** Shape signature of the mirrored copy — column names/types + the ORDER BY
 *  key, plus the engine for incremental tables. Folded into the change
 *  signature so DDL-only drift (ADD COLUMN, a denyColumns edit) still reloads a
 *  table whose tuple counters are quiet, and gates the incremental path: rows
 *  are only ever upserted into a mirror built with the SAME shape (a flip
 *  between MergeTree and ReplacingMergeTree always goes through a full
 *  reload). Full-reload tables hash exactly as they always have, so this
 *  engine flag costs them no reload. Bun.hash (Wyhash) is stable per Bun
 *  version; a Bun upgrade at worst costs one spurious full reload. */
export function schemaSignature(t: MirrorTable): string {
  const shape: unknown[] = [t.columns.map((c) => [c.name, c.chType]), t.pk];
  if (t.incremental) shape.push("replacing");
  return Bun.hash(JSON.stringify(shape)).toString(36);
}

const pgString = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

/** Cumulative write counters for one table from pg_stat_user_tables, or null
 *  when pg has no stats row — the skip is then disabled and the table reloads
 *  (never guess). n_live_tup is included because TRUNCATE moves no
 *  ins/upd/del counter; its analyze-driven estimate drift can only cause a
 *  spurious reload, never a missed change (counters are monotonic, and a
 *  stats reset changes the string too). Stats views aren't privilege-gated,
 *  so the read-only role sees them. Meaningless on a hot standby (they count
 *  only the standby's own writes) — runOnce never calls this there. */
export async function fetchChangeCounters(pg: Pg, schema: string, name: string): Promise<string | null> {
  const rows: { sig: string }[] = await pg.unsafe(
    `SELECT n_tup_ins::text || ':' || n_tup_upd::text || ':' || n_tup_del::text || ':' || n_live_tup::text AS sig
     FROM pg_stat_user_tables WHERE schemaname = ${pgString(schema)} AND relname = ${pgString(name)}`,
  );
  return rows[0]?.sig ?? null;
}

/** What the CURRENT mirror of one table was built from. */
export interface MirrorState {
  /** `<shape>/<counters>` at the last reload or verified-unchanged check. */
  signature: string;
  /** Incremental tables: the xmin boundary (a decimal xid8) the next pass
   *  pulls from. "" = none — the next change full-reloads. */
  cursor: string;
  /** Epoch ms of the last FULL reload (0 = unknown) — the reconcile clock. */
  fullAt: number;
  /** Incremental pulls that moved rows since that full reload. 0 = the mirror
   *  is exactly a full reload (nothing to reconcile). */
  deltas: number;
}

/** Last stored state per biz target. ReplacingMergeTree keyed on target; FINAL
 *  collapses to the latest. */
export async function loadMirrorState(ch: ChOptions): Promise<Map<string, MirrorState>> {
  const rows = await chSelect(
    ch,
    `SELECT target, signature, cursor, toUnixTimestamp64Milli(full_at) AS full_at, deltas FROM ${chIdent(ch.db)}.pg_mirror_state FINAL`,
  );
  return new Map(
    rows.map((r) => [
      String(r.target),
      { signature: String(r.signature), cursor: String(r.cursor ?? ""), fullAt: Number(r.full_at ?? 0) || 0, deltas: Number(r.deltas ?? 0) || 0 },
    ]),
  );
}

/** Writes the WHOLE state row — the table keeps only the latest row per
 *  target, so a re-stamp that dropped the cursor would silently cost the next
 *  change a full reload. */
async function saveMirrorState(ch: ChOptions, target: string, source: string, st: MirrorState): Promise<void> {
  await metaInsert(ch, "pg_mirror_state", [
    {
      target,
      source,
      signature: st.signature,
      cursor: st.cursor,
      full_at: runStamp(new Date(st.fullAt)),
      deltas: st.deltas,
      checked_at: runStamp(new Date()),
    },
  ]);
}

/* ----------------------------- reload ------------------------------- */

const FETCH_ROWS = 10_000; // cursor batch out of pg
const FLUSH_BYTES = 32 * 1024 * 1024; // NDJSON buffer per ClickHouse insert

export interface TableResult {
  target: string;
  source: string;
  rows: number;
  /** NDJSON bytes streamed for this pass — a close proxy for what the copy
   *  pulled OUT of the source database, which is what hosted-Postgres vendors
   *  meter as egress. 0 on unchanged; on error, what had already streamed
   *  before the failure (a failing table retries every pass, so those bytes
   *  are the ledger's most important entries). Queryable per table/day from
   *  setoku.pg_mirror_runs without any vendor usage API. */
  bytes: number;
  /** "unchanged" = the source verifiably didn't move since the last reload —
   *  no restream, but the mirror is known current as of this check. */
  /** "capped" = skipped because the daily egress budget was already spent. */
  status: "ok" | "error" | "unchanged" | "capped";
  error: string;
  /** How an ok/error pass pulled: every row ("full", or "reconcile" when the
   *  daily backstop forced it), or only rows past the xmin boundary. "" for
   *  unchanged/capped (nothing pulled). */
  mode: "full" | "reconcile" | "incremental" | "";
  /** Reconcile only: rows the fresh copy disagreed with the caught-up
   *  incremental mirror on (missing + extra + changed). 0 = the incremental
   *  path was exact; null = not measured. */
  drift?: number | null;
}

/** Every mirror read runs in one REPEATABLE READ, READ ONLY transaction: one
 *  snapshot for the whole table (the cursor, the count, and the xmin boundary
 *  all agree), and it works through transaction-pooling proxies like
 *  Supabase's pooler, where a session-level cursor wouldn't survive outside
 *  an explicit transaction. Allowed on a hot standby too. */
const SNAPSHOT_TXN = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY";

/** The snapshot's xmin — the oldest transaction still running when it was
 *  taken — as a decimal xid8. Every row version this snapshot can't see was
 *  written by that transaction or a later one (a SAVEPOINT's subxid is always
 *  above its parent's xid), so it is the next pass's safe lower bound. */
async function snapshotBoundary(tx: Pg): Promise<{ xmin: bigint; xmax: bigint }> {
  const rows: { lo: string; hi: string }[] = await tx.unsafe(
    `SELECT pg_snapshot_xmin(s)::text AS lo, pg_snapshot_xmax(s)::text AS hi FROM (SELECT pg_current_snapshot() AS s) q`,
  );
  return { xmin: BigInt(rows[0].lo), xmax: BigInt(rows[0].hi) };
}

/** Stream a SELECT through a cursor into a ClickHouse table as NDJSON. The
 *  tally advances per FETCH, not per flush: those bytes left the source DB
 *  (the billable event) the moment the cursor returned them, so a throw
 *  anywhere past that point — including before the first ClickHouse flush —
 *  must not erase them from the ledger. */
async function streamInto(
  tx: Pg,
  ch: ChOptions,
  t: MirrorTable,
  select: string,
  table: string,
  tally: { bytes: number },
  onProgress?: (rows: number) => void,
): Promise<{ rows: number; bytes: number }> {
  await tx.unsafe(`DECLARE setoku_mirror_cur CURSOR FOR ${select}`);
  let streamed = 0;
  let bytes = 0;
  let buf = "";
  for (;;) {
    const batch: Record<string, unknown>[] = await tx.unsafe(`FETCH ${FETCH_ROWS} FROM setoku_mirror_cur`);
    let chunk = "";
    for (const row of batch) chunk += serializeRow(row, t.columns);
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    buf += chunk;
    bytes += chunkBytes;
    tally.bytes += chunkBytes;
    streamed += batch.length;
    if (buf.length >= FLUSH_BYTES || (batch.length < FETCH_ROWS && buf.length)) {
      await chInsert(ch, ch.mirrorDb, table, buf);
      buf = "";
      onProgress?.(streamed);
    }
    if (batch.length < FETCH_ROWS) break;
  }
  await tx.unsafe("CLOSE setoku_mirror_cur");
  return { rows: streamed, bytes };
}

/** Full reload of one table: staging → stream → verify count → atomic swap.
 *  `existing` is this run's snapshot of biz tables (kept current across the
 *  run). An incremental table also returns the boundary its NEXT pass pulls
 *  from. */
export async function mirrorTable(
  pg: Pg,
  ch: ChOptions,
  t: MirrorTable,
  existing: Set<string>,
  opts?: {
    onProgress?: (rows: number) => void;
    /** Incremented as each cursor FETCH lands, so the caller still knows what
     *  was pulled out of the source when the reload THROWS — a
     *  failed-and-retrying stream is the most expensive egress there is, and
     *  the ledger must see it even when the failure hits before the first
     *  ClickHouse flush. */
    tally?: { bytes: number };
    /** Runs on the verified staging copy just before it replaces an EXISTING
     *  mirror (the reconcile drift check). Must not throw on its own account —
     *  a failure here fails the reload. */
    beforeSwap?: (staging: string) => Promise<void>;
  },
): Promise<{ rows: number; bytes: number; cursor: string }> {
  const target = bizTableName(t.schema, t.name);
  const staging = `${target}__staging`;
  const db = ch.mirrorDb;

  await chCommand(ch, `DROP TABLE IF EXISTS ${chIdent(db)}.${chIdent(staging)} SYNC`);
  existing.delete(staging);
  await chCommand(ch, stagingDDL(db, staging, t));
  existing.add(staging);

  const tally = opts?.tally ?? { bytes: 0 };
  let cursor = "";
  const { rows: streamed, bytes } = await pg.begin(async (tx) => {
    await tx.unsafe(SNAPSHOT_TXN);
    if (t.incremental) cursor = String((await snapshotBoundary(tx)).xmin);
    return streamInto(tx, ch, t, buildSelect(t), staging, tally, opts?.onProgress);
  });

  // Verify the staged copy before swapping — a mid-stream failure already threw,
  // but a silent count mismatch must never replace a good mirror.
  const counted = await chSelect(ch, `SELECT count() AS c FROM ${chIdent(db)}.${chIdent(staging)}`);
  const c = Number(counted[0]?.c ?? -1);
  if (c !== streamed) throw new Error(`row-count mismatch after load: streamed ${streamed}, staged ${c}`);

  if (existing.has(target)) {
    await opts?.beforeSwap?.(staging);
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
  return { rows: streamed, bytes, cursor };
}

/** The delta filter: xmin within [from, snapshot xmax) modulo 2^32. xmin is a
 *  32-bit xid that wraps; any row version the snapshot can see was written
 *  within 2^31 xids of it, so the window is unambiguous. Frozen rows keep
 *  their raw xmin (pg ≥ 9.4) and can at worst land in the window by
 *  coincidence — an extra row re-sent, never a row missed. null = the window
 *  is unusable (the cursor is from the future — a repointed source — or so old
 *  it may have wrapped): full reload instead. */
export function xminWindow(from: bigint, snapshotXmax: bigint): string | null {
  const width = snapshotXmax - from;
  if (width < 0n || width >= 2n ** 31n) return null;
  const lo = from % 2n ** 32n;
  return `((xmin::text::bigint - ${lo}) & 4294967295) < ${width}`;
}

/** Incremental pass for one table: in ONE snapshot, pull rows whose xmin is
 *  past `from` and count the source; upsert the rows into the live
 *  ReplacingMergeTree; then compare counts. Deletes, TRUNCATE and key changes
 *  leave no xmin behind — any of them makes the counts disagree, and the
 *  caller full-reloads (`mismatch`). An upsert of several batches is visible
 *  batch by batch (per-row consistent, not per-table atomic like the swap). */
export async function mirrorDelta(
  pg: Pg,
  ch: ChOptions,
  t: MirrorTable,
  from: bigint,
  opts?: { tally?: { bytes: number }; onProgress?: (rows: number) => void },
): Promise<{ rows: number; bytes: number; cursor: string; mismatch: string | null }> {
  const target = bizTableName(t.schema, t.name);
  const tally = opts?.tally ?? { bytes: 0 };
  const res = await pg.begin(async (tx) => {
    await tx.unsafe(SNAPSHOT_TXN);
    const snap = await snapshotBoundary(tx);
    const where = xminWindow(from, snap.xmax);
    if (where === null) return { rows: 0, bytes: 0, cursor: "", sourceCount: -1, window: false };
    const counted: { n: string }[] = await tx.unsafe(
      `SELECT count(*)::text AS n FROM ${pgIdent(t.schema)}.${pgIdent(t.name)}`,
    );
    const pulled = await streamInto(tx, ch, t, `${buildSelect(t)} WHERE ${where}`, target, tally, opts?.onProgress);
    return { ...pulled, cursor: String(snap.xmin), sourceCount: Number(counted[0].n), window: true };
  });
  if (!res.window) return { rows: 0, bytes: 0, cursor: "", mismatch: "xmin boundary unusable (source repointed, or last pass too long ago)" };
  const mirrored = await chSelect(ch, `SELECT count() AS c FROM ${chIdent(ch.mirrorDb)}.${chIdent(target)} FINAL`);
  const m = Number(mirrored[0]?.c ?? -1);
  const mismatch = m === res.sourceCount ? null : `source has ${res.sourceCount} rows, mirror ${m} (deletes, TRUNCATE, or a key change)`;
  return { rows: res.rows, bytes: res.bytes, cursor: res.cursor, mismatch };
}

/** How far an incrementally-maintained mirror had drifted from a fresh full
 *  copy of the source: keys only in the fresh copy (missing), keys only in the
 *  live mirror (extra — a missed delete), and keys whose row contents differ
 *  (changed — a missed update). Rows hash via formatRow('TabSeparated', …),
 *  which is deterministic for every mapped type, keeps NULL distinct from ''
 *  and escapes separators; `_mirrored_at` is left out (it differs by design).
 *  Runs entirely inside ClickHouse — no source egress. */
export interface Drift {
  missing: number;
  extra: number;
  changed: number;
}

export function driftSQL(db: string, live: string, fresh: string, t: MirrorTable): string {
  const keys = t.pk.map(chIdent).join(", ");
  const hash = `cityHash64(formatRow('TabSeparated', ${t.columns.map((c) => chIdent(c.name)).join(", ")}))`;
  const side = (table: string, final: boolean): string =>
    `(SELECT ${keys}, ${hash} AS h FROM ${chIdent(db)}.${chIdent(table)}${final ? " FINAL" : ""})`;
  return (
    `SELECT countIf(l.h IS NULL) AS missing, countIf(f.h IS NULL) AS extra, countIf(l.h != f.h) AS changed ` +
    `FROM ${side(live, true)} AS l FULL OUTER JOIN ${side(fresh, false)} AS f USING (${keys}) ` +
    `SETTINGS join_use_nulls = 1`
  );
}

export async function measureDrift(ch: ChOptions, live: string, fresh: string, t: MirrorTable): Promise<Drift> {
  const rows = await chSelect(ch, driftSQL(ch.mirrorDb, live, fresh, t));
  return { missing: Number(rows[0]?.missing ?? 0), extra: Number(rows[0]?.extra ?? 0), changed: Number(rows[0]?.changed ?? 0) };
}

async function recordRun(ch: ChOptions, startedAt: Date, r: TableResult): Promise<void> {
  await metaInsert(ch, "pg_mirror_runs", [{
    started_at: runStamp(startedAt),
    finished_at: runStamp(new Date()),
    target_table: r.target,
    source_table: r.source,
    rows: r.rows,
    bytes: r.bytes,
    status: r.status,
    error: r.error,
    mode: r.mode,
    drift: r.drift ?? null,
  }]);
}

export interface RunOptions {
  /** Bytes this pass may still stream (daily cap minus today's ledger). Once
   *  spent, the remaining changed tables are recorded as "capped" and left for
   *  a later pass — overshoot is bounded by one table's pull, never a pass. */
  budgetBytes?: number | null;
  /** false = every table full-reloads (SETOKU_MIRROR_INCREMENTAL=0). */
  incremental?: boolean;
  /** Reconcile backstop for anything the count check can't see: a mirror that
   *  has absorbed deltas full-reloads once its last full reload is this old.
   *  null = never. */
  reconcileMs?: number | null;
  /** Quiet-window mode for the backstop (replaces the age rule): given the
   *  pass start, the epoch ms the CURRENT quiet window began, or null outside
   *  it. A table reconciles at the first pass of each window whose last full
   *  reload predates the window — i.e. nightly, off-peak. */
  reconcileWindowStart?: (now: Date) => number | null;
  /** Override the server probe (tests). */
  server?: ServerInfo;
}

/** One mirror pass: discover → pull each changed table (skip the verifiably
 *  unchanged; xmin delta where eligible, full reload otherwise) → prune stale
 *  mirrors. */
export async function runOnce(
  pg: Pg,
  ch: ChOptions,
  cfg: MirrorConfig,
  setState?: (s: string) => void,
  budgetOrOpts: number | null | RunOptions = null,
): Promise<{ ok: number; failed: number; rows: number; bytes: number; unchanged: number; capped: number; incremental: number }> {
  const opts: RunOptions = typeof budgetOrOpts === "object" && budgetOrOpts !== null ? budgetOrOpts : { budgetBytes: budgetOrOpts };
  const budgetBytes = opts.budgetBytes ?? null;
  const reconcileMs = opts.reconcileMs === undefined ? DEFAULT_RECONCILE_MS : opts.reconcileMs;
  // undefined = age mode; null = window mode, outside the window (no reconcile)
  const windowStart = opts.reconcileWindowStart ? opts.reconcileWindowStart(new Date()) : undefined;
  const server = opts.server ?? (await fetchServerInfo(pg));
  const { tables, failed: discoveryFailed } = await discoverTables(pg, cfg, { incremental: opts.incremental, server });
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
    return { ok: 0, failed: 0, rows: 0, bytes: 0, unchanged: 0, capped: 0, incremental: 0 };
  }

  // State the CURRENT mirror tables were built from. A state row whose biz
  // table is gone is ignored (both the skip and the delta also require the
  // table to exist), so pruned tables need no state cleanup.
  const state = await loadMirrorState(ch).catch((e) => {
    console.error(`pg-mirror: could not load mirror state (skip + incremental disabled this pass): ${e}`);
    return new Map<string, MirrorState>();
  });

  const results: TableResult[] = [];
  for (const f of discoveryFailed) {
    const r: TableResult = { target: bizTableName(f.schema, f.name), source: `${f.schema}.${f.name}`, rows: 0, bytes: 0, status: "error", error: f.error, mode: "" };
    results.push(r);
    console.error(`pg-mirror: ${r.source} not mirrorable: ${f.error}`);
    await recordRun(ch, new Date(), r).catch(() => {});
  }

  let n = 0;
  for (const t of tables) {
    n += 1;
    const target = bizTableName(t.schema, t.name);
    const source = `${t.schema}.${t.name}`;
    setState?.(`pulling ${target} (${n}/${tables.length})`);
    const startedAt = new Date();
    const shape = schemaSignature(t);
    const prev = state.get(target);

    // Counters are read BEFORE the pull streams, so the stored signature can
    // only UNDERSTATE what the mirror holds — a change racing the copy makes
    // the next pass pull once more, never skip a stale mirror. A standby's
    // counters never move, so there the skip is off (null → never equal).
    const counters = server.replica ? null : await fetchChangeCounters(pg, t.schema, t.name).catch(() => null);
    const signature = `${shape}/${counters ?? "no-stats"}`;

    // Reconcile backstop: a mirror that has absorbed deltas since its last
    // full reload is rebuilt once a day — in the quiet window when one is
    // configured (off-peak, and on a fresh egress-ledger day), else by age.
    // Decided BEFORE the unchanged skip: a table busy all day and quiet at
    // night is exactly the one that must still reconcile at night.
    const reconcileDue =
      reconcileMs !== null &&
      existing.has(target) &&
      (prev?.deltas ?? 0) > 0 &&
      (windowStart !== undefined
        ? windowStart !== null && (prev?.fullAt ?? 0) < windowStart
        : startedAt.getTime() - (prev?.fullAt ?? 0) >= reconcileMs);

    if (!reconcileDue && counters !== null && existing.has(target) && prev?.signature === signature) {
      const r: TableResult = { target, source, rows: 0, bytes: 0, status: "unchanged", error: "", mode: "" };
      results.push(r);
      // Re-stamp checked_at: freshness surfaces read "verified equal to the
      // source at this time" from pg_mirror_runs/pg_mirror_state.
      await saveMirrorState(ch, target, source, prev).catch((e) =>
        console.error(`pg-mirror: could not re-stamp state for ${target}: ${e}`),
      );
      await recordRun(ch, startedAt, r).catch((e) => console.error(`pg-mirror: could not record run for ${target}: ${e}`));
      continue;
    }

    if (budgetBytes !== null && results.reduce((a, r) => a + r.bytes, 0) >= budgetBytes) {
      // Budget spent: don't start another stream. The table keeps its old
      // state, so it pulls first thing once the day rolls over.
      const r: TableResult = { target, source, rows: 0, bytes: 0, status: "capped", error: "daily egress cap reached", mode: "" };
      results.push(r);
      await recordRun(ch, startedAt, r).catch((e) => console.error(`pg-mirror: could not record run for ${target}: ${e}`));
      continue;
    }

    // The delta is only ever applied to a mirror built with this exact shape
    // (engine included) from an unbroken chain of snapshots.
    const chainIntact = t.incremental === true && existing.has(target) && !!prev?.cursor && prev.signature.split("/")[0] === shape;
    const canDelta = chainIntact && !reconcileDue;

    const tally = { bytes: 0 };
    let mode: TableResult["mode"] = canDelta ? "incremental" : reconcileDue ? "reconcile" : "full";
    let drift: number | null = null;
    try {
      let pulled: { rows: number; bytes: number; cursor: string } | null = null;
      if (canDelta) {
        const d = await mirrorDelta(pg, ch, t, BigInt(prev!.cursor), { tally });
        if (d.mismatch === null) pulled = d;
        else console.error(`pg-mirror: ${source}: ${d.mismatch} — full reload`);
      }
      // Reconcile doubles as the audit of the incremental path: catch the
      // mirror up with one last delta, then diff the fresh full copy against
      // it before the swap. Anything left over is drift the deltas + count
      // check missed. (A count mismatch here is already handled — and
      // explained — by the per-pass check, so it isn't measured as drift.)
      let measure = false;
      if (reconcileDue && chainIntact) {
        const d = await mirrorDelta(pg, ch, t, BigInt(prev!.cursor), { tally });
        if (d.mismatch === null) measure = true;
        else console.error(`pg-mirror: ${source}: ${d.mismatch} — reconciling without a drift check`);
      }
      let fullAt = prev?.fullAt ?? 0;
      let deltas = (prev?.deltas ?? 0) + (pulled && pulled.rows > 0 ? 1 : 0);
      if (pulled === null) {
        if (mode === "incremental") mode = "full"; // a delta that fell back
        const beforeSwap = measure
          ? async (staging: string): Promise<void> => {
              try {
                const dr = await measureDrift(ch, target, staging, t);
                drift = dr.missing + dr.extra + dr.changed;
                if (drift > 0)
                  console.error(
                    `pg-mirror: ${source}: reconcile found DRIFT — ${dr.missing} missing, ${dr.extra} extra, ${dr.changed} changed row(s) vs the incremental mirror (fixed by this reload)`,
                  );
              } catch (e) {
                // the audit is best-effort; the reload itself still proceeds
                console.error(`pg-mirror: ${source}: drift check failed: ${String(e).slice(0, 200)}`);
              }
            }
          : undefined;
        const f = await mirrorTable(pg, ch, t, existing, { tally, beforeSwap });
        // a delta that fell back still pulled its rows — the ledger gets both
        pulled = { rows: f.rows, bytes: tally.bytes, cursor: f.cursor };
        fullAt = startedAt.getTime();
        deltas = 0;
      }
      results.push({ target, source, rows: pulled.rows, bytes: pulled.bytes, status: "ok", error: "", mode, drift });
      // Only after a successful pull — a failure keeps the old state so the
      // table retries next pass (from the old boundary) instead of skipping
      // on a stale mirror.
      await saveMirrorState(ch, target, source, { signature, cursor: pulled.cursor, fullAt, deltas }).catch((e) =>
        console.error(`pg-mirror: could not save state for ${target}: ${e}`),
      );
    } catch (e) {
      // Best-effort staging cleanup; the previous good copy (if any) stays live.
      // A delta that died mid-upsert left some newer row versions in place —
      // harmless: the next pass re-pulls from the same boundary.
      await chCommand(ch, `DROP TABLE IF EXISTS ${chIdent(ch.mirrorDb)}.${chIdent(`${target}__staging`)} SYNC`).catch(() => {});
      existing.delete(`${target}__staging`);
      // The failure still PULLED tally.bytes out of the source — and a failing
      // table retries every pass, which is the most expensive egress pattern
      // there is. Recording 0 here would blind the ledger (and the alert) to
      // exactly the overage it exists to catch.
      results.push({ target, source, rows: 0, bytes: tally.bytes, status: "error", error: (e as Error).message.slice(0, 500), mode });
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
  const unchanged = results.filter((r) => r.status === "unchanged").length;
  const capped = results.filter((r) => r.status === "capped").length;
  const rows = ok.reduce((a, r) => a + r.rows, 0);
  // Bytes across ALL results — failed streams pulled real egress too.
  const bytes = results.reduce((a, r) => a + r.bytes, 0);
  const incremental = ok.filter((r) => r.mode === "incremental").length;
  return { ok: ok.length, failed: results.length - ok.length - unchanged - capped, rows, bytes, unchanged, capped, incremental };
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

/* ------------------------------ cadence ----------------------------- */

export interface QuietWindow {
  start: number; // hour 0-23, inclusive
  end: number; // hour 0-23, exclusive; end <= start wraps past midnight
}

export interface Cadence {
  baseMs: number;
  quietMs: number;
  quiet: QuietWindow | null;
  tz: string; // IANA zone the window is read in
}

/** "23-8" → { start: 23, end: 8 }. Unset/blank → null (no window). Anything
 *  else throws — the caller fails fast at startup rather than silently running
 *  one cadence all day. */
export function parseQuietHours(s: string | undefined): QuietWindow | null {
  if (s === undefined || s.trim() === "") return null;
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(s);
  const start = m ? Number(m[1]) : NaN;
  const end = m ? Number(m[2]) : NaN;
  if (!m || start > 23 || end > 23 || start === end) {
    throw new Error(`SETOKU_MIRROR_QUIET_HOURS must be "H-H" with hours 0-23 (start ≠ end), got ${JSON.stringify(s)}`);
  }
  return { start, end };
}

/** Half-open [start, end), wrap-aware: 23-8 covers 23, 0, 1 … 7. */
export function inQuietHours(hour: number, w: QuietWindow | null): boolean {
  if (!w) return false;
  return w.start < w.end ? hour >= w.start && hour < w.end : hour >= w.start || hour < w.end;
}

/** Hour (0-23) of `now` on the wall clock of `tz` — the container itself runs
 *  UTC, so the window is read through ICU rather than the process clock. */
export function wallClockHour(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).formatToParts(now);
  let hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  if (hh === 24) hh = 0; // some ICU builds emit "24" at midnight
  return hh;
}

/** The interval that applies at `now`. */
export function intervalFor(now: Date, c: Cadence): number {
  return inQuietHours(wallClockHour(now, c.tz), c.quiet) ? c.quietMs : c.baseMs;
}

/** Epoch ms at which the quiet window containing `nowMs` began, or null when
 *  `nowMs` is outside the window (or there is none). Walks back a minute at a
 *  time on the wall clock of `c.tz`, so DST shifts land where they should. */
export function quietWindowStart(nowMs: number, c: Cadence): number | null {
  const inside = (ms: number): boolean => inQuietHours(wallClockHour(new Date(ms), c.tz), c.quiet);
  if (!c.quiet || !inside(nowMs)) return null;
  const step = 60_000;
  let t = nowMs - (nowMs % step);
  for (let i = 0; i < 24 * 60 && inside(t - step); i++) t -= step;
  return t;
}

/** When the next pass is due after one ending at `lastEndMs`: the first
 *  minute at which the elapsed time covers the interval in force AT THAT
 *  MINUTE. Re-evaluating per minute (not once at sleep time) is what makes the
 *  window edges behave — a pass ending at 07:50 with the window ending at
 *  08:00 is due at 08:00, not two hours later. The loop uses this same rule. */
export function nextPassAt(lastEndMs: number, c: Cadence): number {
  const step = 60_000;
  const limit = Math.max(c.baseMs, c.quietMs) + step;
  for (let t = lastEndMs; t - lastEndMs <= limit; t += step) {
    if (t - lastEndMs >= intervalFor(new Date(t), c)) return t;
  }
  return lastEndMs + limit; // unreachable in practice; never spin forever
}

/** A positive-millisecond env knob. Blank/unset → the default; anything that
 *  isn't a finite number > 0 throws (a NaN or 0 interval would turn the
 *  wait-until loop into back-to-back full reloads of a metered source). */
export function positiveMs(name: string, raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of milliseconds, got ${JSON.stringify(raw)}`);
  return n;
}

/** The daily cap knob: unset, blank, or "0" → null (off); otherwise a finite
 *  positive byte count — a typo like "12GB" must fail fast, not silently
 *  disable the guard the operator believes is in force. */
export function parseDailyCap(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "0") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`SETOKU_MIRROR_DAILY_BYTES_CAP must be a byte count (0 = off), got ${JSON.stringify(raw)}`);
  return n > 0 ? n : null;
}

/** Default reconcile backstop (age mode, when no quiet window is set): a
 *  mirror that absorbed deltas full-reloads once a day. */
export const DEFAULT_RECONCILE_MS = 24 * 3_600_000;

/** SETOKU_MIRROR_RECONCILE_HOURS: unset/blank → the default, "0" → never
 *  (null), otherwise positive hours. Garbage fails fast like the other knobs. */
export function parseReconcileHours(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RECONCILE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`SETOKU_MIRROR_RECONCILE_HOURS must be a number of hours (0 = never), got ${JSON.stringify(raw)}`);
  return n === 0 ? null : n * 3_600_000;
}

/** The next 00:00:30 UTC after `nowMs` — when the ledger day rolls over (the
 *  30 s keeps the first pass clear of the day boundary). */
export function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  d.setUTCHours(24, 0, 30, 0);
  return d.getTime();
}

/** The daily-cap gate. Fails OPEN on a ledger read error (the cap is a budget
 *  guard, not a security boundary — lake trouble must not stall the mirror). */
export async function capReached(
  capBytes: number | null,
  read: () => Promise<number>,
): Promise<{ skip: boolean; bytes: number | null }> {
  if (capBytes === null) return { skip: false, bytes: null };
  try {
    const bytes = await read();
    return { skip: bytes >= capBytes, bytes };
  } catch (e) {
    console.error(`pg-mirror: daily cap check failed, running anyway: ${String(e).slice(0, 200)}`);
    return { skip: false, bytes: null };
  }
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
  // Cadence knobs: a quiet window (slower overnight) and a hard daily egress
  // cap — both fail fast on a malformed value, like the config above.
  const TZ = process.env.TZ || "UTC";
  let cadence: Cadence;
  let CAP: number | null;
  let RECONCILE: number | null;
  const INCREMENTAL = process.env.SETOKU_MIRROR_INCREMENTAL?.trim() !== "0";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: TZ }); // throws RangeError on an unknown zone
    cadence = {
      baseMs: positiveMs("SETOKU_MIRROR_INTERVAL_MS", process.env.SETOKU_MIRROR_INTERVAL_MS, 900_000),
      quietMs: positiveMs("SETOKU_MIRROR_QUIET_INTERVAL_MS", process.env.SETOKU_MIRROR_QUIET_INTERVAL_MS, 7_200_000),
      quiet: parseQuietHours(process.env.SETOKU_MIRROR_QUIET_HOURS),
      tz: TZ,
    };
    CAP = parseDailyCap(process.env.SETOKU_MIRROR_DAILY_BYTES_CAP);
    RECONCILE = parseReconcileHours(process.env.SETOKU_MIRROR_RECONCILE_HOURS);
  } catch (e) {
    console.error(`pg-mirror: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (cadence.quiet && cadence.quietMs < cadence.baseMs)
    console.error(`pg-mirror: quiet interval (${cadence.quietMs}ms) is shorter than the base interval (${cadence.baseMs}ms) — the "quiet" window will run faster, not slower`);
  const INTERVAL = cadence.baseMs;
  const cadenceText =
    `every ${INTERVAL}ms` +
    (cadence.quiet
      ? ` (every ${cadence.quietMs}ms from ${cadence.quiet.start}:00 to ${cadence.quiet.end}:00 ${TZ})`
      : "") +
    (CAP ? `, daily cap ${CAP} bytes` : "") +
    (INCREMENTAL
      ? `, incremental (xmin) where eligible, reconcile ${
          RECONCILE === null ? "never" : cadence.quiet ? "nightly in the quiet window" : `every ${RECONCILE / 3_600_000}h`
        }`
      : ", full reloads only (SETOKU_MIRROR_INCREMENTAL=0)");
  console.error(
    `pg-mirror: mirror ${cadenceText} → ${ch.url} db ${ch.mirrorDb} ` +
      `(allow ${JSON.stringify(cfg.allowTables)}, deny ${JSON.stringify(cfg.denyTables)}, ` +
      `denyColumns ${JSON.stringify(cfg.denyColumns)})`,
  );

  await ensureMirrorObjects(ch);
  const publish = (kv: Record<string, string>): void => {
    publishSettings(ch, kv).catch((e) => console.error(`pg-mirror: settings publish failed: ${e}`));
  };
  publish({
    interval_ms: String(INTERVAL),
    quiet_hours: cadence.quiet ? `${cadence.quiet.start}-${cadence.quiet.end}` : "",
    quiet_interval_ms: String(cadence.quietMs),
    tz: TZ,
    daily_bytes_cap: String(CAP ?? 0),
    incremental: INCREMENTAL ? "1" : "0",
    reconcile_hours: RECONCILE === null ? "0" : String(RECONCILE / 3_600_000),
    // Live state from a previous life must not outlive it: clear until the
    // first pass of this process publishes fresh values.
    next_pass_at: "",
    paused: "",
  });

  // Liveness beats on their own timer so a long reload still reads "flowing"
  // (<10 min beat) on the Sources page; detail carries what the loop is doing.
  let state = "starting";
  const beat = (): void => {
    beatHeartbeat(ch, state).catch((e) => console.error(`pg-mirror: heartbeat failed: ${e}`));
  };
  beat();
  setInterval(beat, 60_000);

  // Wait-until loop (not sleep-the-interval): wake every minute and run when
  // the interval in force RIGHT NOW has elapsed since the last pass, so the
  // quiet window's edges take effect within a minute (see nextPassAt).
  const TICK = 60_000;
  let lastEnd = -Infinity; // first pass immediately
  let paused = "";
  let capLoggedHour = -1;
  const gb = (b: number | null): string => (b === null ? "?" : (b / 1e9).toFixed(1) + " GB");
  for (;;) {
    if (Number.isFinite(lastEnd)) {
      const due = paused ? Math.min(nextPassAt(lastEnd, cadence), nextUtcMidnight(lastEnd)) : nextPassAt(lastEnd, cadence);
      const wait = due - Date.now();
      if (wait > 0) {
        await Bun.sleep(Math.min(wait, TICK));
        continue;
      }
    }
    const t0 = Date.now();
    const gate = await capReached(CAP, () => todayLedgerBytes(ch));
    if (gate.skip) {
      // Over budget for the day: no Postgres connection at all. Resumes at the
      // first tick after the ledger day rolls over (00:00 UTC), see below.
      paused = "daily egress cap";
      state = `paused: daily egress cap reached (${gb(gate.bytes)} of ${gb(CAP)} today)`;
      const h = new Date().getUTCHours();
      if (h !== capLoggedHour) {
        console.error(`pg-mirror: ${state}`);
        capLoggedHour = h;
      }
    } else {
      if (paused) console.error("pg-mirror: resumed (daily egress cap cleared)");
      paused = "";
      capLoggedHour = -1;
      // What this pass may still stream before the cap: the gate just read
      // today's ledger, so the budget is exact at pass start.
      const budget = CAP !== null && gate.bytes !== null ? Math.max(0, CAP - gate.bytes) : null;
      try {
        const pg = new SQL(pgOptions(DB_URL)) as unknown as Pg;
        try {
          // Re-read per tick (fails closed — a broken config skips the run and
          // keeps the previous mirror) so a bind-mounted /project picks up
          // allow/deny edits without a restart.
          const r = await runOnce(
            pg,
            ch,
            loadMirrorConfig(PROJECT_DIR),
            (s) => {
              state = s;
            },
            {
              budgetBytes: budget,
              incremental: INCREMENTAL,
              reconcileMs: RECONCILE,
              // with a quiet window, reconcile there (off-peak, fresh ledger day)
              reconcileWindowStart: cadence.quiet ? (now) => quietWindowStart(now.getTime(), cadence) : undefined,
            },
          );
          if (r.capped) {
            paused = "daily egress cap";
            state = `paused: daily egress cap reached mid-pass — ${r.ok} pulled, ${r.unchanged} unchanged, ${r.capped} left for tomorrow (${(r.bytes / 1e6).toFixed(1)} MB this pass)`;
          } else {
            state = r.failed
              ? `partial: ${r.ok} pulled (${r.incremental} incremental), ${r.unchanged} unchanged, ${r.failed} failed — see setoku.pg_mirror_runs`
              : `ok: ${r.ok} pulled (${r.incremental} incremental), ${r.unchanged} unchanged, ${r.rows} row(s) / ${(r.bytes / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - t0) / 1000)}s`;
          }
          console.error(`pg-mirror: ${state}`);
        } finally {
          await pg.end().catch(() => {});
        }
      } catch (e) {
        state = `run failed: ${String(e).slice(0, 200)}`;
        console.error(`pg-mirror: ${state}`);
      }
    }
    lastEnd = Date.now();
    // While paused, the earliest useful moment is the ledger rollover — don't
    // let a 2 h quiet interval straddle midnight and idle past it.
    const next = new Date(paused ? Math.min(nextPassAt(lastEnd, cadence), nextUtcMidnight(lastEnd)) : nextPassAt(lastEnd, cadence));
    state += ` · ${paused ? "resumes" : "next pass"} ~${next.toISOString().slice(11, 16)} UTC`;
    beat();
    publish({ next_pass_at: next.toISOString(), paused });
  }
}

if (import.meta.main) void main();
