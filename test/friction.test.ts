// SPDX-License-Identifier: Apache-2.0
// The friction miner: cluster run_query failures by cause and detect per-session
// fail→retry→success recovery from the audit log. Deterministic, model-free.
import { describe, it, expect } from "bun:test";
import type { AuditRow } from "../plugin/gateway/lib/store";
import {
  mineFriction,
  parseRunQueryEvents,
  renderFriction,
} from "../plugin/gateway/lib/friction";

// Build an audit row the way store.audit() would (payload is a JSON string).
function row(
  ts: string,
  user: string,
  payload: Record<string, unknown>,
  tool = "run_query",
): AuditRow {
  return { ts, user, tool, payload: JSON.stringify(payload) };
}

const T = (min: number) =>
  new Date(Date.UTC(2026, 6, 16, 12, min, 0)).toISOString();

describe("parseRunQueryEvents", () => {
  it("skips non-run_query rows and unparseable payloads", () => {
    const rows: AuditRow[] = [
      row(T(0), "a", { ok: true, sql: "SELECT 1" }),
      row(T(1), "a", {}, "find_context"),
      { ts: T(2), user: "a", tool: "run_query", payload: "{not json" },
    ];
    const ev = parseRunQueryEvents(rows);
    expect(ev.length).toBe(1);
    expect(ev[0].ok).toBe(true);
  });
});

describe("mineFriction", () => {
  it("counts failures and computes the failure rate", () => {
    const rows: AuditRow[] = [
      row(T(0), "a", { ok: true, sql: "SELECT 1" }),
      row(T(1), "a", { ok: false, error: "Code: 60. Table x doesn't exist", sql: "SELECT * FROM x" }),
    ];
    const r = mineFriction(rows);
    expect(r.totalCalls).toBe(2);
    expect(r.totalFailures).toBe(1);
    expect(r.failureRate).toBeCloseTo(0.5);
    expect(r.buckets[0].code).toBe("table_unavailable");
  });

  it("marks a failure recovered when the same user succeeds within the window", () => {
    const rows: AuditRow[] = [
      row(T(0), "a", { ok: false, error: "Code: 60. doesn't exist", sql: "SELECT * FROM biz.foo" }),
      row(T(2), "a", { ok: true, sql: "SELECT * FROM biz.foos" }),
    ];
    const r = mineFriction(rows, { windowMinutes: 15 });
    expect(r.recoveredFailures).toBe(1);
    expect(r.recoveryRate).toBeCloseTo(1);
    expect(r.buckets[0].recovered).toBe(1);
    expect(r.buckets[0].stuck).toBe(0);
  });

  it("does NOT count recovery across a session gap larger than the window", () => {
    const rows: AuditRow[] = [
      row(T(0), "a", { ok: false, error: "Code: 60. doesn't exist", sql: "SELECT * FROM x" }),
      row(T(30), "a", { ok: true, sql: "SELECT 1" }), // 30m later = new session
    ];
    const r = mineFriction(rows, { windowMinutes: 15 });
    expect(r.recoveredFailures).toBe(0);
    expect(r.buckets[0].stuck).toBe(1);
  });

  it("does not pair a success from a DIFFERENT user as recovery", () => {
    const rows: AuditRow[] = [
      row(T(0), "a", { ok: false, error: "Code: 62. Syntax error", sql: "SELECT" }),
      row(T(1), "b", { ok: true, sql: "SELECT 1" }),
    ];
    const r = mineFriction(rows);
    expect(r.recoveredFailures).toBe(0);
    expect(r.users).toBe(2);
  });

  it("sorts buckets by most-stuck first", () => {
    const rows: AuditRow[] = [
      // syntax: 2 fails, both stuck (no later success)
      row(T(0), "a", { ok: false, error: "Code: 62. Syntax error", sql: "SELECT" }),
      row(T(1), "a", { ok: false, error: "Code: 62. Syntax error", sql: "SELECT" }),
      // table: 1 fail, recovered
      row(T(2), "b", { ok: false, error: "Code: 60. doesn't exist", sql: "SELECT * FROM x" }),
      row(T(3), "b", { ok: true, sql: "SELECT * FROM biz.x" }),
    ];
    const r = mineFriction(rows);
    expect(r.buckets[0].code).toBe("syntax");
    expect(r.buckets[0].stuck).toBe(2);
  });

  it("surfaces repeated failing intents as candidate missing metrics", () => {
    const rows: AuditRow[] = [
      row(T(0), "a", { ok: false, error: "e", sql: "s", purpose: "monthly churn rate" }),
      row(T(1), "a", { ok: false, error: "e", sql: "s", purpose: "Monthly Churn Rate" }),
      row(T(2), "a", { ok: false, error: "e", sql: "s", purpose: "one-off" }),
    ];
    const r = mineFriction(rows);
    expect(r.topFailingIntents[0].count).toBe(2); // case-insensitive grouping
    expect(r.topFailingIntents[0].purpose.toLowerCase()).toBe("monthly churn rate");
  });
});

describe("renderFriction", () => {
  it("renders an empty-store message when there are no failures", () => {
    const r = mineFriction([row(T(0), "a", { ok: true, sql: "SELECT 1" })]);
    expect(renderFriction(r)).toMatch(/No run_query failures/);
  });

  it("redacts SQL when showSql is false", () => {
    const rows: AuditRow[] = [
      row(T(0), "a", { ok: false, error: "Code: 60. x", sql: "SELECT email FROM biz.users WHERE id=42" }),
    ];
    const md = renderFriction(mineFriction(rows), { showSql: false });
    expect(md).not.toMatch(/email FROM biz.users/);
    const withSql = renderFriction(mineFriction(rows), { showSql: true });
    expect(withSql).toMatch(/email FROM biz.users/);
  });
});
