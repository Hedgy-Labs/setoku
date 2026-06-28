// SPDX-License-Identifier: Apache-2.0
/**
 * Bound parameters for live apps — the seam that turns a static
 * app into an interactive one without spending an invariant.
 *
 * The crux: a viewer's input is UNTRUSTED text, so it reaches SQL only as an
 * engine-bound parameter — never concatenated. The author declares typed params
 * (`AppParam`); a panel references them with `:name` tokens; we coerce
 * each viewer value to its declared type (the whitelist) and compile the token
 * into the engine's native placeholder ($n for Postgres, {name:Type} for
 * ClickHouse). Values are bound, never spliced.
 *
 * What this guarantees:
 *  - Injection is structurally impossible (the statement shape is fixed by the
 *    author; viewer input is a bound scalar coerced to a declared type).
 *  - The membrane is untouched (I2/I9): a parameterized panel is still a READ
 *    through the gateway's own role with the same caps/audit.
 *  - No param can name a table or column — identifiers aren't bindable — and no
 *    param can drive a write. Inputs select among governed reads; they never
 *    expand what the session can reach.
 *
 * Scalar params only (date/int/text/bool/enum). A "date range" control is two
 * `date` params composed in the shell, not a distinct bindable type.
 */

export type ParamType = "date" | "int" | "text" | "bool" | "enum";

export interface ParamOption {
  value: string;
  label?: string;
}

export interface AppParam {
  /** Binding identifier — referenced in panel SQL as `:name`. */
  name: string;
  /** Human label for the shell-rendered control (chrome, not the template). */
  label?: string;
  type: ParamType;
  /** REQUIRED — the app must render with zero viewer input (cold cache,
   *  public first paint). Coerced like any value. */
  default: unknown;
  /** enum: the closed whitelist of accepted values. */
  options?: ParamOption[];
  /** int bounds (inclusive). */
  min?: number;
  max?: number;
  /** text length ceiling (defaults to TEXT_MAX). */
  maxLength?: number;
}

/** A coerced, ready-to-bind value: a typed scalar, never raw viewer text. */
export type ParamValue = string | number | boolean | Date | null;

/** Hard cap on text params so a hostile free-text value stays inert and bounded
 *  even when the author forgets `maxLength`. */
const TEXT_MAX = 1000;

/** Valid param identifier (also the token grammar after the colon). */
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Tokens in `sql` of the form `:name`. The `(?<![:\w])` guard skips Postgres
 * `::type` casts (the second colon is preceded by `:`, the cast keyword by a
 * word char) and avoids re-matching inside an identifier. Returns names in
 * first-appearance order, de-duplicated.
 */
export function extractTokens(sql: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of sql.matchAll(/(?<![:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Thrown when a viewer value can't be coerced to its declared type. The caller
 *  falls back to the param's default rather than failing the whole render. */
export class ParamCoercionError extends Error {}

/**
 * Coerce one raw viewer value to its declared type — the whitelist. Throws
 * `ParamCoercionError` on anything that doesn't fit (out-of-range int, unknown
 * enum, unparseable date); the caller substitutes the default.
 */
export function coerce(param: AppParam, raw: unknown): ParamValue {
  switch (param.type) {
    case "bool": {
      if (typeof raw === "boolean") return raw;
      const s = String(raw).toLowerCase();
      if (s === "true" || s === "1") return true;
      if (s === "false" || s === "0") return false;
      throw new ParamCoercionError(`not a boolean: ${s}`);
    }
    case "int": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n) || !Number.isInteger(n))
        throw new ParamCoercionError(`not an integer: ${raw}`);
      if (param.min != null && n < param.min)
        throw new ParamCoercionError(`below min ${param.min}: ${n}`);
      if (param.max != null && n > param.max)
        throw new ParamCoercionError(`above max ${param.max}: ${n}`);
      return n;
    }
    case "enum": {
      const allowed = (param.options ?? []).map((o) => o.value);
      const s = String(raw);
      if (!allowed.includes(s))
        throw new ParamCoercionError(`not in options: ${s}`);
      return s;
    }
    case "date": {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(d.getTime()))
        throw new ParamCoercionError(`not a date: ${raw}`);
      return d;
    }
    case "text": {
      const cap = param.maxLength ?? TEXT_MAX;
      const s = String(raw);
      if (s.length > cap)
        throw new ParamCoercionError(`text exceeds ${cap} chars`);
      return s;
    }
  }
}

/**
 * Resolve every declared param to a coerced value: take the viewer's raw value
 * when present and coercible, else fall back to the (also-coerced) default. The
 * returned map is the single source of truth for both SQL binding and the
 * read-only echo injected into the frame.
 */
export function resolveParams(
  declared: AppParam[],
  raw: Record<string, unknown> = {},
): Map<string, ParamValue> {
  const out = new Map<string, ParamValue>();
  for (const p of declared) {
    if (!NAME_RE.test(p.name))
      throw new Error(`invalid param name: ${JSON.stringify(p.name)}`);
    let value: ParamValue;
    if (Object.prototype.hasOwnProperty.call(raw, p.name)) {
      try {
        value = coerce(p, raw[p.name]);
      } catch {
        value = coerce(p, p.default); // viewer value rejected → default
      }
    } else {
      value = coerce(p, p.default);
    }
    out.set(p.name, value);
  }
  return out;
}

export interface CompiledSql {
  /** Statement with `:name` rewritten to engine placeholders. */
  text: string;
  /** Positional bind values for Postgres ($1…$n), in placeholder order. */
  values: ParamValue[];
  /** Param names this panel actually references (for the cache variant key). */
  referenced: string[];
}

/**
 * Compile a Postgres panel: rewrite each `:name` to `$n` (first-appearance
 * order) and collect the bound values. Throws if the SQL references a param the
 * app never declared — caught at publish/lint time, not at a viewer's
 * keystroke.
 */
export function compilePostgres(
  sql: string,
  resolved: Map<string, ParamValue>,
): CompiledSql {
  const tokens = extractTokens(sql);
  const values: ParamValue[] = [];
  for (const name of tokens) {
    if (!resolved.has(name))
      throw new Error(`panel references undeclared param :${name}`);
    values.push(resolved.get(name)!);
  }
  // Replace every occurrence of each token with its 1-based positional index.
  const index = new Map(tokens.map((t, i) => [t, i + 1]));
  const text = sql.replace(
    /(?<![:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g,
    (_m, name: string) => `$${index.get(name)}`,
  );
  return { text, values, referenced: tokens };
}

/** ClickHouse type for a declared param (lake binding via {name:Type}). */
function chType(t: ParamType): string {
  switch (t) {
    case "int":
      return "Int64";
    case "bool":
      return "UInt8";
    case "date":
      return "DateTime";
    default:
      return "String"; // text, enum
  }
}

export interface CompiledLakeSql {
  text: string;
  /** `param_<name>` values for the ClickHouse HTTP interface. */
  chParams: Record<string, string>;
  referenced: string[];
}

/**
 * Compile a ClickHouse (lake) panel: rewrite `:name` to `{name:Type}` and emit
 * the `param_<name>` values ClickHouse binds server-side. Same guarantee as
 * Postgres — viewer input is a bound query parameter, never spliced text. Only
 * analyst sessions ever reach the lake (the membrane), so this never runs on a
 * curator session.
 */
export function compileClickhouse(
  sql: string,
  declared: AppParam[],
  resolved: Map<string, ParamValue>,
): CompiledLakeSql {
  const byName = new Map(declared.map((p) => [p.name, p]));
  const tokens = extractTokens(sql);
  const chParams: Record<string, string> = {};
  for (const name of tokens) {
    const p = byName.get(name);
    if (!p || !resolved.has(name))
      throw new Error(`panel references undeclared param :${name}`);
    const v = resolved.get(name)!;
    chParams[name] =
      p.type === "date" && v instanceof Date
        ? v.toISOString().slice(0, 19).replace("T", " ")
        : p.type === "bool"
          ? v
            ? "1"
            : "0"
          : String(v);
  }
  const text = sql.replace(
    /(?<![:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g,
    (_m, name: string) => `{${name}:${chType(byName.get(name)!.type)}}`,
  );
  return { text, chParams, referenced: tokens };
}

/**
 * Stable cache-variant key for a panel: a hash of just the params it references
 * (sorted), so an unrelated param changing doesn't bust this panel's cache and
 * two viewers on the same inputs share one cached result. Empty string when the
 * panel takes no params — byte-identical to the pre-param cache key.
 */
export function paramsVariant(
  referenced: string[],
  resolved: Map<string, ParamValue>,
): string {
  if (referenced.length === 0) return "";
  const canon = [...referenced]
    .sort()
    .map((n) => {
      const v = resolved.get(n);
      return [n, v instanceof Date ? v.toISOString() : v];
    });
  return Bun.hash(JSON.stringify(canon)).toString(16);
}
