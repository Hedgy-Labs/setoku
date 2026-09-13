// SPDX-License-Identifier: Apache-2.0
/**
 * gmail-poller tests — the pure units behind the archive walk.
 *
 * The walk is the part worth pinning down: it decides how far back a mailbox is
 * pulled and, because it checkpoints between chunks, a bug here either silently
 * skips history or never terminates. Everything else in poll.ts is I/O against
 * Gmail and Vector (covered by test/gmail-connect.test.ts on the connect side).
 */
import { describe, it, expect } from "bun:test";
import { nextBackfillWindow, mapLimit, backoffMs, rateBackoffMs, Pacer } from "./poll";

const NOW = new Date("2026-09-13T12:00:00Z");
/** Walk to exhaustion, as the poller does, and return every window it asked for. */
const walk = (horizonDays: number, chunkDays: number, cap = 5000): { after: string; before: string }[] => {
  const out: { after: string; before: string }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < cap; i++) {
    const w = nextBackfillWindow(NOW, horizonDays, chunkDays, cursor);
    if (!w) return out;
    out.push(w);
    cursor = w.after.replace(/\//g, "-");
  }
  throw new Error("walk did not terminate");
};

describe("nextBackfillWindow", () => {
  it("starts at today and walks backwards", () => {
    expect(nextBackfillWindow(NOW, 90, 30, undefined)).toEqual({ after: "2026/08/14", before: "2026/09/13" });
  });

  it("resumes from the checkpoint rather than from today", () => {
    expect(nextBackfillWindow(NOW, 90, 30, "2026-08-14")).toEqual({ after: "2026/07/15", before: "2026/08/14" });
  });

  it("leaves no gap between chunks — each window ends where the next begins", () => {
    const ws = walk(90, 30);
    for (let i = 1; i < ws.length; i++) expect(ws[i]!.before).toBe(ws[i - 1]!.after);
  });

  it("clamps the last chunk to the horizon and never reaches past it", () => {
    const ws = walk(70, 30);
    expect(ws.at(-1)!.after).toBe("2026/07/05"); // exactly 70 days back
    expect(ws.length).toBe(3); // 30 + 30 + 10
  });

  it("terminates once the cursor reaches the horizon", () => {
    expect(nextBackfillWindow(NOW, 90, 30, "2026-06-15")).toBeNull();
    expect(nextBackfillWindow(NOW, 90, 30, "2020-01-01")).toBeNull();
  });

  it("covers a multi-year horizon in finite chunks (the campsh case)", () => {
    const ws = walk(365 * 17, 30);
    expect(ws.length).toBe(Math.ceil((365 * 17) / 30));
    expect(ws.at(-1)!.after).toBe("2009/09/17"); // 6205 days back, leap days included
    expect(ws[0]!.before).toBe("2026/09/13"); // newest mail first
  });

  it("a horizon shorter than one chunk is a single clamped window", () => {
    expect(walk(7, 30)).toEqual([{ after: "2026/09/06", before: "2026/09/13" }]);
  });

  it("a zero horizon disables the walk entirely", () => {
    expect(nextBackfillWindow(NOW, 0, 30, undefined)).toBeNull();
  });

  it("a 0-day chunk still advances instead of spinning forever", () => {
    expect(nextBackfillWindow(NOW, 90, 0, undefined)).toEqual({ after: "2026/09/12", before: "2026/09/13" });
  });

  it("an unreadable checkpoint re-walks instead of skipping the archive", () => {
    // Declaring "done" here would silently lose history; re-pulling only costs time.
    expect(nextBackfillWindow(NOW, 90, 30, "not-a-date")).toEqual({ after: "2026/08/14", before: "2026/09/13" });
  });
});

describe("mapLimit", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await mapLimit([50, 10, 30, 0], 4, async (ms) => {
      await Bun.sleep(ms);
      return ms;
    });
    expect(out).toEqual([50, 10, 30, 0]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 50 }, (_, i) => i), 4, async () => {
      peak = Math.max(peak, ++inFlight);
      await Bun.sleep(1);
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it("handles fewer items than the limit, and none at all", async () => {
    expect(await mapLimit([1, 2], 8, async (n) => n * 2)).toEqual([2, 4]);
    expect(await mapLimit([], 8, async (n) => n)).toEqual([]);
  });
});

describe("backoffMs", () => {
  it("spreads concurrent retries instead of synchronizing them", () => {
    // The whole point: N in-flight calls throttled at the same instant must NOT
    // wake at the same instant, or they re-throttle each other until the retry
    // budget is gone (this is what killed the first archive-walk chunk).
    const waits = new Set(Array.from({ length: 50 }, (_, i) => backoffMs(3, 0, i / 50)));
    expect(waits.size).toBeGreaterThan(40);
  });

  it("grows with the attempt number", () => {
    const at = (n: number) => backoffMs(n, 0, 1); // fix the jitter to compare curves
    expect(at(1)).toBeGreaterThan(at(0));
    expect(at(5)).toBeGreaterThan(at(3));
  });

  it("never sleeps less than half the nominal backoff, nor more than it", () => {
    for (const r of [0, 0.5, 0.999]) {
      expect(backoffMs(4, 0, r)).toBeGreaterThanOrEqual(8_000);
      expect(backoffMs(4, 0, r)).toBeLessThanOrEqual(16_000);
    }
  });

  it("honours Retry-After when the server sends a longer one", () => {
    expect(backoffMs(0, 45_000, 0)).toBe(45_000);
    expect(backoffMs(0, 100, 0)).toBe(500); // shorter than our own floor → ignored
  });

  it("caps at five minutes even for a huge attempt or Retry-After", () => {
    expect(backoffMs(99, 0, 1)).toBe(300_000);
    expect(backoffMs(1, 9_999_999, 0)).toBe(300_000);
  });
});

describe("rateBackoffMs", () => {
  // Gmail's limit is "Units per MINUTE per user", so a throttled call may have to
  // wait out most of a minute for the bucket to roll. An earlier version of this
  // backed off in milliseconds on the theory that the quota refilled each second;
  // it did not help, because the ceiling — not the wait — was the bottleneck.
  it("starts at seconds, the scale of a per-minute bucket", () => {
    for (const r of [0, 0.5, 1]) {
      expect(rateBackoffMs(0, 0, r)).toBeGreaterThanOrEqual(1_000);
      expect(rateBackoffMs(0, 0, r)).toBeLessThanOrEqual(2_000);
    }
  });

  it("caps at a minute — the longest a per-minute bucket can need", () => {
    expect(rateBackoffMs(99, 0, 1)).toBe(60_000);
  });

  it("grows with repeated throttling, so a hot worker self-paces", () => {
    expect(rateBackoffMs(4, 0, 1)).toBeGreaterThan(rateBackoffMs(0, 0, 1));
  });

  it("jitters, so concurrent workers do not retry in lockstep", () => {
    const waits = new Set(Array.from({ length: 50 }, (_, i) => rateBackoffMs(4, 0, i / 50)));
    expect(waits.size).toBeGreaterThan(40);
  });

  it("obeys Retry-After even past the ceiling — the server knows its own bucket", () => {
    expect(rateBackoffMs(0, 90_000, 0)).toBe(90_000);
  });
});

describe("Pacer", () => {
  it("spaces requests at the target rate", () => {
    const p = new Pacer(2, 0.25, 20); // 2/s → one every 500ms
    expect(p.reserve(1000)).toBe(0); // first goes immediately
    expect(p.reserve(1000)).toBe(500); // second waits out the gap
    expect(p.reserve(1000)).toBe(1000);
  });

  it("does not make a caller wait when the rate has already been met", () => {
    const p = new Pacer(2, 0.25, 20);
    p.reserve(1000);
    expect(p.reserve(9000)).toBe(0); // long idle — the slot is free again
  });

  it("halves the rate on a throttle (multiplicative decrease)", () => {
    const p = new Pacer(8, 0.25, 20);
    p.onThrottle(0, 0);
    expect(p.rate).toBe(4);
    p.onThrottle(0, 0);
    expect(p.rate).toBe(2);
  });

  it("never drops below the floor, however often it is throttled", () => {
    const p = new Pacer(8, 0.25, 20);
    for (let i = 0; i < 50; i++) p.onThrottle(0, 0);
    expect(p.rate).toBe(0.25);
  });

  it("holds the whole fleet off for the cool-off after a throttle", () => {
    const p = new Pacer(2, 0.25, 20);
    p.onThrottle(1000, 30_000);
    expect(p.reserve(1000)).toBe(30_000); // per-minute bucket needs time to roll
  });

  it("creeps back up only after a run of clean responses (additive increase)", () => {
    const p = new Pacer(2, 0.25, 20);
    for (let i = 0; i < 39; i++) p.onSuccess(0.25, 40);
    expect(p.rate).toBe(2); // not yet
    p.onSuccess(0.25, 40);
    expect(p.rate).toBe(2.25);
  });

  it("a single throttle resets the progress toward an increase", () => {
    const p = new Pacer(2, 0.25, 20);
    for (let i = 0; i < 39; i++) p.onSuccess(0.25, 40);
    p.onThrottle(0, 0); // rate 1, and the clean streak is gone
    for (let i = 0; i < 39; i++) p.onSuccess(0.25, 40);
    expect(p.rate).toBe(1);
  });

  it("converges just under a ceiling instead of oscillating wildly", () => {
    // Model a server that rejects anything above 2.5/s and check where we settle.
    const CEILING = 2.5;
    const p = new Pacer(2, 0.25, 20);
    for (let i = 0; i < 4000; i++) {
      if (p.rate > CEILING) p.onThrottle(0, 0);
      else p.onSuccess(0.25, 40);
    }
    expect(p.rate).toBeGreaterThan(1);
    expect(p.rate).toBeLessThanOrEqual(CEILING + 0.25);
  });

  it("respects the configured maximum", () => {
    const p = new Pacer(19.9, 0.25, 20);
    for (let i = 0; i < 500; i++) p.onSuccess(0.25, 1);
    expect(p.rate).toBe(20);
  });
});
