// SPDX-License-Identifier: Apache-2.0
// Knowledge lint core (curation-cockpit-spec piece D): bounds-in-doc beats the
// guessed heuristic, and the heuristic still catches the classic unit bugs.
import { describe, it, expect } from "bun:test";
import {
  extractSql,
  evaluateExpect,
  lintDocResults,
  type LintResult,
} from "../plugin/gateway/lib/lint";

describe("extractSql", () => {
  it("pulls runnable SELECT/WITH blocks and skips expression fragments", () => {
    const body = [
      "```sql\nSELECT count(*) FROM orders\n```",
      "```sql\nlower(email)  -- just an expression\n```",
      "```sql\nWITH x AS (SELECT 1) SELECT * FROM x\n```",
    ].join("\n\n");
    const sqls = extractSql(body);
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toContain("count(*)");
  });
});

describe("evaluateExpect (bounds-in-doc)", () => {
  it("two-sided range", () => {
    expect(evaluateExpect("0 < value <= 1", 0.5)).toBeNull();
    expect(evaluateExpect("0 < value <= 1", 1)).toBeNull();
    expect(evaluateExpect("0 < value <= 1", 1.4)).toContain("violates");
    expect(evaluateExpect("0 < value <= 1", 0)).toContain("violates");
  });
  it("one-sided", () => {
    expect(evaluateExpect("value >= 0", -1)).toContain("violates");
    expect(evaluateExpect("value >= 0", 0)).toBeNull();
    expect(evaluateExpect("value <= 100", 250)).toContain("violates");
  });
  it("unparseable expression is treated as uncheckable (null)", () => {
    expect(evaluateExpect("something weird", 5)).toBeNull();
  });
});

const ok = (cols: string[], rows: string[][]): LintResult => ({ cols, rows });

describe("lintDocResults", () => {
  it("a declared expect FAILS a metric whose value is out of range", () => {
    const r = lintDocResults(
      { name: "sell_through", meta: { expect: "0 < value <= 1" }, body: "" },
      [ok(["value"], [["1.8"]])],
    );
    expect(r.status).toBe("fail");
    expect(r.problems[0]).toContain("violates expect");
  });

  it("a declared expect PASSES a metric in range (clean)", () => {
    const r = lintDocResults(
      { name: "sell_through", meta: { expect: "0 < value <= 1" }, body: "" },
      [ok(["value"], [["0.42"]])],
    );
    expect(r.status).toBe("pass");
    expect(r.problems).toHaveLength(0);
  });

  it("expect_nonempty fails an empty result", () => {
    const r = lintDocResults(
      { name: "active_users", meta: { expect_nonempty: "true" }, body: "" },
      [ok(["n"], [])],
    );
    expect(r.status).toBe("fail");
    expect(r.problems[0]).toContain("expect_nonempty");
  });

  it("a SQL error is a FAIL", () => {
    const r = lintDocResults(
      { name: "broken", meta: {}, body: "" },
      [{ cols: [], rows: [], error: 'column "foo" does not exist' }],
    );
    expect(r.status).toBe("fail");
    expect(r.problems[0]).toContain("SQL error");
  });

  it("without declared bounds, the heuristic catches an inverted ratio", () => {
    const r = lintDocResults(
      { name: "renewal_rate", meta: {}, body: "" },
      [ok(["renewal_rate"], [["1.9"]])],
    );
    expect(r.status).toBe("fail"); // 'inverted' → fail severity
    expect(r.problems[0]).toContain("out of [0,1]");
  });

  it("a clean heuristic result passes", () => {
    const r = lintDocResults(
      { name: "renewal_rate", meta: {}, body: "" },
      [ok(["renewal_rate"], [["0.88"]])],
    );
    expect(r.status).toBe("pass");
  });
});
