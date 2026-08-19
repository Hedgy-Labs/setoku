// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { normalizeRanges } from "../lib/ads.ts";

const ad = (start: number, end: number, kind = "sponsor_read") => ({ start, end, kind, note: "" });

describe("normalizeRanges", () => {
  test("sorts, merges overlaps and near-adjacent ranges", () => {
    const out = normalizeRanges([ad(100, 130), ad(10, 40), ad(42, 70), ad(200, 260)], 3600);
    expect(out.map((a) => [a.start, a.end])).toEqual([[10, 70], [100, 130], [200, 260]]);
  });

  test("clamps to episode bounds and drops slivers", () => {
    const out = normalizeRanges([ad(-5, 20), ad(3590, 3700), ad(500, 502)], 3600);
    expect(out.map((a) => [a.start, a.end])).toEqual([[0, 20], [3590, 3600]]);
  });

  test("empty input", () => {
    expect(normalizeRanges([], 3600)).toEqual([]);
  });

  test("null duration leaves ends unclamped", () => {
    const out = normalizeRanges([ad(10, 99999)], null);
    expect(out[0].end).toBe(99999);
  });
});
