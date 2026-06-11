// SPDX-License-Identifier: Apache-2.0
/**
 * ClickHouse (lake) query path — run_query's `clickhouse` dialect (I5).
 *
 * Read-only is enforced by the engine, not by SQL parsing (I9): every request
 * carries readonly=2 (queries may not write or DDL; ClickHouse rejects them
 * server-side), with the shared first-keyword gate as defense in depth. The
 * reference deploy goes further: SETOKU_LAKE_URL connects as `setoku_ro`
 * (deploy/clickhouse/lake-users.xml), whose grants exclude table functions
 * (url/remote — no SSRF surface) and whose profile pins readonly and
 * CONSTRAINS max_execution_time so a query-level SETTINGS clause cannot lift
 * it. Row cap via LIMIT wrap + server-side max_result_rows; timeout via
 * max_execution_time; mid-stream errors surface via wait_end_of_query.
 */
import { validateSql, type QueryOutcome } from "./db";
import type { SetokuConfig } from "./config";

export interface LakeTarget {
  endpoint: string;
  auth?: string;
  database?: string;
}

/** Split http://user:pass@host:8123/db into endpoint + basic-auth + database. */
export function parseLakeUrl(raw: string): LakeTarget {
  const u = new URL(raw);
  const auth = u.username
    ? `Basic ${btoa(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`)}`
    : undefined;
  const database = u.pathname.replace(/^\//, "") || undefined;
  return { endpoint: u.origin, auth, database };
}

interface ChJson {
  meta?: { name: string }[];
  data?: Record<string, unknown>[];
  exception?: string;
}

export async function runLakeQuery(
  rawUrl: string,
  sql: string,
  {
    rowCap,
    statementTimeoutMs,
  }: Pick<SetokuConfig, "rowCap" | "statementTimeoutMs">,
): Promise<QueryOutcome> {
  const v = validateSql(sql);
  if (!v.ok) throw new Error(v.error);
  const target = parseLakeUrl(rawUrl);
  const started = Date.now();

  const exec = async (q: string): Promise<ChJson> => {
    const params = new URLSearchParams({
      readonly: "2", // engine-enforced read-only: writes/DDL rejected server-side
      max_execution_time: String(
        Math.max(1, Math.ceil(statementTimeoutMs / 1000)),
      ),
      // server-side cap too — covers statements the LIMIT wrap can't reach
      max_result_rows: String(rowCap + 1),
      result_overflow_mode: "break",
      // buffer the whole result so a mid-stream error can never arrive as a
      // 200 with partial data (it would be silently wrong answers)
      wait_end_of_query: "1",
      default_format: "JSON",
    });
    if (target.database) params.set("database", target.database);
    const res = await fetch(`${target.endpoint}/?${params}`, {
      method: "POST",
      headers: {
        ...(target.auth ? { authorization: target.auth } : {}),
        "content-type": "text/plain",
      },
      body: q,
      signal: AbortSignal.timeout(statementTimeoutMs + 5_000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`ClickHouse: ${body.slice(0, 500)}`);
    if (!body) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(
        "ClickHouse returned non-JSON output — remove any FORMAT clause from the SQL (results are always returned as JSON).",
      );
    }
    if (typeof parsed !== "object" || parsed === null || !("meta" in parsed)) {
      throw new Error(
        "ClickHouse returned an unexpected response shape — remove any FORMAT clause from the SQL (results are always returned as JSON).",
      );
    }
    const out = parsed as ChJson;
    // an error can still surface inside a 200 body — never return it as data
    if (out.exception) throw new Error(`ClickHouse: ${out.exception.slice(0, 500)}`);
    return out;
  };

  let out: ChJson;
  if (v.kind === "SELECT" || v.kind === "WITH") {
    try {
      out = await exec(
        `SELECT * FROM (\n${v.sql}\n) AS _setoku_q LIMIT ${rowCap + 1}`,
      );
    } catch (e) {
      if (/Syntax error/i.test(String(e))) {
        out = await exec(v.sql); // rare valid-SQL edge the wrap breaks — run raw
      } else {
        throw e;
      }
    }
  } else {
    out = await exec(v.sql);
  }

  let rows = out.data ?? [];
  let truncated = false;
  if (rows.length > rowCap) {
    rows = rows.slice(0, rowCap);
    truncated = true;
  }
  return {
    columns: (out.meta ?? []).map((m) => m.name),
    rows,
    rowCount: rows.length,
    truncated,
    ms: Date.now() - started,
  };
}
