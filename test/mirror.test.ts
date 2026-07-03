// SPDX-License-Identifier: Apache-2.0
// Pure helpers of the gateway's mirror view (lib/mirror) — the lake-reading
// side is exercised end-to-end in ingest/pg-mirror/mirror.test.ts.
import { describe, it, expect } from "bun:test";
import { mirrorAsOf, referencedBizTables, type MirroredTable } from "../plugin/gateway/lib/mirror";

const TABLES: MirroredTable[] = [
  { target: "orders", source: "public.orders", asOf: "2026-07-03T10:00:00.000Z" },
  { target: "ticketing_seat_txn", source: "ticketing.seat_txn", asOf: "2026-07-03T09:00:00.000Z" },
];

describe("mirrorAsOf", () => {
  it("is the OLDEST fresh copy — an app is only as current as its stalest input", () => {
    expect(mirrorAsOf(TABLES)).toBe("2026-07-03T09:00:00.000Z");
    expect(mirrorAsOf(TABLES, ["orders"])).toBe("2026-07-03T10:00:00.000Z");
    expect(mirrorAsOf(TABLES, ["orders", "ticketing_seat_txn"])).toBe("2026-07-03T09:00:00.000Z");
  });
  it("null when nothing is mirrored or referenced", () => {
    expect(mirrorAsOf([])).toBeNull();
    expect(mirrorAsOf(TABLES, ["not_mirrored"])).toBeNull();
  });
});

describe("referencedBizTables", () => {
  it("finds biz.<table> references, case- and backtick-insensitive", () => {
    expect(referencedBizTables("SELECT count() FROM biz.orders", TABLES)).toEqual(["orders"]);
    expect(referencedBizTables("SELECT 1 FROM BIZ.Orders o JOIN biz.`ticketing_seat_txn` t ON 1", TABLES)).toEqual([
      "orders",
      "ticketing_seat_txn",
    ]);
  });
  it("ignores unmirrored names and non-biz tables", () => {
    expect(referencedBizTables("SELECT * FROM setoku.slack_messages", TABLES)).toEqual([]);
    expect(referencedBizTables("SELECT * FROM biz.unknown_table", TABLES)).toEqual([]);
  });
});
