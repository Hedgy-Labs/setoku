// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  defectMetrics,
  judgementMetrics,
  knowledgeStats,
  redundancyReport,
  retrievalMetrics,
  type RetrievalCase,
} from "../plugin/gateway/lib/quality";
import { runQuality, checkGate } from "../plugin/gateway/quality-cli";
import type { ScorableDoc } from "../plugin/gateway/lib/search";

const SPEC = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dir, "fixtures/eval/knowledge.json"),
    "utf8",
  ),
);
const DOCS: ScorableDoc[] = SPEC.docs;

describe("retrievalMetrics", () => {
  it("reuses the production scorer and finds the relevant doc for each golden question", () => {
    const m = retrievalMetrics(DOCS, SPEC.retrieval, SPEC.k);
    expect(m.cases).toBe(3);
    expect(m.hitRate).toBe(1); // every question retrieves a relevant doc
    expect(m.recallAtK).toBeGreaterThan(0.9);
    expect(m.mrr).toBeGreaterThan(0);
  });

  it("counts a coverage gap when the relevant doc is absent from the store", () => {
    const cases: RetrievalCase[] = [
      { question: "what is our churn rate?", relevant: ["churn"] },
    ];
    const m = retrievalMetrics(DOCS, cases, 5);
    expect(m.hitRate).toBe(0);
    expect(m.recallAtK).toBe(0);
    expect(m.perCase[0].firstRelevantRank).toBeNull();
  });

  it("ranks an exact name match first (MRR = 1)", () => {
    const m = retrievalMetrics(DOCS, [
      { question: "active customers", relevant: ["Customer"] },
    ], 5);
    expect(m.perCase[0].firstRelevantRank).toBe(1);
    expect(m.mrr).toBe(1);
  });
});

describe("redundancyReport", () => {
  it("flags the planted near-duplicate pair above threshold", () => {
    const pairs = redundancyReport(DOCS, 0.6);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const top = pairs[0];
    expect([top.a, top.b].sort()).toEqual(["recognized_revenue", "revenue"]);
    expect(top.similarity).toBeGreaterThanOrEqual(0.6);
  });

  it("finds nothing among distinct docs", () => {
    const distinct = DOCS.filter((d) => d.name !== "recognized_revenue");
    expect(redundancyReport(distinct, 0.6)).toEqual([]);
  });
});

describe("judgementMetrics", () => {
  it("computes the false-accept rate as the load-bearing I9 number", () => {
    const m = judgementMetrics(SPEC.judgement);
    // 3 gold-reject rows, 1 of them wrongly accepted → 1/3
    expect(m.falsePositives).toBe(1);
    expect(m.trueNegatives).toBe(2);
    expect(m.falseAcceptRate).toBeCloseTo(1 / 3, 5);
    expect(m.precision).toBeCloseTo(2 / 3, 5); // 2 TP / (2 TP + 1 FP)
  });

  it("is all-zeros-safe on empty input", () => {
    const m = judgementMetrics([]);
    expect(m.total).toBe(0);
    expect(m.falseAcceptRate).toBe(0);
  });
});

describe("defectMetrics", () => {
  it("grades a detector against planted ground truth", () => {
    const m = defectMetrics(["dup:a|b", "dup:c|d"], ["dup:a|b", "dup:e|f"]);
    expect(m.truePositives).toBe(1);
    expect(m.precision).toBe(0.5);
    expect(m.recall).toBe(0.5);
    expect(m.missed).toEqual(["dup:e|f"]);
    expect(m.spurious).toEqual(["dup:c|d"]);
  });
});

describe("knowledgeStats", () => {
  it("summarizes the store and counts redundant pairs", () => {
    const s = knowledgeStats(DOCS, 0.6);
    expect(s.docs).toBe(DOCS.length);
    expect(s.byType.metric).toBe(2);
    expect(s.redundantPairs).toBeGreaterThanOrEqual(1);
    expect(s.totalTokens).toBeGreaterThan(0);
  });
});

describe("runQuality + checkGate (CLI core)", () => {
  it("auto-derives the duplicate detector from the redundancy report and scores it", () => {
    const r = runQuality(SPEC, DOCS);
    expect(r.defects).not.toBeNull();
    expect(r.defects!.recall).toBe(1); // planted dup is detected deterministically
  });

  it("passes the fixture's own gate", () => {
    const r = runQuality(SPEC, DOCS);
    expect(checkGate(SPEC, r)).toEqual([]);
  });

  it("reports a gate failure when a threshold is violated", () => {
    const r = runQuality(SPEC, DOCS);
    const strict = { ...SPEC, gate: { maxFalseAcceptRate: 0.1 } };
    const fails = checkGate(strict, r);
    expect(fails.length).toBe(1);
    expect(fails[0]).toContain("false-accept rate");
  });
});
