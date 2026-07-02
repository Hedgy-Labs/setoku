// SPDX-License-Identifier: Apache-2.0
// Success-path capture nudges: fire exactly when a working query computed a
// business aggregate no curated metric covers — never on exploration, never on
// SQL the store already knows (else the nudge is noise and gets ignored).
import { describe, it, expect } from "bun:test";
import {
  normalizeSql,
  isExploratorySql,
  isAggregateShaped,
  coveredByCurated,
  queryCaptureNudge,
  panelCaptureNote,
} from "../plugin/gateway/lib/nudge";

const WINS_SQL = `SELECT COUNT(*) AS won_deals\nFROM "DealPipeline"\nWHERE status = 'WON';`;

describe("normalizeSql", () => {
  it("collapses whitespace, comments, case, trailing semicolons", () => {
    expect(normalizeSql("SELECT  1;\n-- note\n")).toBe("select 1");
    expect(normalizeSql("/* why */ SELECT\n\tcount(*) FROM t ;")).toBe(
      "select count(*) from t",
    );
  });
});

describe("isExploratorySql", () => {
  it("metadata and schema peeks are exploratory", () => {
    expect(isExploratorySql("SHOW TABLES")).toBe(true);
    expect(isExploratorySql("DESCRIBE slack_messages")).toBe(true);
    expect(isExploratorySql("EXPLAIN SELECT count(*) FROM t")).toBe(true);
    expect(
      isExploratorySql(
        "SELECT table_name FROM information_schema.tables LIMIT 50",
      ),
    ).toBe(true);
  });
  it("business queries are not", () => {
    expect(isExploratorySql(WINS_SQL)).toBe(false);
  });
});

describe("isAggregateShaped", () => {
  it("aggregates and GROUP BY count; row fetches don't", () => {
    expect(isAggregateShaped(WINS_SQL)).toBe(true);
    expect(isAggregateShaped("SELECT plan, sum(amt) FROM x GROUP BY plan")).toBe(true);
    expect(isAggregateShaped('SELECT * FROM "Vendor" LIMIT 10')).toBe(false);
    expect(isAggregateShaped("SELECT id, name FROM users WHERE id = 3")).toBe(false);
  });
});

describe("coveredByCurated", () => {
  const curated = [WINS_SQL];
  it("exact and cosmetically-different SQL is covered", () => {
    expect(coveredByCurated(WINS_SQL, curated)).toBe(true);
    expect(
      coveredByCurated(
        'select count(*) as won_deals from "dealpipeline" where status = \'won\'',
        curated,
      ),
    ).toBe(true);
  });
  it("a wrapped/extended variant of curated SQL is covered (containment)", () => {
    const wrapped = `WITH h AS (${WINS_SQL.replace(/;$/, "")}) SELECT * FROM h`;
    expect(coveredByCurated(wrapped, curated)).toBe(true);
  });
  it("a genuinely new aggregate is not", () => {
    expect(
      coveredByCurated('SELECT count(*) FROM "Listing" WHERE active', curated),
    ).toBe(false);
  });
  it("empty store covers nothing, blank fences cover nothing", () => {
    expect(coveredByCurated(WINS_SQL, [])).toBe(false);
    expect(coveredByCurated(WINS_SQL, ["  "])).toBe(false);
  });
});

describe("queryCaptureNudge", () => {
  const curated = [WINS_SQL];
  it("fires on an uncovered business aggregate", () => {
    const nudge = queryCaptureNudge(
      'SELECT count(*) FROM "Listing" WHERE status = \'LIVE\'',
      curated,
    );
    expect(nudge).toContain("report_correction");
  });
  it("silent on exploration, row fetches, and covered SQL", () => {
    expect(queryCaptureNudge("SHOW TABLES", curated)).toBeNull();
    expect(queryCaptureNudge('SELECT * FROM "Vendor" LIMIT 5', curated)).toBeNull();
    expect(queryCaptureNudge(WINS_SQL, curated)).toBeNull();
  });
});

describe("panelCaptureNote", () => {
  const curated = [WINS_SQL];
  it("names only the uncovered, unlinked aggregate panels", () => {
    const note = panelCaptureNote(
      [
        { key: "won_deals", sql: WINS_SQL }, // covered
        { key: "active_listings", sql: 'SELECT count(*) FROM "Listing" WHERE active' }, // nudge
        { key: "linked", sql: "SELECT sum(amt) FROM spend", metricId: "gross_margin" }, // provenance already linked
        { key: "detail", sql: "SELECT id, name FROM users LIMIT 20" }, // not an aggregate
      ],
      curated,
    );
    expect(note).toContain('"active_listings"');
    expect(note).not.toContain('"won_deals"');
    expect(note).not.toContain('"linked"');
    expect(note).not.toContain('"detail"');
  });
  it("null when everything is covered or linked", () => {
    expect(panelCaptureNote([{ key: "won_deals", sql: WINS_SQL }], curated)).toBeNull();
  });
});
