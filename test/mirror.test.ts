// SPDX-License-Identifier: Apache-2.0
// Pure helpers of the gateway's mirror view (lib/mirror) — the lake-reading
// side is exercised end-to-end in ingest/pg-mirror/mirror.test.ts.
import { describe, it, expect } from "bun:test";
import {
  mirrorAsOf,
  referencedBizTables,
  mirrorNameOf,
  queryableTableName,
  type MirroredTable,
} from "../plugin/gateway/lib/mirror";

const TABLES: MirroredTable[] = [
  { target: "orders", source: "public.orders", asOf: "2026-07-03T10:00:00.000Z" },
  { target: "ticketing_seat_txn", source: "ticketing.seat_txn", asOf: "2026-07-03T09:00:00.000Z" },
];

describe("mirrorNameOf", () => {
  it("strips the pg schema, lowercasing for case-insensitive matching by default", () => {
    expect(mirrorNameOf("public.JobPost")).toBe("jobpost");
    expect(mirrorNameOf("ticketing.seat_txn")).toBe("ticketing_seat_txn");
    expect(mirrorNameOf("orders")).toBe("orders");
  });
  it("preserves case for a display name (ClickHouse table names are case-sensitive)", () => {
    expect(mirrorNameOf("public.JobPost", true)).toBe("JobPost");
    expect(mirrorNameOf("Ticketing.Seat_Txn", true)).toBe("Ticketing_Seat_Txn");
  });
});

describe("queryableTableName", () => {
  it("maps a pg-qualified provenance name to its case-preserved biz.* mirror", () => {
    expect(queryableTableName("public.JobPost")).toBe("biz.JobPost");
    expect(queryableTableName("public.Company")).toBe("biz.Company");
    expect(queryableTableName("ticketing.seat_txn")).toBe("biz.ticketing_seat_txn");
  });
  it("passes bare lake/unqualified names through untouched", () => {
    expect(queryableTableName("mercury_transactions")).toBe("mercury_transactions");
    expect(queryableTableName("slack_messages")).toBe("slack_messages");
  });
  it("leaves already-ClickHouse-qualified names alone (lake db / mirror)", () => {
    // a lake table documented as setoku.X must NOT become biz.setoku_X
    expect(queryableTableName("setoku.github_issues")).toBe("setoku.github_issues");
    expect(queryableTableName("biz.orders")).toBe("biz.orders");
  });
});

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
  it("boundary-checked: biz.orders never claims biz.orders_archive", () => {
    const both: MirroredTable[] = [...TABLES, { target: "orders_archive", source: "public.orders_archive", asOf: "2026-07-01T00:00:00.000Z" }];
    expect(referencedBizTables("SELECT count() FROM biz.orders_archive", both)).toEqual(["orders_archive"]);
    expect(referencedBizTables("SELECT count() FROM biz.orders_archive", TABLES)).toEqual([]);
  });
});
