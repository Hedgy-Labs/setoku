// SPDX-License-Identifier: Apache-2.0
// Query-error classification + the live "→ next step" hint appended to
// run_query failures. The membrane invariant is the load-bearing test: a denied
// table and a nonexistent one MUST classify + hint identically (I2/I9).
import { describe, it, expect } from "bun:test";
import {
  classifyQueryError,
  queryErrorHint,
  extractTableRefs,
  extractUnknownColumn,
  nearestColumns,
  matchReferencedTables,
  renderColumnHint,
} from "../plugin/gateway/lib/queryhint";

describe("classifyQueryError", () => {
  it("buckets the common ClickHouse failure codes", () => {
    expect(classifyQueryError("Code: 60. DB::Exception: Table biz.foo doesn't exist")).toBe(
      "table_unavailable",
    );
    expect(classifyQueryError("Code: 47. DB::Exception: Unknown identifier: revene")).toBe(
      "unknown_column",
    );
    expect(classifyQueryError("Code: 46. DB::Exception: Unknown function date_trunc")).toBe(
      "unknown_function",
    );
    expect(classifyQueryError("Code: 62. DB::Exception: Syntax error near '::'")).toBe("syntax");
    expect(classifyQueryError("Code: 159. DB::Exception: Timeout exceeded")).toBe("timeout");
    expect(classifyQueryError("Code: 241. DB::Exception: Memory limit exceeded")).toBe("memory");
    expect(classifyQueryError("Code: 53. DB::Exception: Type mismatch")).toBe("type_mismatch");
  });

  it("buckets our own gate + retirement messages (not 'other')", () => {
    expect(
      classifyQueryError('Only read statements are allowed (got "UPDATE"). The connection is READ ONLY;'),
    ).toBe("read_only");
    expect(classifyQueryError("Multiple statements (semicolons) are not supported")).toBe(
      "multi_statement",
    );
    expect(
      classifyQueryError("The direct business-Postgres path is retired — business tables are read via the biz.* ClickHouse mirror"),
    ).toBe("pg_retired");
  });

  it("classifies Postgres-phrased and ClickHouse-worded unknown tables", () => {
    // legacy/retired-path audit rows carry Postgres wording (no Code: N)
    expect(classifyQueryError('relation "Company" does not exist')).toBe("table_unavailable");
    expect(
      classifyQueryError("DB::Exception: Unknown table expression identifier 'User' in scope SELECT"),
    ).toBe("table_unavailable");
  });

  it("buckets the curator-session lake-denied rejection distinctly", () => {
    expect(
      classifyQueryError(
        "This is a curator session — reading the lake (clickhouse dialect) is disabled here",
      ),
    ).toBe("curator_lake_denied");
  });

  it("classifies Postgres-phrased timeouts and column errors (legacy rows)", () => {
    expect(classifyQueryError("canceling statement due to statement timeout")).toBe("timeout");
    expect(classifyQueryError('column "salaryMin" does not exist')).toBe("unknown_column");
  });

  it("buckets historical audit sentinels", () => {
    expect(classifyQueryError("mirror-required")).toBe("mirror_required");
    expect(classifyQueryError("pg-retired")).toBe("pg_retired");
  });

  it("classifies the ClickHouse correlated-subquery limitation", () => {
    expect(
      classifyQueryError("Code: 1. Resolved identifier 'u.id' in parent scope to expression"),
    ).toBe("correlated_subquery");
  });

  it("falls back to 'other' for unrecognized errors", () => {
    expect(classifyQueryError("Code: 999. Some brand new failure")).toBe("other");
    expect(classifyQueryError("")).toBe("other");
  });

  // MEMBRANE (I2/I9): access-denied must be indistinguishable from not-found.
  it("collapses ACCESS_DENIED and UNKNOWN_TABLE to one code", () => {
    const denied = classifyQueryError("Code: 497. DB::Exception: ... ACCESS_DENIED: not enough privileges");
    const missing = classifyQueryError("Code: 60. DB::Exception: Table biz.secret doesn't exist");
    expect(denied).toBe("table_unavailable");
    expect(missing).toBe("table_unavailable");
    expect(denied).toBe(missing);
  });
});

describe("queryErrorHint", () => {
  it("returns a discovery-pointing hint for cryptic engine errors", () => {
    const h = queryErrorHint("Code: 60. Table biz.foo doesn't exist");
    expect(h?.code).toBe("table_unavailable");
    expect(h?.hint).toMatch(/get_schema|SHOW TABLES/);
  });

  it("gives the SAME hint for a denied table as a missing one (membrane)", () => {
    const denied = queryErrorHint("Code: 497. ACCESS_DENIED: not enough privileges");
    const missing = queryErrorHint("Code: 60. Table biz.secret doesn't exist");
    expect(denied?.hint).toBe(missing?.hint);
  });

  it("sharpens the syntax hint when a Postgres :: cast is present", () => {
    const generic = queryErrorHint("Code: 62. Syntax error", "SELECT count(*) FROM biz.t");
    const cast = queryErrorHint("Code: 62. Syntax error", "SELECT id::text FROM biz.t");
    expect(generic?.hint).toMatch(/ClickHouse SQL/);
    expect(cast?.hint).toMatch(/Postgres `::` cast/);
    expect(cast?.hint).not.toBe(generic?.hint);
  });

  it("returns null for messages that are already self-explanatory", () => {
    expect(queryErrorHint("The connection is READ ONLY; writes are rejected.")).toBeNull();
    expect(queryErrorHint("Multiple statements (semicolons) are not supported")).toBeNull();
    expect(queryErrorHint("The direct business-Postgres path is retired")).toBeNull();
  });

  it("returns null for unrecognized errors (no misleading hint)", () => {
    expect(queryErrorHint("Code: 999. brand new failure")).toBeNull();
  });

  it("sharpens type_mismatch for the Nullable-in-array case", () => {
    const nested = queryErrorHint(
      "Code: 43. Nested type Array(String) cannot be inside Nullable type",
    );
    expect(nested?.code).toBe("type_mismatch");
    expect(nested?.hint).toMatch(/assumeNotNull|coalesce/);
    // a plain type mismatch keeps the generic cast hint
    expect(queryErrorHint("Code: 53. Type mismatch")?.hint).toMatch(/cast explicitly/i);
  });
});

describe("schema-aware unknown-column helpers", () => {
  it("extracts table refs from FROM / JOIN (bare, qualified, quoted, aliased)", () => {
    const refs = extractTableRefs(
      'SELECT * FROM biz.JobPost jp JOIN setoku.logs_vercel v ON 1 JOIN "Company" WHERE x',
    );
    expect(refs).toContain("biz.JobPost");
    expect(refs).toContain("setoku.logs_vercel");
    expect(refs).toContain('"Company"');
    // does not grab the alias or a subquery paren
    expect(extractTableRefs("SELECT * FROM (SELECT 1) t")).toEqual([]);
  });

  it("extracts the unknown identifier from ClickHouse and Postgres phrasings", () => {
    expect(extractUnknownColumn("Code: 47. Unknown expression or function identifier `timestamp` in scope")).toBe("timestamp");
    expect(extractUnknownColumn("Unknown identifier: custmer_id")).toBe("custmer_id");
    expect(extractUnknownColumn('column "salaryMin" does not exist')).toBe("salaryMin");
    // strips a table-alias prefix down to the bare column
    expect(extractUnknownColumn("Unknown identifier `u.resumeUrl`")).toBe("resumeUrl");
    expect(extractUnknownColumn("something else entirely")).toBeNull();
  });

  it("suggests the nearest column, case-insensitively, within an edit budget", () => {
    expect(nearestColumns("timestamp", ["ts", "level", "message"])).toEqual([]); // too far
    expect(nearestColumns("custmer_id", ["customer_id", "company_id"])).toEqual(["customer_id"]);
    // ClickHouse is case-sensitive: salaryMin → salarymin is distance 0 here
    expect(nearestColumns("salaryMin", ["salarymin", "salarymax"])[0]).toBe("salarymin");
  });

  it("matches referenced tables by qualified or bare name, quoting-insensitive", () => {
    const schema = [
      { database: "biz", table: "JobPost", columns: ["id", "title"] },
      { database: "setoku", table: "logs_vercel", columns: ["ts", "message"] },
    ];
    const m = matchReferencedTables(['biz.JobPost', '"logs_vercel"', "jp"], schema);
    expect(m.map((t) => t.table).sort()).toEqual(["biz.JobPost", "setoku.logs_vercel"]);
  });

  it("renders the columns block and a did-you-mean; null when no tables matched", () => {
    const out = renderColumnHint("custmer_id", [
      { table: "biz.orders", columns: ["id", "customer_id", "total"] },
    ]);
    expect(out).toMatch(/biz\.orders: id, customer_id, total/);
    expect(out).toMatch(/did you mean `customer_id`/);
    expect(renderColumnHint("x", [])).toBeNull();
  });
});
