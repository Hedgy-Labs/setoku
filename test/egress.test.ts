// SPDX-License-Identifier: Apache-2.0
// The egress ledger's store-side pieces: the threshold knob and the built-in
// "Mirror egress" app seed (once, only when a ledger exists, archive respected).
// The lake-facing half (gatherEgress) is covered through the /admin/api tests.
import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../plugin/gateway/lib/store";
import { lintAppTemplate } from "../plugin/gateway/lib/app-runtime";
import {
  DEFAULT_EGRESS_ALERT_BYTES,
  egressThreshold,
  setEgressThreshold,
  ensureEgressApp,
  EGRESS_APP_PANELS,
  EGRESS_APP_TEMPLATE,
  cadenceFromRows,
  type EgressData,
} from "../plugin/gateway/lib/egress";

const dirs: string[] = [];
function freshStore(): KnowledgeStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-egress-"));
  dirs.push(dir);
  return new KnowledgeStore(path.join(dir, "knowledge.db"));
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const LEDGER: EgressData = {
  days: [{ day: "2026-07-09", bytes: 5e9 }],
  todayBytes: 5e9,
  thresholdBytes: DEFAULT_EGRESS_ALERT_BYTES,
  configured: true,
  appId: null,
  cadence: null,
};

describe("cadenceFromRows (what the mirror published to pg_mirror_settings)", () => {
  const rows = (kv: Record<string, string>) => Object.entries(kv).map(([key, value]) => ({ key, value }));
  it("parses the full block", () => {
    expect(
      cadenceFromRows(
        rows({
          interval_ms: "1200000",
          quiet_hours: "23-8",
          quiet_interval_ms: "7200000",
          tz: "America/Los_Angeles",
          daily_bytes_cap: "12000000000",
          next_pass_at: "2026-09-10T15:20:00.000Z",
          paused: "",
        }),
      ),
    ).toEqual({
      intervalMs: 1_200_000,
      quietHours: { start: 23, end: 8 },
      quietIntervalMs: 7_200_000,
      tz: "America/Los_Angeles",
      dailyCapBytes: 12e9,
      nextPassAt: "2026-09-10T15:20:00.000Z",
      paused: null,
    });
  });
  it("no window / no cap / paused, and partial rows degrade sensibly", () => {
    const c = cadenceFromRows(rows({ interval_ms: "900000", quiet_hours: "", daily_bytes_cap: "0", paused: "daily egress cap" }));
    expect(c).toEqual({
      intervalMs: 900_000,
      quietHours: null,
      quietIntervalMs: 900_000,
      tz: "UTC",
      dailyCapBytes: null,
      nextPassAt: null,
      paused: "daily egress cap",
    });
  });
  it("null when no interval was ever published (pre-cadence mirror, empty table)", () => {
    expect(cadenceFromRows([])).toBeNull();
    expect(cadenceFromRows(rows({ paused: "", next_pass_at: "x" }))).toBeNull();
    expect(cadenceFromRows(rows({ interval_ms: "nope" }))).toBeNull();
  });
});

describe("egress threshold knob", () => {
  it("defaults, sets, and disables", () => {
    const store = freshStore();
    expect(egressThreshold(store)).toBe(DEFAULT_EGRESS_ALERT_BYTES);
    setEgressThreshold(store, 5e9);
    expect(egressThreshold(store)).toBe(5e9);
    setEgressThreshold(store, null);
    expect(egressThreshold(store)).toBeNull(); // disabled, NOT back to default
  });
});

describe("built-in Mirror egress app", () => {
  it("does not seed without a ledger", () => {
    const store = freshStore();
    expect(ensureEgressApp(store, { ...LEDGER, configured: false })).toBeNull();
    expect(ensureEgressApp(store, { ...LEDGER, days: [] })).toBeNull();
    expect(store.listPublished().length).toBe(0);
  });

  it("a failed seed retries next tick — the one-shot guard is stamped only after the app row exists", () => {
    const store = freshStore();
    const orig = store.createPublished.bind(store);
    store.createPublished = () => {
      throw new Error("simulated SQLITE_BUSY");
    };
    expect(() => ensureEgressApp(store, LEDGER)).toThrow(/SQLITE_BUSY/); // egressTick's catch swallows this in prod
    store.createPublished = orig;
    // the fluke must not have burned the seed — the next tick succeeds
    const id = ensureEgressApp(store, LEDGER);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(store.getPublishedMeta(id!)).toBeTruthy();
  });

  it("seeds exactly once, as an ordinary team-only app", () => {
    const store = freshStore();
    const id = ensureEgressApp(store, LEDGER);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    const meta = store.getPublishedMeta(id!);
    expect(meta).toBeTruthy();
    expect(meta!.title).toBe("Mirror egress");
    expect(meta!.visibility).toBe("team"); // promotion to public stays a human action (I9)
    expect(meta!.createdBy).toBe("setoku");
    // idempotent: a second tick returns the same app, no duplicate
    expect(ensureEgressApp(store, LEDGER)).toBe(id);
  });

  it("respects an operator's archive — reports no app and never re-seeds", () => {
    const store = freshStore();
    const id = ensureEgressApp(store, LEDGER)!;
    store.archivePublished(id);
    expect(ensureEgressApp(store, LEDGER)).toBeNull();
    expect(store.getPublishedMeta(id)!.archivedAt).toBeTruthy(); // still archived
  });

  it("template and panels agree (the publish-time lint finds nothing)", () => {
    // Every panel is referenced by the template and every reference resolves —
    // the same lint the publish tool runs on agent-authored apps.
    const keys = EGRESS_APP_PANELS.map((p) => p.key);
    expect(lintAppTemplate(EGRESS_APP_TEMPLATE, keys)).toEqual([]);
    // fragment, not a full document (the frame supplies the skeleton)
    expect(EGRESS_APP_TEMPLATE).not.toMatch(/<!doctype|<html/i);
    // panels stay on Setoku's own metadata, clickhouse dialect — portable to any box
    for (const p of EGRESS_APP_PANELS) {
      expect(p.dialect).toBe("clickhouse");
      expect(p.sql).toContain("setoku.pg_mirror_runs");
    }
  });
});
