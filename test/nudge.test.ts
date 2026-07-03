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
  mirrorSteerNote,
  panelMirrorNote,
} from "../plugin/gateway/lib/nudge";

const WINS_SQL = `SELECT COUNT(*) AS won_deals\nFROM "DealPipeline"\nWHERE status = 'WON';`;

describe("normalizeSql", () => {
  it("collapses whitespace, comments, case, trailing semicolons", () => {
    expect(normalizeSql("SELECT  1;\n-- note\n")).toBe("select 1");
    expect(normalizeSql("/* why */ SELECT\n\tcount(*) FROM t ;")).toBe(
      "select count(*) from t",
    );
  });
  it("comment markers inside string literals survive (literal-aware lexing)", () => {
    expect(normalizeSql("SELECT id FROM t WHERE slug = 'my--post'")).toBe(
      "select id from t where slug = 'my--post'",
    );
    expect(normalizeSql("SELECT id FROM t WHERE note LIKE '%/*%'")).toBe(
      "select id from t where note like '%/*%'",
    );
    // distinct literals must stay distinct after normalization
    expect(normalizeSql("SELECT 1 FROM t WHERE s='a--x'")).not.toBe(
      normalizeSql("SELECT 1 FROM t WHERE s='a--y'"),
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
  it("aggregate-looking text inside a string literal is not an aggregate", () => {
    expect(
      isAggregateShaped("SELECT id, note FROM t WHERE label = 'sum(total)'"),
    ).toBe(false);
  });
  it("window functions are per-row fetches, not metrics", () => {
    expect(
      isAggregateShaped(
        "SELECT id, amount, sum(amount) OVER (PARTITION BY user_id) FROM ledger",
      ),
    ).toBe(false);
    // a real aggregate alongside a window call still counts
    expect(
      isAggregateShaped(
        "SELECT plan, count(*), sum(amt) OVER (PARTITION BY plan) FROM x GROUP BY plan",
      ),
    ).toBe(true);
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
  it("token boundaries: a curated prefix must not claim a different table", () => {
    const c = ["SELECT count(*) FROM orders"];
    expect(coveredByCurated("SELECT count(*) FROM orders_archive", c)).toBe(false);
    expect(coveredByCurated("SELECT count(*) FROM orders WHERE paid", c)).toBe(true);
  });
  it("a broad query inside a narrower curated metric is NOT covered", () => {
    const narrow = ["SELECT count(*) FROM orders WHERE status = 'paid' AND total > 0"];
    // the broad number is defined by no metric — it should still nudge
    expect(coveredByCurated("SELECT count(*) FROM orders", narrow)).toBe(false);
  });
  it("empty store covers nothing, blank fences cover nothing", () => {
    expect(coveredByCurated(WINS_SQL, [])).toBe(false);
    expect(coveredByCurated(WINS_SQL, ["  "])).toBe(false);
  });
});

describe("queryCaptureNudge", () => {
  const curated = () => [WINS_SQL];
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
  it("does not pay for the curated scan unless the shape gates pass", () => {
    let scans = 0;
    const counting = (): string[] => {
      scans += 1;
      return [WINS_SQL];
    };
    queryCaptureNudge("SELECT id, name FROM users LIMIT 20", counting);
    queryCaptureNudge("SHOW TABLES", counting);
    expect(scans).toBe(0);
    queryCaptureNudge('SELECT count(*) FROM "Listing"', counting);
    expect(scans).toBe(1);
  });
});

describe("panelCaptureNote", () => {
  const curated = () => [WINS_SQL];
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
  it("never scans the store for zero-panel or non-aggregate publishes", () => {
    let scans = 0;
    const counting = (): string[] => {
      scans += 1;
      return [];
    };
    panelCaptureNote([], counting);
    panelCaptureNote([{ key: "d", sql: "SELECT id FROM t LIMIT 5" }], counting);
    expect(scans).toBe(0);
  });
});

describe("mirrorSteerNote (issue #47)", () => {
  const MIRRORED = [
    { target: "ticketing_seat_txn", source: "ticketing.seat_txn" },
    { target: "orders", source: "public.orders" },
  ];
  it("steers a postgres aggregate over a mirrored table to biz.*", () => {
    const note = mirrorSteerNote(
      "SELECT acct_id, sum(price_cents) FROM ticketing.seat_txn GROUP BY acct_id",
      MIRRORED,
    );
    expect(note).toContain("ticketing.seat_txn");
    expect(note).toContain("biz.ticketing_seat_txn");
    expect(note).toContain('dialect:"clickhouse"');
  });
  it("matches bare (unqualified) table references too", () => {
    expect(mirrorSteerNote("SELECT count(*) FROM orders", MIRRORED)).toContain("biz.orders");
  });
  it("silent on point lookups, exploration, and unmirrored tables", () => {
    expect(mirrorSteerNote("SELECT * FROM ticketing.seat_txn WHERE id = 5 LIMIT 1", MIRRORED)).toBeNull();
    expect(mirrorSteerNote("SELECT count(*) FROM information_schema.tables", MIRRORED)).toBeNull();
    expect(mirrorSteerNote("SELECT count(*) FROM invoices", MIRRORED)).toBeNull();
    expect(mirrorSteerNote("SELECT count(*) FROM orders", [])).toBeNull();
  });
  it("a literal mentioning the table is not a reference", () => {
    expect(mirrorSteerNote("SELECT count(*) FROM audit WHERE detail = 'ticketing.seat_txn'", MIRRORED)).toBeNull();
  });
  it("no false match on longer names sharing a suffix", () => {
    expect(mirrorSteerNote("SELECT count(*) FROM orders_archive", MIRRORED)).toBeNull();
  });
});

describe("panelMirrorNote (issue #47)", () => {
  const MIRRORED = [{ target: "orders", source: "public.orders" }];
  it("flags postgres aggregate panels over mirrored tables, names the target", () => {
    const note = panelMirrorNote(
      [
        { key: "rev", sql: "SELECT sum(total) FROM orders" },
        { key: "one", sql: "SELECT * FROM orders WHERE id = :id LIMIT 1" },
        { key: "fast", sql: "SELECT count() FROM biz.orders", dialect: "clickhouse" },
      ],
      MIRRORED,
    );
    expect(note).toContain('"rev"');
    expect(note).toContain("public.orders → biz.orders");
    expect(note).not.toContain('"one"');
    expect(note).not.toContain('"fast"');
  });
  it("null when no postgres panel scans a mirrored table (or no mirror)", () => {
    expect(panelMirrorNote([{ key: "a", sql: "SELECT sum(x) FROM invoices" }], MIRRORED)).toBeNull();
    expect(panelMirrorNote([{ key: "a", sql: "SELECT sum(x) FROM orders" }], [])).toBeNull();
  });
});
