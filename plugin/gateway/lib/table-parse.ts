// SPDX-License-Identifier: Apache-2.0
/**
 * Tabular-file parsing (CSV/TSV and JSON arrays of flat objects) with no Node or
 * Bun dependency, so the SAME code runs on the server and in the browser: the
 * file viewer downloads a shared file's raw bytes and parses them client-side
 * (web/app/grid/), which keeps the per-view cost off the box entirely.
 *
 * The core returns rows as ARRAYS (`string[][]`, indexed like `columns`): a
 * 500k-row file must not repeat every column name in every row object. The
 * object-shaped wrappers remain for callers that index by column name.
 */

/** The mimes the viewer renders as a grid. */
export function isTabularMime(mime: string): boolean {
  return mime === "text/csv" || mime === "text/tab-separated-values" || mime === "application/json";
}

export interface ParsedRows {
  columns: string[];
  rows: string[][];
  /** More rows existed than `maxRows`; the rows are a prefix. */
  truncated: boolean;
}

/** Distinct, non-empty column keys: duplicate or blank header cells get a
 *  stable suffix. A suffixed name can itself collide with a literal header
 *  ("a,a,a_2"), so keep going until the candidate is genuinely unused. */
function distinctColumns(header: string[]): string[] {
  const seen = new Set<string>();
  return header.map((h, idx) => {
    const base = h.trim() || `col${idx + 1}`;
    let name = base;
    for (let k = 2; seen.has(name); k++) name = `${base}_${k}`;
    seen.add(name);
    return name;
  });
}

/**
 * RFC 4180 CSV/TSV → columns + row arrays. Quoted fields, doubled-quote escapes,
 * newlines inside quotes, CRLF or LF, a leading BOM. The first record is the
 * header. Every row is padded/cut to the header's width. Parsing stops after
 * `maxRows` data rows (default: no limit).
 */
export function parseDelimitedRows(text: string, delim: string, maxRows = Infinity): ParsedRows {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let i = 0;
  const n = text.length;
  const endRecord = (): boolean => {
    record.push(field);
    field = "";
    // A blank line (one empty field) between records is ignored, as is the
    // trailing newline every well-formed file ends with.
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
    // Stop once we hold header + maxRows + ONE extra record: the extra is how
    // we know the file went on (truncated) without parsing the rest of it.
    return records.length > maxRows + 1;
  };
  let broke = false;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      // Copy the run up to the next quote in one slice (long quoted notes).
      const q = text.indexOf('"', i);
      const end = q < 0 ? n : q;
      field += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (c === delim) {
      record.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      i++;
      if (endRecord()) {
        broke = true;
        break;
      }
      continue;
    }
    field += c;
    i++;
  }
  if (!broke && (field !== "" || record.length)) endRecord(); // no trailing newline
  const truncated = records.length > maxRows + 1;
  if (truncated) records.length = maxRows + 1;
  if (!records.length) return { columns: [], rows: [], truncated: false };
  const columns = distinctColumns(records[0]);
  const w = columns.length;
  const rows = records.slice(1).map((r) => {
    if (r.length === w) return r;
    const out = r.slice(0, w);
    while (out.length < w) out.push("");
    return out;
  });
  return { columns, rows, truncated };
}

/** A JSON file that is an ARRAY OF FLAT OBJECTS → columns + row arrays; anything
 *  else (an object, a scalar, an empty array) is null. Column order is first
 *  appearance across the rows; nested values render as their JSON. */
export function parseJsonRows(text: string, maxRows = Infinity): ParsedRows | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || !v.length) return null;
  if (!v.every((r) => r && typeof r === "object" && !Array.isArray(r))) return null;
  const columns: string[] = [];
  const index = new Map<string, number>();
  const truncated = v.length > maxRows;
  const objs = (truncated ? v.slice(0, maxRows) : v) as Record<string, unknown>[];
  for (const r of objs)
    for (const k of Object.keys(r))
      if (!index.has(k)) {
        index.set(k, columns.length);
        columns.push(k);
      }
  const rows = objs.map((r) => {
    const out = new Array<string>(columns.length).fill("");
    for (const [k, val] of Object.entries(r))
      out[index.get(k)!] = val == null ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
    return out;
  });
  return { columns, rows, truncated };
}

/** Parse a tabular file by mime, or null when it isn't a table after all (JSON
 *  that isn't an array of rows, a CSV with no header). */
export function parseTabular(text: string, mime: string, maxRows = Infinity): ParsedRows | null {
  const t =
    mime === "application/json" ? parseJsonRows(text, maxRows) : parseDelimitedRows(text, mime === "text/tab-separated-values" ? "\t" : ",", maxRows);
  return t && t.columns.length ? t : null;
}

/* ------------------- object-shaped rows (index by column) ------------------ */

export interface ParsedTable {
  columns: string[];
  rows: Record<string, string>[];
  truncated: boolean;
}

function toObjects(t: ParsedRows): ParsedTable {
  return {
    columns: t.columns,
    rows: t.rows.map((r) => {
      const o: Record<string, string> = {};
      t.columns.forEach((c, idx) => (o[c] = r[idx] ?? ""));
      return o;
    }),
    truncated: t.truncated,
  };
}

/** parseDelimitedRows, with each row an object keyed by column name. */
export function parseDelimited(text: string, delim: string, maxRows = 25_000): ParsedTable {
  return toObjects(parseDelimitedRows(text, delim, maxRows));
}

/** parseJsonRows, with each row an object keyed by column name. */
export function parseJsonTable(text: string, maxRows = 25_000): ParsedTable | null {
  const t = parseJsonRows(text, maxRows);
  return t ? toObjects(t) : null;
}
