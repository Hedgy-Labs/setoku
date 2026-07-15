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
 *
 * Everything here is a heuristic feeding one advisory line; a wrong verdict
 * costs a spurious or missing hint, never data. The predicates still lex
 * literals properly (a one-pass scanner, same technique as lib/params.ts)
 * because naive comment-stripping corrupts SQL like `slug = 'my--post'`.
 */

/** One pass over `sql`: drop comments (literal-aware), collapse whitespace,
 *  lowercase, strip trailing semicolons. Returns three views of the same scan:
 *  `normalized` keeps string-literal contents (for containment comparison);
 *  `skeleton` blanks them to `'?'` so shape predicates never match text the
 *  query merely filters on (`label = 'sum(total)'`); `identSkeleton` blanks
 *  only '…' string literals and UNWRAPS "…" quoted identifiers (pg quoting for
 *  camelCase names), so table-reference predicates can see `FROM "DealPipeline"`
 *  as `from dealpipeline` without matching literal text. */
function lex(sql: string): { normalized: string; skeleton: string; identSkeleton: string } {
  let norm = "";
  let skel = "";
  let ident = "";
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    // line comment: -- … to end of line
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      norm += " ";
      skel += " ";
      ident += " ";
      continue;
    }
    // block comment: /* … */ (non-nesting — fine for a heuristic on both dialects)
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      norm += " ";
      skel += " ";
      ident += " ";
      continue;
    }
    // string literal / quoted identifier: '…' or "…" (a doubled quote escapes)
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      const chunk = sql.slice(i, j).toLowerCase();
      norm += chunk;
      skel += `${c}?${c}`;
      ident += c === '"' ? chunk.replace(/"/g, "") : "'?'";
      i = j;
      continue;
    }
    norm += c.toLowerCase();
    skel += c.toLowerCase();
    ident += c.toLowerCase();
    i += 1;
  }
  const squash = (s: string): string =>
    s.replace(/\s+/g, " ").trim().replace(/[\s;]+$/, "").trim();
  return { normalized: squash(norm), skeleton: squash(skel), identSkeleton: squash(ident) };
}

/** Comment-stripped, whitespace/case-collapsed SQL for comparison. Literal
 *  contents survive intact (comment markers inside them included). */
export function normalizeSql(sql: string): string {
  return lex(sql).normalized;
}

/** Schema/metadata exploration — never worth capturing as a metric. */
export function isExploratorySql(sql: string): boolean {
  const s = lex(sql).skeleton;
  return (
    /^(show|describe|desc|explain)\b/.test(s) ||
    /\b(information_schema|pg_catalog|pg_tables|pg_class|pg_namespace|sqlite_master|system)\./.test(s)
  );
}

const AGG_FNS =
  "count|sum|avg|min|max|median|percentile_cont|percentile_disc|countif|sumif|avgif|uniq|uniqexact|quantile\\w*";
/** `fn( args ) over (` — a window call: per-row math, not a business fact.
 *  One nesting level of parens in the args is enough for a heuristic. */
const WINDOW_CALL = new RegExp(
  `\\b(?:${AGG_FNS})\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s+over\\s*\\(`,
  "g",
);
const AGG_CALL = new RegExp(`\\b(?:${AGG_FNS})\\s*\\(`);

/** A query that computes a business fact rather than fetching rows to read.
 *  Judged on the literal-blanked skeleton, with window calls removed first —
 *  `sum(x) OVER (…)` fetches rows, it doesn't define a metric. */
export function isAggregateShaped(sql: string): boolean {
  const s = lex(sql).skeleton.replace(WINDOW_CALL, " over (");
  return /\bgroup by\b/.test(s) || AGG_CALL.test(s);
}

/** `needle` occurs in `hay` at word boundaries on both ends — so curated
 *  `… from orders` never claims `… from orders_archive`. */
function containsAtBoundary(hay: string, needle: string): boolean {
  const isWord = (ch: string | undefined): boolean => ch !== undefined && /[\w$]/.test(ch);
  for (let idx = hay.indexOf(needle); idx !== -1; idx = hay.indexOf(needle, idx + 1)) {
    if (!isWord(hay[idx - 1]) && !isWord(hay[idx + needle.length])) return true;
  }
  return false;
}

/**
 * Whether a curated doc's SQL already covers this query: the query CONTAINS
 * the curated SQL at token boundaries. Containment rather than equality
 * because agents routinely take canonical metric SQL and add a date filter or
 * wrap it in a WITH — that's still covered. One direction only: a broad query
 * that merely appears as a fragment inside a narrower curated metric computes
 * a number no metric defines, so it should still nudge.
 */
export function coveredByCurated(sql: string, curatedSqls: string[]): boolean {
  const n = normalizeSql(sql);
  if (!n) return false;
  return curatedSqls.some((c) => {
    const cn = normalizeSql(c);
    return cn.length > 0 && containsAtBoundary(n, cn);
  });
}

/**
 * The run_query success-path hint, or null when the query isn't capture-worthy
 * (exploration, non-aggregate, or a curated metric already covers it).
 * `curatedSqls` is a thunk so callers on the hot query path only pay the
 * store scan once the cheap shape gates have passed.
 */
export function queryCaptureNudge(sql: string, curatedSqls: () => string[]): string | null {
  if (isExploratorySql(sql) || !isAggregateShaped(sql)) return null;
  if (coveredByCurated(sql, curatedSqls())) return null;
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
 * covered, linked, or non-aggregate — decided before the `curatedSqls` thunk
 * runs, so a zero-panel or non-aggregate publish never scans the store.
 */
export function panelCaptureNote(
  panels: { key: string; sql: string; metricId?: string | null }[],
  curatedSqls: () => string[],
): string | null {
  const candidates = panels
    .filter((p) => !p.metricId)
    .filter((p) => !isExploratorySql(p.sql) && isAggregateShaped(p.sql));
  if (!candidates.length) return null;
  const curated = curatedSqls();
  const uncovered = candidates
    .filter((p) => !coveredByCurated(p.sql, curated))
    .map((p) => `"${p.key}"`);
  if (!uncovered.length) return null;
  return (
    `panel(s) ${uncovered.join(", ")} compute aggregates no curated metric covers — you just ` +
    "validated these definitions, so capture the reusable ones with report_correction " +
    '(kind:"metric", one per panel, include the SQL); once approved, link them via `metricId`.'
  );
}
