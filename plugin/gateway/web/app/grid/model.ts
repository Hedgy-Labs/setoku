// SPDX-License-Identifier: Apache-2.0
/**
 * The pure half of the file grid: number reading, the filtered + sorted VIEW,
 * the per-column value list a filter menu shows, range statistics, and the
 * serializers behind copy (TSV + HTML) and "download these rows" (CSV). No DOM,
 * so it's unit-tested directly (test/file-grid-model.test.ts).
 *
 * Rows are `string[][]` indexed like `columns`. A VIEW is a list of data-row
 * indices; row numbers shown to the viewer are always `dataIndex + 1`, so a
 * record keeps its number under any sort or filter.
 */

/** Numbers as a spreadsheet reads them: "$1,200", "12%", "(40)" (negative).
 *  NaN for blanks and text. */
export function numOf(v: string): number {
  let s = v.replace(/[\s,$€£%]/g, "");
  const neg = s.startsWith("(") && s.endsWith(")");
  if (neg) s = s.slice(1, -1);
  if (s === "" || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return NaN;
  return neg ? -Number(s) : Number(s);
}

/** A column is numeric when ≥90% of its first 400 non-empty values are numbers
 *  (right-aligned, sorted numerically, and summed in a range). */
export function numericColumns(ncols: number, rows: string[][]): boolean[] {
  const out: boolean[] = [];
  for (let c = 0; c < ncols; c++) {
    let seen = 0;
    let hit = 0;
    for (let d = 0; d < rows.length && seen < 400; d++) {
      const v = rows[d][c];
      if (!v) continue;
      seen++;
      if (!Number.isNaN(numOf(v))) hit++;
    }
    out.push(seen > 0 && hit / seen >= 0.9);
  }
  return out;
}

/** Column → the set of values HIDDEN by its filter (absent = unfiltered). */
export type Filters = ReadonlyMap<number, ReadonlySet<string>>;
export interface Sort {
  col: number;
  dir: 1 | -1;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const compareText = (a: string, b: string): number => collator.compare(a, b);

/** Does data row `row` pass every filter except `skip`'s? */
export function passes(row: string[], filters: Filters, skip = -1): boolean {
  for (const [c, hidden] of filters) if (c !== skip && hidden.has(row[c] ?? "")) return false;
  return true;
}

/** The data-row indices to show, in order: filters AND across columns, then a
 *  stable sort. Blanks (and, in a numeric column, non-numbers) sort last in
 *  either direction, as in Sheets. */
export function computeView(rows: string[][], filters: Filters, sort: Sort | null, isNum: boolean[]): number[] {
  const view: number[] = [];
  for (let d = 0; d < rows.length; d++) if (!filters.size || passes(rows[d], filters)) view.push(d);
  if (!sort) return view;
  const { col, dir } = sort;
  if (isNum[col]) {
    const key = new Float64Array(rows.length);
    for (const d of view) key[d] = numOf(rows[d][col]);
    view.sort((a, b) => {
      const x = key[a];
      const y = key[b];
      const xn = Number.isNaN(x);
      const yn = Number.isNaN(y);
      if (xn || yn) return xn && yn ? a - b : xn ? 1 : -1;
      return x === y ? a - b : (x < y ? -1 : 1) * dir;
    });
  } else {
    view.sort((a, b) => {
      const x = rows[a][col];
      const y = rows[b][col];
      if (!x || !y) return x === y ? a - b : !x ? 1 : -1;
      const r = compareText(x, y);
      return r === 0 ? a - b : r * dir;
    });
  }
  return view;
}

/** A filter menu's value list: each distinct value of `col` among the rows that
 *  pass the OTHER columns' filters (Sheets does the same), with its count,
 *  sorted (numerically for a numeric column; blanks last). */
export function valueCounts(rows: string[][], col: number, filters: Filters, isNum: boolean): { values: string[]; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  for (const r of rows) if (!filters.size || passes(r, filters, col)) counts.set(r[col] ?? "", (counts.get(r[col] ?? "") ?? 0) + 1);
  const values = [...counts.keys()].sort((a, b) => {
    if (!a || !b) return a === b ? 0 : !a ? 1 : -1;
    if (isNum) {
      const x = numOf(a);
      const y = numOf(b);
      if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y;
    }
    return compareText(a, b);
  });
  return { values, counts };
}

/** A rectangular selection in VIEW rows and columns, inclusive. */
export interface Range {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
}

/** Sheets' status-bar numbers for a range: non-empty count, and the sum/count
 *  of its numeric cells. */
export function rangeStats(rows: string[][], view: number[], R: Range): { count: number; nums: number; sum: number } {
  let count = 0;
  let nums = 0;
  let sum = 0;
  for (let vi = R.r1; vi <= R.r2; vi++) {
    const row = rows[view[vi]];
    for (let c = R.c1; c <= R.c2; c++) {
      const v = row[c];
      if (!v) continue;
      count++;
      const x = numOf(v);
      if (!Number.isNaN(x)) {
        nums++;
        sum += x;
      }
    }
  }
  return { count, nums, sum };
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A TSV field as spreadsheets expect on paste: quoted only when it holds a
 *  tab, newline, or quote (quotes doubled). */
const tsvField = (v: string): string => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** An RFC 4180 CSV field. */
const csvField = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The range as TSV (plain text) and an HTML table, for the clipboard. With
 *  `header`, the column names lead (a whole-column or select-all copy). */
export function rangeToClipboard(columns: string[], rows: string[][], view: number[], R: Range, header: boolean): { text: string; html: string } {
  const lines: string[] = [];
  const html: string[] = ["<table>"];
  if (header) {
    const cs = columns.slice(R.c1, R.c2 + 1);
    lines.push(cs.map(tsvField).join("\t"));
    html.push(`<tr>${cs.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`);
  }
  for (let vi = R.r1; vi <= R.r2; vi++) {
    const cs = rows[view[vi]].slice(R.c1, R.c2 + 1);
    lines.push(cs.map(tsvField).join("\t"));
    html.push(`<tr>${cs.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`);
  }
  html.push("</table>");
  return { text: lines.join("\n"), html: html.join("") };
}

/** The view (every column, header first) as a CSV file body. */
export function viewToCsv(columns: string[], rows: string[][], view: number[]): string {
  const out = [columns.map(csvField).join(",")];
  for (const d of view) out.push(rows[d].map(csvField).join(","));
  return out.join("\r\n") + "\r\n";
}

/** "report.tsv" → "report (filtered).csv". */
export function filteredName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "rows";
  return `${base} (filtered).csv`;
}
