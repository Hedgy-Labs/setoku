// SPDX-License-Identifier: Apache-2.0
/**
 * pg-mirror — full-reload mirror of allowlisted business-Postgres tables into
 * the bundled ClickHouse lake (issue #47).
 *
 * Why a mirror: app panels that aggregate big business tables are ClickHouse's
 * native workload; prod Postgres can't be indexed by us (the query role is
 * read-only BY DESIGN) and shouldn't carry dashboard load. Why FULL reloads:
 * no CDC machinery, no replica-identity footguns, and schema drift is a
 * non-event — every run re-derives the table's shape from the Postgres catalog.
 *
 * Per table, per run:
 *   1. derive DDL from information_schema (explicit type map — unmapped types
 *      fail THAT table loudly, never silently coerce),
 *   2. load into `<name>__staging` in keyset-paginated batches (read with the
 *      SAME read-only role the gateway uses, so the engine-enforced grants and
 *      the PG_MIRROR_TABLES allowlist both bound what can ever leave Postgres),
 *   3. verify the staged row count, then atomically EXCHANGE TABLES — the live
 *      table is never empty or partial; a failed run leaves the previous copy.
 *
 * Mirrored tables are named `biz_<table>` (`biz_<schema>_<table>` outside
 * public) and carry `_mirrored_at` for the "data as of" freshness surfaced on
 * the Sources page. Mirrors are re-derivable from Postgres, so they are NOT
 * part of the lake's precious-data backup story (I4 note) — a lost mirror is
 * one reload away. Liveness beats into `ingest_heartbeats` as "pg-mirror".
 */
import { SQL } from "bun";

/* ------------------------------ env config ------------------------------ */

const INTERVAL = Number(process.env.PG_MIRROR_INTERVAL_MS ?? 3_600_000);
const BATCH_ROWS = Number(process.env.PG_MIRROR_BATCH_ROWS ?? 20_000);
/** A PK-less table can't be keyset-paginated; beyond this it fails loudly. */
const NO_PK_ROW_CAP = Number(process.env.PG_MIRROR_NO_PK_ROW_CAP ?? 200_000);

export interface ClickHouseOptions {
  url: string;
  user: string;
  password: string;
  db: string;
}

export interface MirrorOptions {
  ch: ClickHouseOptions;
  /** Allow globs over `schema.table` (same semantics as .setoku allowTables). */
  allow: string[];
  deny: string[];
  batchRows?: number;
  noPkRowCap?: number;
}

/* --------------------------- allow/deny globs --------------------------- */

// Same semantics as the gateway's config.ts: `*` matches within one segment,
// deny wins, then the allow list must match. Duplicated here (not imported) so
// the container stays a single self-contained file like the other pollers.
function globToRe(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*");
  return new RegExp(`^${esc}$`, "i");
}

export function tableAllowed(qualified: string, allow: string[], deny: string[]): boolean {
  const q = qualified.includes(".") ? qualified : `public.${qualified}`;
  if (deny.some((p) => globToRe(p).test(q))) return false;
  return allow.some((p) => globToRe(p).test(q));
}

/* ----------------------------- type mapping ----------------------------- */

interface PgColumn {
  name: string;
  /** information_schema data_type, e.g. "integer", "timestamp with time zone". */
  dataType: string;
  nullable: boolean;
}

/** Explicit Postgres→ClickHouse type map. Anything not listed throws — a
 *  silently-wrong mirror is worse than a loudly-missing one. */
export function chType(col: PgColumn, opts: { inKey: boolean }): string {
  const base = (() => {
    switch (col.dataType) {
      case "smallint": return "Int16";
      case "integer": return "Int32";
      case "bigint": return "Int64";
      case "real": return "Float32";
      case "double precision": return "Float64";
      // Lossy for >15 significant digits — fine for analytics, documented in
      // the table comment. Revisit as Decimal if a tenant needs exact cents.
      case "numeric": return "Float64";
      case "boolean": return "Bool";
      case "text":
      case "character varying":
      case "character":
      case "citext": return "String";
      case "uuid": return "UUID";
      case "date": return "Date32";
      case "timestamp without time zone":
      case "timestamp with time zone": return "DateTime64(3)";
      // JSON/arrays land as their JSON text — queryable via CH JSON functions.
      case "json":
      case "jsonb":
      case "ARRAY": return "String";
      // Postgres enums / domains report USER-DEFINED; their values are strings.
      case "USER-DEFINED": return "String";
      default:
        throw new Error(`unmapped Postgres type "${col.dataType}" (column "${col.name}") — add it to chType or deny the table`);
    }
  })();
  return col.nullable && !opts.inKey ? `Nullable(${base})` : base;
}

/** Encode one Postgres value for a ClickHouse JSONEachRow line, by pg type. */
export function encodeValue(v: unknown, dataType: string): unknown {
  if (v == null) return null;
  if (v instanceof Date) {
    const iso = v.toISOString(); // UTC
    return dataType === "date" ? iso.slice(0, 10) : iso.replace("T", " ").replace("Z", "");
  }
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  if (dataType === "json" || dataType === "jsonb" || dataType === "ARRAY") {
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  return v;
}

/* --------------------------- clickhouse client -------------------------- */

async function chExec(ch: ClickHouseOptions, query: string, opts: { body?: string; settings?: Record<string, string> } = {}): Promise<string> {
  const params = new URLSearchParams(opts.settings ?? {});
  if (opts.body != null) params.set("query", query);
  const res = await fetch(`${ch.url}/?${params}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${ch.user}:${ch.password}`),
      "content-type": opts.body != null ? "application/x-ndjson" : "text/plain",
    },
    body: opts.body ?? query,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`clickhouse failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return res.text();
}

async function chCount(ch: ClickHouseOptions, table: string): Promise<number> {
  const out = await chExec(ch, `SELECT count() AS c FROM ${ch.db}.\`${table}\` FORMAT JSON`);
  const parsed = JSON.parse(out) as { data?: Array<{ c?: unknown }> };
  return Number(parsed.data?.[0]?.c ?? 0);
}

/** Beat liveness into ingest_heartbeats (same pattern as slack-listener). The
 *  schema init dir only runs on a FRESH ClickHouse, so ensure best-effort. */
export async function beatHeartbeat(ch: ClickHouseOptions, detail: string): Promise<void> {
  await chExec(
    ch,
    `CREATE TABLE IF NOT EXISTS ${ch.db}.ingest_heartbeats (
       connector LowCardinality(String), beat_at DateTime64(3), detail String
     ) ENGINE = ReplacingMergeTree(beat_at) ORDER BY connector`,
  ).catch(() => {});
  const beat_at = new Date().toISOString().replace("T", " ").replace("Z", "");
  await chExec(ch, `INSERT INTO ${ch.db}.ingest_heartbeats FORMAT JSONEachRow`, {
    body: JSON.stringify({ connector: "pg-mirror", beat_at, detail }) + "\n",
  });
}

/* ---------------------------- pg introspection --------------------------- */

type PgSql = SQL;

interface PgTable {
  schema: string;
  table: string;
}

export async function listCandidateTables(sql: PgSql): Promise<PgTable[]> {
  const rows = (await sql`
    SELECT table_schema AS schema, table_name AS table
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name`) as unknown as PgTable[];
  return rows;
}

async function tableColumns(sql: PgSql, t: PgTable): Promise<PgColumn[]> {
  const rows = (await sql`
    SELECT column_name AS name, data_type AS "dataType", is_nullable = 'YES' AS nullable
    FROM information_schema.columns
    WHERE table_schema = ${t.schema} AND table_name = ${t.table}
    ORDER BY ordinal_position`) as unknown as PgColumn[];
  return rows;
}

async function tablePk(sql: PgSql, t: PgTable): Promise<string[]> {
  const rows = (await sql`
    SELECT a.attname AS name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
    WHERE i.indisprimary AND n.nspname = ${t.schema} AND c.relname = ${t.table}
    ORDER BY array_position(i.indkey, a.attnum)`) as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/* ------------------------------ the mirror ------------------------------ */

/** ClickHouse-side name for a mirrored table: `biz_<table>`, schema-prefixed
 *  outside public so two schemas' same-named tables can't collide. */
export function mirrorName(t: PgTable): string {
  return t.schema === "public" ? `biz_${t.table}` : `biz_${t.schema}_${t.table}`;
}

const pgIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** Mirror one table: staging DDL → keyset-paginated copy → verify → swap. */
export async function mirrorTable(sql: PgSql, opts: MirrorOptions, t: PgTable): Promise<{ table: string; rows: number }> {
  const ch = opts.ch;
  const batch = opts.batchRows ?? BATCH_ROWS;
  const cols = await tableColumns(sql, t);
  if (!cols.length) throw new Error(`no columns for ${t.schema}.${t.table}`);
  const pk = await tablePk(sql, t);
  const pkSet = new Set(pk);
  const target = mirrorName(t);
  const staging = `${target}__staging`;

  // Fresh staging table, shape derived from the CURRENT pg catalog (drift-proof).
  const colDefs = cols.map((c) => `\`${c.name}\` ${chType(c, { inKey: pkSet.has(c.name) })}`);
  const orderBy = pk.length ? pk.map((c) => `\`${c}\``).join(", ") : "tuple()";
  await chExec(ch, `DROP TABLE IF EXISTS ${ch.db}.\`${staging}\``);
  await chExec(
    ch,
    `CREATE TABLE ${ch.db}.\`${staging}\` (
       ${colDefs.join(",\n       ")},
       \`_mirrored_at\` DateTime64(3) DEFAULT now64(3)
     ) ENGINE = MergeTree ORDER BY (${orderBy})
     COMMENT 'Full-reload mirror of Postgres ${t.schema}.${t.table} (pg-mirror). Re-derivable — freshness in _mirrored_at. numeric→Float64.'`,
  );

  const selectList = cols.map((c) => pgIdent(c.name)).join(", ");
  const insertQuery = `INSERT INTO ${ch.db}.\`${staging}\` (${cols.map((c) => `\`${c.name}\``).join(", ")}) FORMAT JSONEachRow`;
  const typeByName = new Map(cols.map((c) => [c.name, c.dataType]));
  let sent = 0;

  const push = async (rows: Record<string, unknown>[]): Promise<void> => {
    if (!rows.length) return;
    const lines = rows
      .map((r) => JSON.stringify(Object.fromEntries(cols.map((c) => [c.name, encodeValue(r[c.name], typeByName.get(c.name)!)]))) + "\n")
      .join("");
    await chExec(ch, insertQuery, { body: lines, settings: { input_format_json_read_numbers_as_strings: "1" } });
    sent += rows.length;
  };

  if (pk.length) {
    // Keyset pagination on the PK — one ordered pass, bounded memory, works at
    // millions of rows. Composite keys use row-value comparison.
    const pkList = pk.map(pgIdent).join(", ");
    let last: unknown[] | null = null;
    for (;;) {
      const where = last ? `WHERE (${pkList}) > (${pk.map((_, i) => `$${i + 1}`).join(", ")})` : "";
      const rows = (await sql.unsafe(
        `SELECT ${selectList} FROM ${pgIdent(t.schema)}.${pgIdent(t.table)} ${where} ORDER BY ${pkList} LIMIT ${batch}`,
        (last ?? []) as never[],
      )) as unknown as Record<string, unknown>[];
      await push(rows);
      if (rows.length < batch) break;
      last = pk.map((c) => rows[rows.length - 1][c]);
    }
  } else {
    // No PK → no stable pagination order. Small tables load in one pass;
    // beyond the cap we refuse loudly rather than buffer the world.
    const [{ n }] = (await sql.unsafe(
      `SELECT count(*)::int8 AS n FROM ${pgIdent(t.schema)}.${pgIdent(t.table)}`,
    )) as unknown as Array<{ n: number | string }>;
    const count = Number(n);
    const cap = opts.noPkRowCap ?? NO_PK_ROW_CAP;
    if (count > cap)
      throw new Error(`${t.schema}.${t.table} has no primary key and ${count} rows (> ${cap}) — add a PK or deny it from the mirror`);
    const rows = (await sql.unsafe(
      `SELECT ${selectList} FROM ${pgIdent(t.schema)}.${pgIdent(t.table)}`,
    )) as unknown as Record<string, unknown>[];
    await push(rows);
  }

  // Sanity: everything we sent is queryable in staging before it goes live.
  const staged = await chCount(ch, staging);
  if (staged !== sent) throw new Error(`staged ${staged} rows but sent ${sent} for ${t.schema}.${t.table} — not swapping`);

  // Atomic swap — viewers see the old copy until the instant the new one is
  // complete. First run: the target doesn't exist yet, so create it empty
  // (same shape) and exchange into it.
  await chExec(ch, `CREATE TABLE IF NOT EXISTS ${ch.db}.\`${target}\` AS ${ch.db}.\`${staging}\``);
  await chExec(ch, `EXCHANGE TABLES ${ch.db}.\`${target}\` AND ${ch.db}.\`${staging}\``);
  await chExec(ch, `DROP TABLE IF EXISTS ${ch.db}.\`${staging}\``);
  return { table: target, rows: sent };
}

/** One full mirror pass. Per-table failures are isolated (one broken table
 *  can't wedge the rest) and reported in the heartbeat detail. */
export async function tick(sql: PgSql, opts: MirrorOptions): Promise<{ mirrored: Array<{ table: string; rows: number }>; failed: Array<{ table: string; error: string }> }> {
  const candidates = await listCandidateTables(sql);
  const selected = candidates.filter((t) => tableAllowed(`${t.schema}.${t.table}`, opts.allow, opts.deny));
  const mirrored: Array<{ table: string; rows: number }> = [];
  const failed: Array<{ table: string; error: string }> = [];
  for (const t of selected) {
    try {
      mirrored.push(await mirrorTable(sql, opts, t));
    } catch (e) {
      failed.push({ table: `${t.schema}.${t.table}`, error: String((e as Error).message ?? e).slice(0, 300) });
    }
  }
  const rows = mirrored.reduce((a, m) => a + m.rows, 0);
  const detail =
    `mirrored ${mirrored.length}/${selected.length} table(s), ${rows} row(s)` +
    (failed.length ? `; FAILED: ${failed.map((f) => `${f.table} (${f.error.slice(0, 80)})`).join("; ")}` : "");
  await beatHeartbeat(opts.ch, detail).catch((e) => console.error(`pg-mirror: heartbeat failed: ${e}`));
  return { mirrored, failed };
}

/* --------------------------------- main ---------------------------------- */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`pg-mirror: ${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const dbUrl = required("SETOKU_DATABASE_URL");
  const opts: MirrorOptions = {
    ch: {
      url: process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
      user: process.env.CLICKHOUSE_USER ?? "setoku",
      password: process.env.CLICKHOUSE_PASSWORD ?? "",
      db: process.env.CLICKHOUSE_DB ?? "setoku",
    },
    // Keep in sync with .setoku/config.json allowTables — the mirror must never
    // widen what the gateway's postgres path allows (issue #47).
    allow: (process.env.PG_MIRROR_TABLES ?? "public.*").split(",").map((s) => s.trim()).filter(Boolean),
    deny: (process.env.PG_MIRROR_DENY_TABLES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  console.error(`pg-mirror: mirroring [${opts.allow.join(", ")}] every ${INTERVAL}ms`);
  for (;;) {
    const sql = new SQL(dbUrl);
    try {
      const r = await tick(sql, opts);
      console.error(`pg-mirror: ${r.mirrored.length} table(s) mirrored${r.failed.length ? `, ${r.failed.length} FAILED: ${JSON.stringify(r.failed)}` : ""}`);
    } catch (e) {
      console.error(`pg-mirror: tick failed: ${e}`);
    } finally {
      await sql.end().catch(() => {});
    }
    await Bun.sleep(INTERVAL);
  }
}

if (import.meta.main) void main();
