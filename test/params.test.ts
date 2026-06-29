// SPDX-License-Identifier: Apache-2.0
// The parameter layer turns a static app into an interactive one. Its one
// load-bearing property: untrusted viewer input reaches SQL only as a bound,
// type-coerced value — never spliced. These tests pin that property.
import { describe, it, expect } from "bun:test";
import {
  extractTokens,
  coerce,
  resolveParams,
  compilePostgres,
  compileClickhouse,
  paramsVariant,
  ParamCoercionError,
  type AppParam,
} from "../plugin/gateway/lib/params";

const P = {
  start: { name: "start", type: "date", default: "2026-01-01" },
  limit: { name: "limit", type: "int", default: 10, min: 1, max: 100 },
  status: {
    name: "status",
    type: "enum",
    default: "open",
    options: [{ value: "open" }, { value: "closed" }],
  },
  q: { name: "q", type: "text", default: "", maxLength: 50 },
} satisfies Record<string, AppParam>;

describe("extractTokens", () => {
  it("finds :name tokens in first-appearance order, de-duped", () => {
    expect(extractTokens("WHERE a=:x AND b=:y OR c=:x")).toEqual(["x", "y"]);
  });
  it("does NOT mistake ::type casts for params", () => {
    expect(extractTokens("SELECT amount::int, ts::date FROM t")).toEqual([]);
  });
  it("does not match inside an identifier", () => {
    expect(extractTokens("SELECT a:b")).toEqual([]); // 'a:b' — colon after word char
  });
  it("does NOT match a colon-word inside a string literal", () => {
    // The literal ': not a param' must not be parsed as a :not token.
    expect(extractTokens("WHERE note LIKE '% :ref %' AND x = :real")).toEqual(["real"]);
    expect(extractTokens("SELECT ':active' AS s")).toEqual([]);
  });
  it("does NOT match inside line or block comments", () => {
    expect(extractTokens("SELECT 1 -- :nope\nWHERE x=:yes")).toEqual(["yes"]);
    expect(extractTokens("SELECT /* :nope */ x WHERE y=:yes")).toEqual(["yes"]);
  });
  it("handles NESTED block comments (Postgres) and dollar-quoted strings", () => {
    expect(extractTokens("/* outer /* :inner */ still comment */ WHERE x=:yes")).toEqual(["yes"]);
    expect(extractTokens("WHERE col ~ $$x:foo$$ AND y=:yes")).toEqual(["yes"]);
    expect(extractTokens("WHERE col ~ $tag$a :b c$tag$ OR z=:yes")).toEqual(["yes"]);
  });
  it("lexes per dialect: ClickHouse comments don't nest and have no dollar-quoting", () => {
    // CH ends the comment at the FIRST */, so `:day` after it is a real token...
    expect(extractTokens("/* a /* b */ WHERE d=:day", "clickhouse")).toEqual(["day"]);
    // ...whereas Postgres nesting keeps the (unbalanced) comment open to EOL.
    expect(extractTokens("/* a /* b */ WHERE d=:day", "postgres")).toEqual([]);
    // `$$` isn't a CH literal, so a colon-word after it is still a token.
    expect(extractTokens("x = $$ AND y=:yes", "clickhouse")).toEqual(["yes"]);
  });
});

describe("coerce — the whitelist", () => {
  it("int: rejects out-of-range and non-integers", () => {
    expect(coerce(P.limit, "20")).toBe(20);
    expect(() => coerce(P.limit, "200")).toThrow(ParamCoercionError);
    expect(() => coerce(P.limit, "1.5")).toThrow(ParamCoercionError);
  });
  it("enum: rejects anything outside options", () => {
    expect(coerce(P.status, "closed")).toBe("closed");
    expect(() => coerce(P.status, "deleted")).toThrow(ParamCoercionError);
    // a SQL-injection attempt is just an unknown enum value — rejected
    expect(() => coerce(P.status, "open'; DROP TABLE t;--")).toThrow(
      ParamCoercionError,
    );
  });
  it("int: an empty/blank value is rejected (not silently coerced to 0)", () => {
    expect(() => coerce(P.limit, "")).toThrow(ParamCoercionError);
    expect(() => coerce(P.limit, "   ")).toThrow(ParamCoercionError);
  });
  it("text: caps length so a hostile value stays bounded", () => {
    expect(coerce(P.q, "hello")).toBe("hello");
    expect(() => coerce(P.q, "x".repeat(51))).toThrow(ParamCoercionError);
  });
  it("date: parses to a Date, rejects garbage", () => {
    expect(coerce(P.start, "2026-06-01")).toBeInstanceOf(Date);
    expect(() => coerce(P.start, "not-a-date")).toThrow(ParamCoercionError);
  });
});

describe("resolveParams", () => {
  it("falls back to the default when a viewer value is rejected", () => {
    const r = resolveParams([P.limit], { limit: "9999" });
    expect(r.get("limit")).toBe(10); // out-of-range → default
  });
  it("uses the default when a param is absent from viewer input", () => {
    const r = resolveParams([P.status], {});
    expect(r.get("status")).toBe("open");
  });
  it("falls back to the default for an emptied int (cleared input → declared default)", () => {
    expect(resolveParams([P.limit], { limit: "" }).get("limit")).toBe(10);
  });
});

describe("compilePostgres — bind, never splice", () => {
  it("rewrites :name to $n and collects bound values in order", () => {
    const resolved = resolveParams([P.status, P.limit], {
      status: "closed",
      limit: "5",
    });
    const c = compilePostgres(
      "SELECT * FROM tickets WHERE status=:status LIMIT :limit",
      resolved,
    );
    expect(c.text).toBe("SELECT * FROM tickets WHERE status=$1 LIMIT $2");
    expect(c.values).toEqual(["closed", 5]);
    expect(c.referenced).toEqual(["status", "limit"]);
  });
  it("reuses one placeholder for a repeated token", () => {
    const resolved = resolveParams([P.start], { start: "2026-06-01" });
    const c = compilePostgres("a >= :start OR b >= :start", resolved);
    expect(c.text).toBe("a >= $1 OR b >= $1");
    expect(c.values).toHaveLength(1);
  });
  it("throws if a panel references an undeclared param", () => {
    expect(() => compilePostgres("WHERE x=:ghost", new Map())).toThrow(
      /undeclared param :ghost/,
    );
  });
  it("leaves a colon-word inside a string literal untouched (no false bind)", () => {
    const resolved = resolveParams([P.status], { status: "closed" });
    const c = compilePostgres("WHERE note = ': literal' AND status = :status", resolved);
    expect(c.text).toBe("WHERE note = ': literal' AND status = $1");
    expect(c.values).toEqual(["closed"]);
    expect(c.referenced).toEqual(["status"]);
  });
});

describe("compileClickhouse — lake binding", () => {
  it("rewrites :name to {name:Type} and emits param_ values", () => {
    const resolved = resolveParams([P.status, P.limit], { limit: "7" });
    const c = compileClickhouse(
      "SELECT * FROM events WHERE status=:status LIMIT :limit",
      [P.status, P.limit],
      resolved,
    );
    expect(c.text).toBe(
      "SELECT * FROM events WHERE status={status:String} LIMIT {limit:Int64}",
    );
    expect(c.chParams).toEqual({ status: "open", limit: "7" });
  });
});

describe("paramsVariant — cache key", () => {
  it("is empty for an unparameterized panel (cache key unchanged)", () => {
    expect(paramsVariant([], new Map())).toBe("");
  });
  it("differs by value but is stable for the same inputs", () => {
    const a = resolveParams([P.status], { status: "open" });
    const b = resolveParams([P.status], { status: "closed" });
    expect(paramsVariant(["status"], a)).not.toBe(paramsVariant(["status"], b));
    expect(paramsVariant(["status"], a)).toBe(paramsVariant(["status"], a));
  });
});
