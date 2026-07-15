// SPDX-License-Identifier: Apache-2.0
/**
 * The shared read-statement gate + query result shape. The gateway's only
 * query engine is ClickHouse (lib/lake.ts) — the direct business-Postgres
 * read path is retired, and the gateway holds no pg client or credential
 * (ingest/pg-mirror talks to the source DB with its own connection).
 */

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
  "DESCRIBE",
  "DESC",
  "EXISTS",
]);

/**
 * v0 statement gate: single read statement only. Defense in depth — the
 * engine enforces read-only regardless (readonly=2 on every lake request),
 * so anything that slips past the gate still cannot write.
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
