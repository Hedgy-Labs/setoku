// SPDX-License-Identifier: Apache-2.0
/**
 * Schema inference (Phase 4, task 4.5).
 *
 * Given a sample of event objects from a new/unknown source, infer ClickHouse
 * column types and emit CREATE TABLE DDL in the same column-comment style as
 * the hand-written tables in ingest/schemas/. Output goes through the plan/
 * apply confirmation gate — a human reviews the DDL before any table is made.
 *
 * Two design rules carry their weight here:
 *   - Nothing is ever DROPPED. Fields we cannot type confidently (objects,
 *     arrays, mixed types) collapse into a single `raw String` JSON column, so
 *     future/unknown fields are preserved rather than lost (task 4.5).
 *   - The inference is a PURE function of its input sample — fully unit-testable
 *     with no I/O (task 4.5).
 */

/** A ClickHouse column type we are willing to infer. */
export type ChType =
  | "String"
  | "LowCardinality(String)"
  | "Int64"
  | "Float64"
  | "DateTime64(3)"
  | "Bool";

export interface InferredColumn {
  name: string;
  type: ChType;
  /** A short COMMENT describing the column (matches ingest/schemas/ style). */
  comment: string;
}

export interface InferredSchema {
  columns: InferredColumn[];
  /** True if any field collapsed into `raw` (objects/arrays/mixed). */
  hasRaw: boolean;
  /** The column chosen for ORDER BY's leading timestamp, if any. */
  orderByTimestamp: string | null;
}

export interface InferOptions {
  /**
   * Fraction of distinct values (over the sample) below which a String column
   * is treated as LowCardinality. Default 0.5 — i.e. if a field repeats enough
   * that distinct/total < 0.5, it's an enum-ish dimension.
   */
  lowCardinalityRatio?: number;
  /**
   * Minimum sample rows before LowCardinality is even considered (a 2-row
   * sample with 1 distinct value isn't evidence of low cardinality). Default 5.
   */
  lowCardinalityMinRows?: number;
}

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Infer column types from a sample of event objects.
 *
 * Type precedence per field, computed over every non-null value seen:
 *   - all values parse as a timestamp (ISO-8601 string OR epoch-ms number) →
 *     DateTime64(3)
 *   - all values boolean → Bool
 *   - all values integer-valued numbers → Int64
 *   - all values numbers (some fractional) → Float64
 *   - all values strings → String, narrowed to LowCardinality(String) when the
 *     distinct/total ratio is low
 *   - anything else (objects, arrays, mixed types across rows) → the field is
 *     NOT given its own column; it survives inside the `raw` JSON column.
 */
export function inferColumns(
  sample: Record<string, unknown>[],
  opts: InferOptions = {},
): InferredSchema {
  const ratio = opts.lowCardinalityRatio ?? 0.5;
  const minRows = opts.lowCardinalityMinRows ?? 5;

  // Collect, per field, every non-null value across the sample (insertion
  // order of first appearance — keeps output deterministic for golden tests).
  const fields = new Map<string, unknown[]>();
  for (const row of sample) {
    for (const [key, value] of Object.entries(row)) {
      if (!fields.has(key)) fields.set(key, []);
      if (value !== null && value !== undefined) fields.get(key)!.push(value);
    }
  }

  const columns: InferredColumn[] = [];
  let hasRaw = false;

  for (const [name, values] of fields) {
    if (values.length === 0) {
      // Field present but always null/absent — keep it as a nullable String
      // placeholder rather than dropping it (nothing is ever lost).
      columns.push({
        name,
        type: "String",
        comment: `inferred from sample (always null/absent — typed as String)`,
      });
      continue;
    }

    const type = inferFieldType(values, { ratio, minRows, total: sample.length });
    if (type === null) {
      // Cannot type confidently (object/array/mixed) → goes into raw.
      hasRaw = true;
      continue;
    }
    columns.push({
      name,
      type,
      comment: commentFor(name, type, values),
    });
  }

  // Pick a leading timestamp column for ORDER BY: prefer a field literally
  // named ts/timestamp/event_ts/time, else the first DateTime64 column.
  const tsCols = columns.filter((c) => c.type === "DateTime64(3)");
  const preferred = ["ts", "timestamp", "event_ts", "time", "created_at"];
  let orderByTimestamp: string | null = null;
  for (const p of preferred) {
    const hit = tsCols.find((c) => c.name === p);
    if (hit) {
      orderByTimestamp = hit.name;
      break;
    }
  }
  if (!orderByTimestamp && tsCols.length > 0) orderByTimestamp = tsCols[0].name;

  return { columns, hasRaw, orderByTimestamp };
}

function inferFieldType(
  values: unknown[],
  ctx: { ratio: number; minRows: number; total: number },
): ChType | null {
  // Timestamp: every value is an ISO-8601 string or an epoch-ms number.
  if (values.every(isTimestampLike)) return "DateTime64(3)";

  // Bool: every value is a real boolean.
  if (values.every((v) => typeof v === "boolean")) return "Bool";

  // Numbers.
  if (values.every((v) => typeof v === "number" && Number.isFinite(v))) {
    const allInt = values.every((v) => Number.isInteger(v as number));
    return allInt ? "Int64" : "Float64";
  }

  // Strings → String, narrowed to LowCardinality when repetitive.
  if (values.every((v) => typeof v === "string")) {
    const distinct = new Set(values as string[]).size;
    const lowCard =
      ctx.total >= ctx.minRows && distinct / values.length < ctx.ratio;
    return lowCard ? "LowCardinality(String)" : "String";
  }

  // Mixed types, objects, arrays — cannot type → raw column.
  return null;
}

/** ISO-8601 string OR a plausible epoch-ms integer (>= year 2001). */
function isTimestampLike(v: unknown): boolean {
  if (typeof v === "string") return ISO_8601.test(v);
  if (typeof v === "number" && Number.isInteger(v)) {
    // Epoch milliseconds for a recent/realistic date: ~1e12 .. ~4e12.
    return v >= 1_000_000_000_000 && v <= 4_000_000_000_000;
  }
  return false;
}

function commentFor(name: string, type: ChType, values: unknown[]): string {
  if (type === "LowCardinality(String)") {
    const distinct = [...new Set(values as string[])].slice(0, 6);
    return `inferred LowCardinality (low distinct ratio in sample; e.g. ${distinct
      .map((d) => JSON.stringify(d))
      .join(", ")})`;
  }
  if (type === "DateTime64(3)") {
    return `inferred timestamp (${
      typeof values[0] === "number" ? "epoch-ms" : "ISO-8601"
    } in sample)`;
  }
  return `inferred ${type} from sample`;
}

/**
 * Render an InferredSchema as CREATE TABLE DDL matching ingest/schemas/ style:
 * aligned `name type COMMENT '...'` columns, a trailing `raw String` catch-all,
 * MergeTree, PARTITION BY toYYYYMM(ts), ORDER BY a timestamp when present.
 */
export function emitDDL(name: string, schema: InferredSchema): string {
  const cols: InferredColumn[] = [...schema.columns];
  // Always append the raw catch-all (task 4.5: future fields are never lost).
  cols.push({
    name: "raw",
    type: "String",
    comment: "full original event JSON — nothing is dropped",
  });

  const nameW = Math.max(...cols.map((c) => c.name.length));
  const typeW = Math.max(...cols.map((c) => c.type.length));
  const lines = cols.map((c, i) => {
    const isLast = i === cols.length - 1;
    const namePad = c.name.padEnd(nameW);
    const typePad = c.type.padEnd(typeW);
    return `    ${namePad} ${typePad} COMMENT ${sqlString(c.comment)}${
      isLast ? "" : ","
    }`;
  });

  const ts = schema.orderByTimestamp;
  const orderBy = ts ? `(${ts})` : `(raw)`;
  const partition = ts ? `PARTITION BY toYYYYMM(${ts})` : null;

  const out: string[] = [];
  out.push(`-- SPDX-License-Identifier: Apache-2.0`);
  out.push(
    `-- Inferred from a sample of ${name} events by the Setoku provisioner`,
  );
  out.push(
    `-- (task 4.5). Review before applying — a human confirms the DDL (4.1).`,
  );
  out.push(`CREATE TABLE IF NOT EXISTS setoku.${name}`);
  out.push(`(`);
  out.push(lines.join("\n"));
  out.push(`)`);
  out.push(`ENGINE = MergeTree`);
  if (partition) out.push(partition);
  out.push(`ORDER BY ${orderBy}`);
  if (!ts) {
    out.push(
      `-- NOTE: no timestamp column detected in the sample; ORDER BY falls`,
    );
    out.push(`-- back to (raw). Pick a real sort key once the shape is known.`);
  }
  out.push(`;`);
  return out.join("\n");
}

/** Single-quote and escape a string for a SQL literal. */
function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Convenience: sample → DDL in one call. */
export function inferTableDDL(
  name: string,
  sample: Record<string, unknown>[],
  opts?: InferOptions,
): { schema: InferredSchema; ddl: string } {
  const schema = inferColumns(sample, opts);
  return { schema, ddl: emitDDL(name, schema) };
}
