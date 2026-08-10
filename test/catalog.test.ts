// SPDX-License-Identifier: Apache-2.0
/**
 * The derived event catalog + the coverage check that rides on it.
 *
 * Both exist to close the same gap: a lake table whose schema is honest and
 * useless (`event_name`, `properties String`) and a knowledge store that
 * answers every question with its top-k whether or not it knows anything. The
 * units here are pure or fake-lake-backed, so the behavior is pinned without a
 * container.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  eventCatalog,
  clearCatalogCache,
  catalogSummary,
  catalogDetail,
  structuralMatches,
  type EventKind,
} from "../plugin/gateway/lib/catalog";
import { uncoveredTerms, type ScorableDoc } from "../plugin/gateway/lib/search";
import { startFakeLake, innerSql, type FakeLake } from "./lib/fakelake";

const QOPTS = { statementTimeoutMs: 5_000 };

const KINDS: EventKind[] = [
  {
    name: "page_viewed",
    count: 38,
    firstTs: "2026-07-01 10:00:00.000",
    lastTs: "2026-07-02 11:00:00.000",
    actors: 5,
    keys: ["path", "route"],
  },
  {
    name: "order_placed",
    count: 4,
    firstTs: "2026-07-01 12:00:00.000",
    lastTs: "2026-07-01 12:30:00.000",
    actors: 2,
    keys: ["order_id", "total_cents"],
  },
];

describe("eventCatalog", () => {
  let lake: FakeLake;
  beforeEach(() => {
    clearCatalogCache();
  });

  it("derives the event vocabulary and caps the property keys", async () => {
    const keys = Array.from(
      { length: 20 },
      (_, i) => `k${String(i).padStart(2, "0")}`,
    );
    lake = startFakeLake((sql) => {
      if (!innerSql(sql).includes("JSONExtractKeys")) return { rows: [] };
      return {
        rows: [
          {
            name: "page_viewed",
            n: 38,
            first_ts: "2026-07-01 10:00:00.000",
            last_ts: "2026-07-02 11:00:00.000",
            actors: 5,
            keys,
          },
        ],
      };
    });
    try {
      const events = await eventCatalog(lake.url, QOPTS);
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe("page_viewed");
      expect(events[0].count).toBe(38);
      expect(events[0].actors).toBe(5);
      // a chatty payload must not dominate the tool output
      expect(events[0].keys).toHaveLength(12);
      // and the aggregate is bounded server-side, not by reading every row
      const q = innerSql(lake.calls[0].sql);
      expect(q).toContain("groupArray(25)");
      expect(q).toContain("GROUP BY event_name");
      expect(q).toContain("LIMIT 40");
    } finally {
      lake.stop();
    }
  });

  it("caches per (lake, roles) — a second call costs no query", async () => {
    let hits = 0;
    lake = startFakeLake((sql) => {
      if (innerSql(sql).includes("JSONExtractKeys")) hits += 1;
      return { rows: [] };
    });
    try {
      await eventCatalog(lake.url, QOPTS, ["setoku_src_first_party_events"]);
      await eventCatalog(lake.url, QOPTS, ["setoku_src_first_party_events"]);
      expect(hits).toBe(1);
      // a DIFFERENT access scope is a different cache entry — a restricted
      // session must never be served a broader session's answer
      await eventCatalog(lake.url, QOPTS, null);
      expect(hits).toBe(2);
    } finally {
      lake.stop();
    }
  });

  it("degrades to [] when the table is absent or denied (never an error)", async () => {
    lake = startFakeLake(() => ({ exception: "Code: 60. UNKNOWN_TABLE" }));
    try {
      expect(await eventCatalog(lake.url, QOPTS)).toEqual([]);
      // negative-cached: a broken lake isn't re-probed on every discovery call
      const before = lake.calls.length;
      expect(await eventCatalog(lake.url, QOPTS)).toEqual([]);
      expect(lake.calls.length).toBe(before);
    } finally {
      lake.stop();
    }
  });

  it("maxWaitMs bounds a cold read (find_context must never stall)", async () => {
    lake = startFakeLake(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { rows: [] };
    });
    try {
      const started = Date.now();
      expect(await eventCatalog(lake.url, { ...QOPTS, maxWaitMs: 50 })).toEqual(
        [],
      );
      expect(Date.now() - started).toBeLessThan(350);
    } finally {
      lake.stop();
    }
  });
});

describe("catalog rendering", () => {
  it("summarizes the vocabulary for the capability list", () => {
    const s = catalogSummary(KINDS)!;
    expect(s).toContain("page_viewed (path, route)");
    expect(s).toContain("2 event kinds");
    expect(s).toContain("42 events");
    expect(s).toContain("2026-07-01 → 2026-07-02");
  });

  it("says nothing when nothing has been emitted", () => {
    expect(catalogSummary([])).toBeNull();
    expect(catalogDetail([])).toEqual([]);
  });

  it("details each event under the schema, flagged as sampled", () => {
    const lines = catalogDetail(KINDS).join("\n");
    expect(lines).toContain("sampled, not exhaustive");
    expect(lines).toContain("- page_viewed — 38 events, 5 actors");
    expect(lines).toContain("properties: path, route");
    expect(lines).toContain("- order_placed — 4 events, 2 actors");
  });
});

describe("structuralMatches", () => {
  const tables = [
    {
      database: "biz",
      table: "orders",
      columns: ["id", "total_cents", "status"],
    },
    { database: "biz", table: "SeatView", columns: ["id", "seat_id"] },
  ];

  it("points a term at the event that carries it (plural- and tense-tolerant)", () => {
    const hits = structuralMatches(["pageviews"], tables, KINDS);
    expect(hits).toHaveLength(1);
    expect(hits[0].matches[0]).toBe(
      "setoku.app_events event_name='page_viewed'",
    );
  });

  it("reaches tables, columns, and property keys", () => {
    expect(structuralMatches(["views"], tables, KINDS)[0].matches).toContain(
      "biz.SeatView",
    );
    expect(structuralMatches(["status"], tables, [])[0].matches).toContain(
      "biz.orders.status",
    );
    expect(structuralMatches(["routes"], [], KINDS)[0].matches[0]).toContain(
      "properties.route",
    );
  });

  it("prefers the table over enumerating its columns", () => {
    const m = structuralMatches(["orders"], tables, [])[0].matches;
    expect(m).toEqual(["biz.orders"]);
  });

  it("does not match on a short shared prefix", () => {
    // "pay" must not reach "payload"/"payments" — a wrong pointer is worse than none
    expect(
      structuralMatches(
        ["pay"],
        [{ database: "biz", table: "payload", columns: [] }],
        [],
      ),
    ).toEqual([]);
  });

  it("returns nothing when a term appears nowhere", () => {
    expect(structuralMatches(["velocipede"], tables, KINDS)).toEqual([]);
  });
});

describe("uncoveredTerms", () => {
  const doc = (name: string, body: string, summary = ""): ScorableDoc => ({
    type: "metric",
    name,
    meta: { summary },
    body,
  });
  const docs = [
    doc(
      "revenue",
      "Revenue excludes refunded orders; money columns are cents.",
      "revenue",
    ),
  ];

  it("names the domain term the returned docs never mention", () => {
    expect(uncoveredTerms(docs, "any pageviews yet?")).toEqual(["pageviews"]);
  });

  it("stays quiet when the question IS covered", () => {
    expect(
      uncoveredTerms(docs, "how much revenue did we make last month?"),
    ).toEqual([]);
  });

  it("ignores asking-words and time-words", () => {
    // nothing here names a thing in the business — a warning would be noise
    expect(
      uncoveredTerms(docs, "show me any data from last quarter please"),
    ).toEqual([]);
  });

  it("is plural-tolerant — a doc about 'order' covers a question about 'orders'", () => {
    expect(uncoveredTerms(docs, "how many orders?")).toEqual([]);
  });

  it("reads the whole doc, not just the body", () => {
    const tagged: ScorableDoc = {
      type: "entity",
      name: "Seat",
      meta: { keywords: ["ticket"], table: "biz.seats" },
      body: "",
    };
    expect(uncoveredTerms([tagged], "how many tickets?")).toEqual([]);
  });

  it("caps the list so a mismatched question doesn't dump its vocabulary", () => {
    const q = "alpha bravo charlie delta echo foxtrot golf hotel india";
    expect(uncoveredTerms(docs, q)).toHaveLength(6);
  });
});
