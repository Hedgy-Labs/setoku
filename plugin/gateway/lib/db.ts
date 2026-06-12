// SPDX-License-Identifier: Apache-2.0
import pgPkg from "pg";
import { isTableAllowed, type SetokuConfig } from "./config";

const { Pool } = pgPkg;

const pools = new Map<string, InstanceType<typeof Pool>>();

/**
 * TLS for the business DB. Local/unix-socket connections need none; managed
 * Postgres (Supabase, RDS, Neon, …) requires TLS but commonly presents a CA
 * chain Node doesn't bundle, so we encrypt without strict chain verification
 * by default. Set SETOKU_PG_SSL_STRICT=1 to require a trusted CA.
 */
function sslConfig(url: string): false | { rejectUnauthorized: boolean } {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (
    !host ||
    host.startsWith("/") ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return false;
  }
  return { rejectUnauthorized: process.env.SETOKU_PG_SSL_STRICT === "1" };
}

/**
 * Drop sslmode/ssl from the connection string so a stray `?sslmode=require`
 * can't force strict verify-full (pg's newer behavior) and override our ssl
 * config. Left untouched when no such param is present (keeps unix-socket URLs
 * byte-identical for the test suite).
 */
function stripSslParams(url: string): string {
  if (!/[?&](sslmode|ssl)=/.test(url)) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    u.searchParams.delete("ssl");
    return u.toString();
  } catch {
    return url;
  }
}

export function poolFor(url: string) {
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({
      connectionString: stripSslParams(url),
      ssl: sslConfig(url),
      max: 2,
      allowExitOnIdle: true,
    });
    pools.set(url, pool);
  }
  return pool;
}

export interface QueryOutcome {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  ms: number;
}

export type SqlValidation =
  | { ok: true; sql: string; kind: string }
  | { ok: false; error: string };

const READ_KEYWORDS = new Set([
  "SELECT",
  "WITH",
  "EXPLAIN",
  "VALUES",
  "TABLE",
  "SHOW",
  // ClickHouse-dialect reads (harmless for Postgres — the engine rejects them)
  "DESCRIBE",
  "DESC",
  "EXISTS",
]);

/**
 * v0 statement gate: single read statement only. Defense in depth — the
 * statement also runs inside a READ ONLY transaction, so anything that
 * slips past the gate still cannot write.
 */
export function validateSql(sql: string): SqlValidation {
  let s = String(sql ?? "").trim();
  while (s.endsWith(";")) s = s.slice(0, -1).trimEnd();
  if (!s) return { ok: false, error: "Empty SQL." };
  if (s.includes(";")) {
    return {
      ok: false,
      error:
        "Multiple statements (semicolons) are not supported — run one statement per call.",
    };
  }
  // strip leading line/block comments to find the first keyword
  let probe = s;
  for (;;) {
    const before = probe;
    probe = probe
      .replace(/^\s*--[^\n]*\n/, "")
      .replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "")
      .trimStart();
    if (probe === before) break;
  }
  const first = (probe.match(/^[A-Za-z]+/) ?? [""])[0].toUpperCase();
  if (!READ_KEYWORDS.has(first)) {
    return {
      ok: false,
      error: `Only read statements are allowed (got "${first || "?"}"). The connection is READ ONLY; writes are rejected.`,
    };
  }
  return { ok: true, sql: s, kind: first };
}

/** Run a read-only query with a row cap and statement timeout. */
export async function runReadOnlyQuery(
  url: string,
  sql: string,
  {
    rowCap,
    statementTimeoutMs,
  }: Pick<SetokuConfig, "rowCap" | "statementTimeoutMs">,
): Promise<QueryOutcome> {
  const v = validateSql(sql);
  if (!v.ok) throw new Error(v.error);
  const client = await poolFor(url).connect();
  const started = Date.now();
  try {
    const begin = async () => {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(
        `SET LOCAL statement_timeout = ${Math.max(100, statementTimeoutMs | 0)}`,
      );
    };
    await begin();
    let result;
    const wrappable =
      v.kind === "SELECT" ||
      v.kind === "WITH" ||
      v.kind === "VALUES" ||
      v.kind === "TABLE";
    if (wrappable) {
      try {
        result = await client.query(
          `SELECT * FROM (\n${v.sql}\n) AS "_setoku_q" LIMIT ${rowCap + 1}`,
        );
      } catch (e) {
        if ((e as { code?: string }).code === "42601") {
          // syntax error introduced by wrapping (rare valid-SQL edge cases) — retry raw
          await client.query("ROLLBACK");
          await begin();
          result = await client.query(v.sql);
        } else {
          throw e;
        }
      }
    } else {
      result = await client.query(v.sql);
    }
    await client.query("COMMIT");
    let rows: Record<string, unknown>[] = result.rows ?? [];
    let truncated = false;
    if (rows.length > rowCap) {
      rows = rows.slice(0, rowCap);
      truncated = true;
    }
    const columns = (result.fields ?? []).map((f) => f.name);
    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      ms: Date.now() - started,
    };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* already aborted */
    }
    throw e;
  } finally {
    client.release();
  }
}

export interface TableInfo {
  schema: string;
  name: string;
  type: string;
  columns: { name: string; type: string; nullable: boolean }[];
  pk: string[];
  fks: { column: string; references: string }[];
}

/** Introspect tables/columns/keys, filtered through the table allow-list. */
export async function introspectSchema(
  url: string,
  config: SetokuConfig,
  onlyTables?: string[],
): Promise<TableInfo[]> {
  const client = await poolFor(url).connect();
  try {
    const tablesRes = await client.query(`
      SELECT table_schema AS schema, table_name AS name, table_type AS type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY table_schema, table_name`);
    let tables = tablesRes.rows.filter((t: { schema: string; name: string }) =>
      isTableAllowed(config, t.schema, t.name),
    );
    if (onlyTables?.length) {
      const wanted = new Set(
        onlyTables.map((t) =>
          t.includes(".") ? t.toLowerCase() : `public.${t}`.toLowerCase(),
        ),
      );
      tables = tables.filter((t: { schema: string; name: string }) =>
        wanted.has(`${t.schema}.${t.name}`.toLowerCase()),
      );
    }
    const colsRes = await client.query(`
      SELECT table_schema AS schema, table_name AS table, column_name AS name,
             data_type AS type, is_nullable = 'YES' AS nullable
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY table_schema, table_name, ordinal_position`);
    const pkRes = await client.query(`
      SELECT tc.table_schema AS schema, tc.table_name AS table, kcu.column_name AS column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'`);
    const fkRes = await client.query(`
      SELECT tc.table_schema AS schema, tc.table_name AS table, kcu.column_name AS column,
             ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'`);
    const key = (s: string, t: string) => `${s}.${t}`;
    const byTable = new Map<string, TableInfo>(
      tables.map((t: { schema: string; name: string; type: string }) => [
        key(t.schema, t.name),
        { ...t, columns: [], pk: [], fks: [] },
      ]),
    );
    for (const c of colsRes.rows) {
      byTable
        .get(key(c.schema, c.table))
        ?.columns.push({ name: c.name, type: c.type, nullable: c.nullable });
    }
    for (const p of pkRes.rows) {
      byTable.get(key(p.schema, p.table))?.pk.push(p.column);
    }
    for (const f of fkRes.rows) {
      byTable
        .get(key(f.schema, f.table))
        ?.fks.push({
          column: f.column,
          references: `${f.ref_schema}.${f.ref_table}.${f.ref_column}`,
        });
    }
    return [...byTable.values()];
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end().catch(() => {})));
  pools.clear();
}
