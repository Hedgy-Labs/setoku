// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge lint core (curation-cockpit-spec piece D) — model-free (I8).
 *
 * Executes the canonical SQL embedded in metric/query docs against the LIVE
 * business DB and sanity-checks the result. Two ways to know a value is wrong:
 *
 *  • BOUNDS-IN-DOC (preferred): the metric's frontmatter declares its own
 *    invariant — `expect: "0 < value <= 1"`, `unit: cents`, `expect_nonempty:
 *    true`. The lint verifies the AUTHOR'S claim, which kills the false
 *    positives a guessed heuristic produces.
 *  • HEURISTICS (fallback, no declared bounds): column-name patterns that catch
 *    the classic unit/inversion bugs (a ratio outside [0,1], cents read as
 *    dollars). Ported from the demo lint.
 *
 * Everything here is PURE (no DB, no store) so it unit-tests without a box; the
 * CLI (knowledge-lint.ts) supplies the SQL runner and the store.
 */

/** Pull runnable SQL statements out of a doc body's ```sql fences. */
export function extractSql(body: string): string[] {
  return [...body.matchAll(/```sql\s*([\s\S]*?)```/g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    // only lint runnable statements — skip illustrative expression fragments
    .filter((s) => /^\s*(--.*\n|\s)*\s*(select|with|explain)\b/i.test(s));
}

/** Column-name heuristics (used only when the doc declares no `expect`). */
const HEURISTICS: { match: RegExp; bad: (n: number) => boolean; why: string }[] = [
  { match: /discount|realiz|share|ratio|renewal|sell_through|rate$|_rate\b|pct/i, bad: (n) => n < -0.01 || n > 1.5, why: "ratio/rate out of [0,1] — inverted or mis-scaled" },
  { match: /per_cap|avg.*price|price.*avg|per_attendee/i, bad: (n) => n > 500 || n < 0, why: "per-cap/avg-price implausible — likely cents read as dollars (×100)" },
  { match: /revenue|dollars|booked|contract|value|cost|spend|amt/i, bad: (n) => Math.abs(n) > 1e11, why: "magnitude huge — likely a cents/dollars unit error" },
];

type Cmp = "<" | "<=" | ">" | ">=" | "==" | "!=";
function cmp(a: number, op: Cmp, b: number): boolean {
  switch (op) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "==": return a === b;
    case "!=": return a !== b;
  }
}
function normOp(raw: string): Cmp | null {
  const o = raw.trim();
  if (o === "=" ) return "==";
  if (["<", "<=", ">", ">=", "==", "!="].includes(o)) return o as Cmp;
  return null;
}

/**
 * Evaluate a declared bound against a value. Grammar (case/space-insensitive):
 *   "value <op> <num>"          e.g. "value >= 0"
 *   "<num> <op> value"          e.g. "0 <= value"
 *   "<num> <op> value <op> <num>"  e.g. "0 < value <= 1"
 * Returns a reason string when violated, null when satisfied, and null (treated
 * as "can't check") when the expression doesn't parse.
 */
export function evaluateExpect(expr: string, value: number): string | null {
  const e = String(expr).toLowerCase().trim();
  if (!e.includes("value")) return null;
  const [left, right] = e.split("value");
  const checks: { op: Cmp; bound: number }[] = [];
  // left side: "<num> <op>" → bound <op> value  ⇒  value <reversed-op> bound
  const lm = left.trim().match(/^(-?\d+(?:\.\d+)?)\s*(<=|>=|<|>|==|!=|=)\s*$/);
  if (lm) {
    const op = normOp(lm[2]);
    if (op) {
      // "bound op value" ⇒ "value flip(op) bound"
      const flip: Record<Cmp, Cmp> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" };
      checks.push({ op: flip[op], bound: Number(lm[1]) });
    }
  }
  // right side: "<op> <num>" → value <op> bound
  const rm = right.trim().match(/^(<=|>=|<|>|==|!=|=)\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (rm) {
    const op = normOp(rm[1]);
    if (op) checks.push({ op, bound: Number(rm[2]) });
  }
  if (!checks.length) return null;
  for (const c of checks) {
    if (!cmp(value, c.op, c.bound))
      return `value ${value} violates expect "${expr.trim()}"`;
  }
  return null;
}

export interface LintResult {
  /** Per-statement outcome (parsed numeric cells), supplied by the runner. */
  cols: string[];
  rows: string[][];
  error?: string;
}

export interface DocLintInput {
  name: string;
  meta: Record<string, string | string[]>;
  body: string;
}

export interface DocLintReport {
  name: string;
  status: "pass" | "warn" | "fail" | "no-sql";
  problems: string[];
  ranOk: number;
}

const truthy = (v: unknown): boolean =>
  v === true || v === "true" || v === "1" || v === 1 || v === "yes";

/** Numeric columns to apply a declared `expect` to: the column literally named
 *  `value` if present, else every numeric column (best-effort). */
function expectTargets(cols: string[]): Set<number> {
  const valueIdx = cols.findIndex((c) => c.trim().toLowerCase() === "value");
  if (valueIdx >= 0) return new Set([valueIdx]);
  return new Set(cols.map((_, i) => i)); // applied per-cell only when numeric
}

const num = (s: string | undefined): number => Number(String(s ?? "").replace(/[$,%\s]/g, ""));

/**
 * Lint one doc given its already-run statement results. Pure: the caller runs
 * the SQL and parses the text table into {cols, rows, error?}. Bounds-in-doc
 * (`expect`/`expect_nonempty`) wins; otherwise the column-name heuristics apply.
 */
export function lintDocResults(doc: DocLintInput, results: LintResult[]): DocLintReport {
  if (!results.length) return { name: doc.name, status: "no-sql", problems: [], ranOk: 0 };
  const expect = typeof doc.meta.expect === "string" ? doc.meta.expect : undefined;
  const expectNonempty = truthy(doc.meta.expect_nonempty);
  const problems: string[] = [];
  let ranOk = 0;

  for (const r of results) {
    if (r.error) { problems.push(`SQL error: ${r.error}`); continue; }
    if (!r.rows.length) {
      if (expectNonempty) problems.push("returned 0 rows but expect_nonempty");
      else problems.push("returned 0 rows");
      continue;
    }
    ranOk++;
    const targets = expect ? expectTargets(r.cols) : null;
    for (const row of r.rows) {
      r.cols.forEach((col, i) => {
        const n = num(row[i]);
        if (!Number.isFinite(n)) return;
        if (expect && targets!.has(i)) {
          const why = evaluateExpect(expect, n);
          if (why) problems.push(`${col}: ${why}`);
        } else if (!expect) {
          for (const h of HEURISTICS) if (h.match.test(col) && h.bad(n)) problems.push(`${col}=${row[i]} → ${h.why}`);
        }
      });
    }
  }

  const uniq = [...new Set(problems)];
  if (!uniq.length) return { name: doc.name, status: "pass", problems: [], ranOk };
  const sev = uniq.some((p) => p.startsWith("SQL error") || /inverted|cents|violates expect|expect_nonempty/.test(p))
    ? "fail"
    : "warn";
  return { name: doc.name, status: sev, problems: uniq, ranOk };
}

/** Parse the gateway/run_query-style text table → {cols, rows} (shared with the
 *  CLI, which formats DB output the same way). */
export function parseResultTable(cols: string[], rows: Record<string, unknown>[]): LintResult {
  return {
    cols,
    rows: rows.map((row) => cols.map((c) => {
      const v = row[c];
      return v === null || v === undefined ? "" : String(v);
    })),
  };
}
