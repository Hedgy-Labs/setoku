// SPDX-License-Identifier: Apache-2.0
/**
 * Success-path knowledge-capture nudges — pure, so they unit-test without a box.
 *
 * The empty-store warnings (run_query, find_context) prompt hardest when the
 * store knows least and go silent the moment retrieval starts hitting — which
 * is exactly when real usage produces the most learnable material. Measured on
 * the pilot: correction intake died the week the store stopped being empty,
 * while query volume kept growing. These helpers put a hint in the SUCCESS
 * path instead: when a query (or a published app panel) just computed a
 * business aggregate that no curated metric covers, the tool result carries a
 * one-line report_correction suggestion at the moment the SQL is fresh and
 * validated. Propose-only (lands as pending, human approves) — the membrane
 * (I2/I9) is untouched.
 */

/** Collapse whitespace/comments/case so cosmetically different SQL compares equal. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;+$/, "")
    .trim()
    .toLowerCase();
}

/** Schema/metadata exploration — never worth capturing as a metric. */
export function isExploratorySql(sql: string): boolean {
  const n = normalizeSql(sql);
  return (
    /^(show|describe|desc|explain)\b/.test(n) ||
    /\b(information_schema|pg_catalog|pg_tables|pg_class|pg_namespace|sqlite_master|system)\./.test(n)
  );
}

/** A query that computes a business fact rather than fetching rows to read. */
export function isAggregateShaped(sql: string): boolean {
  const n = normalizeSql(sql);
  return (
    /\bgroup by\b/.test(n) ||
    /\b(count|sum|avg|min|max|median|percentile_cont|percentile_disc|countif|sumif|avgif|uniq|uniqexact|quantile\w*)\s*\(/.test(n)
  );
}

/**
 * Whether a curated doc's SQL already covers this query. Containment (either
 * direction, normalized) rather than equality: agents routinely take canonical
 * metric SQL and add a date filter or wrap it in a WITH — that's still covered.
 */
export function coveredByCurated(sql: string, curatedSqls: string[]): boolean {
  const n = normalizeSql(sql);
  if (!n) return false;
  return curatedSqls.some((c) => {
    const cn = normalizeSql(c);
    return cn.length > 0 && (n.includes(cn) || cn.includes(n));
  });
}

/**
 * The run_query success-path hint, or null when the query isn't capture-worthy
 * (exploration, non-aggregate, or a curated metric already covers it).
 */
export function queryCaptureNudge(sql: string, curatedSqls: string[]): string | null {
  if (isExploratorySql(sql) || !isAggregateShaped(sql)) return null;
  if (coveredByCurated(sql, curatedSqls)) return null;
  return (
    "💡 No curated metric covers this query. If it answered a real business question " +
    "(not one-off exploration), capture the definition now with report_correction " +
    '(kind:"metric" — include this SQL and what it means in business terms). It lands as ' +
    "pending for a human to approve, and the whole team gets it next time."
  );
}

/**
 * publish/update_app note listing panels whose aggregate SQL no curated metric
 * covers (and that declare no metricId provenance). Null when every panel is
 * covered, linked, or non-aggregate.
 */
export function panelCaptureNote(
  panels: { key: string; sql: string; metricId?: string | null }[],
  curatedSqls: string[],
): string | null {
  const uncovered = panels
    .filter((p) => !p.metricId)
    .filter((p) => !isExploratorySql(p.sql) && isAggregateShaped(p.sql))
    .filter((p) => !coveredByCurated(p.sql, curatedSqls))
    .map((p) => `"${p.key}"`);
  if (!uncovered.length) return null;
  return (
    `panel(s) ${uncovered.join(", ")} compute aggregates no curated metric covers — you just ` +
    "validated these definitions, so capture the reusable ones with report_correction " +
    '(kind:"metric", one per panel, include the SQL); once approved, link them via `metricId`.'
  );
}
