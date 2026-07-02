// SPDX-License-Identifier: Apache-2.0
/**
 * Wiki layer: link graph, map-first retrieval, and structural lint
 * (experiment/llm-wiki). These are the guardrails for the retrieval change —
 * they prove link-expansion LIFTS recall while leaving the proven direct top-k
 * (and so MRR/precision on it) untouched, and that the new orphan/connection/
 * broken-link detectors fire on planted ground truth.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  findOrphans,
  suggestConnections,
} from "../plugin/gateway/lib/facts";
import { retrievalMetrics, trapCoverage } from "../plugin/gateway/lib/quality";
import {
  buildLinkGraph,
  neighbors,
  retrieve,
  scoreDocs,
  selectGotchas,
  type ScorableDoc,
} from "../plugin/gateway/lib/search";
import { synonymsOf } from "../plugin/gateway/lib/synonyms";

const SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "fixtures/eval/wiki.json"), "utf8"),
);
const DOCS: ScorableDoc[] = SPEC.docs;

describe("buildLinkGraph (keyed by DocRef)", () => {
  it("resolves declared meta.links and computes backlinks", () => {
    const g = buildLinkGraph(DOCS);
    expect([...(g.out.get("metric:revenue") ?? [])].sort()).toEqual([
      "entity:order",
      "gotcha:money-is-cents",
      "gotcha:refunds-excluded",
    ]);
    expect(g.back.get("entity:order")?.has("metric:revenue")).toBe(true);
    // a gotcha's relates_to is an implicit link
    expect(g.out.get("gotcha:refunds-excluded")?.has("metric:revenue")).toBe(true);
    // nameOf maps refs back to readable names for display
    expect(g.nameOf.get("metric:revenue")).toBe("revenue");
  });

  it("records a declared link that resolves to no doc as broken", () => {
    const g = buildLinkGraph(DOCS);
    expect(g.unresolved).toContainEqual({ from: "Order", fromRef: "entity:order", ref: "Coupon" });
  });

  it("neighbors() is the undirected 1-hop set", () => {
    const g = buildLinkGraph(DOCS);
    const n = neighbors(g, "metric:revenue");
    expect(n).toContain("entity:order"); // out
    expect(n).toContain("metric:net_revenue"); // back (net_revenue → revenue)
  });
});

describe("DocRef identity — same name across types can't merge", () => {
  const collide: ScorableDoc[] = [
    { type: "entity", name: "revenue", meta: { keywords: ["revenue", "ledger"] }, body: "the revenue ledger table" },
    { type: "metric", name: "revenue", meta: { keywords: ["revenue", "money"] }, body: "sum of paid revenue" },
  ];

  it("retrieve returns BOTH same-named docs (name-keyed Maps would drop one)", () => {
    const out = retrieve(collide, "revenue", { k: 5 });
    const refs = out.map((r) => `${r.doc.type}:${r.doc.name}`);
    expect(refs).toContain("entity:revenue");
    expect(refs).toContain("metric:revenue");
    expect(out.length).toBe(2);
  });

  it("an ambiguous link is unresolved (not silently pointed at one); type:name resolves", () => {
    const ambiguous: ScorableDoc[] = [
      ...collide,
      { type: "query", name: "q", meta: { links: ["revenue"] }, body: "" },
    ];
    expect(buildLinkGraph(ambiguous).unresolved).toContainEqual({ from: "q", fromRef: "query:q", ref: "revenue" });
    const explicit: ScorableDoc[] = [
      ...collide,
      { type: "query", name: "q", meta: { links: ["metric:revenue"] }, body: "" },
    ];
    expect(buildLinkGraph(explicit).out.get("query:q")?.has("metric:revenue")).toBe(true);
  });
});

describe("map-first retrieval (link-expansion)", () => {
  it("expansion lifts recall@k without changing the direct ranking (MRR equal)", () => {
    const baseline = retrievalMetrics(DOCS, SPEC.retrieval, 5);
    const expanded = retrievalMetrics(DOCS, SPEC.retrieval, 5, {
      expandLinks: true,
    });
    expect(expanded.recallAtK).toBeGreaterThan(baseline.recallAtK);
    // direct order is untouched → first-relevant-rank (and thus MRR) identical
    expect(expanded.mrr).toBeCloseTo(baseline.mrr, 10);
    expect(expanded.expandedLinks).toBe(true);
    expect(baseline.expandedLinks).toBe(false);
  });

  it("retrieve() returns direct hits first, then linked neighbors below them", () => {
    const out = retrieve(DOCS, "how is recognized revenue calculated?", {
      k: 3,
      expandLinks: true,
    });
    const direct = out.filter((r) => r.via === "direct");
    const linked = out.filter((r) => r.via === "linked");
    expect(direct.length).toBeGreaterThan(0);
    expect(linked.length).toBeGreaterThan(0);
    // every linked doc scores no higher than the lowest direct hit
    const minDirect = Math.min(...direct.map((d) => d.score));
    for (const l of linked) expect(l.score).toBeLessThanOrEqual(minDirect);
    // a linked doc names the direct hit that surfaced it
    for (const l of linked) expect(l.from).toBeTruthy();
  });

  it("without expansion, retrieve() is exactly the keyword top-k", () => {
    const out = retrieve(DOCS, "average order value", { k: 5 });
    expect(out.every((r) => r.via === "direct")).toBe(true);
  });

  it("caps purely-structural linked neighbors (precision guard)", () => {
    // a hit that links to 5 docs none of which match the query → all structural
    const corpus: ScorableDoc[] = [
      { type: "metric", name: "revenue", meta: { keywords: ["revenue"], links: ["a", "b", "c", "d", "e"] }, body: "" },
      ...["a", "b", "c", "d", "e"].map((n) => ({ type: "entity" as const, name: n, meta: {}, body: "unrelated" })),
    ];
    const linked = retrieve(corpus, "revenue", { k: 1, expandLinks: true, maxLinked: 5, maxStructuralLinked: 2 }).filter((r) => r.via === "linked");
    expect(linked.length).toBe(2); // 5 structural neighbors capped to 2 (maxLinked=5 not binding)
  });
});

describe("selectGotchas (attached-first, capped)", () => {
  const gotchas: ScorableDoc[] = [
    { type: "gotcha", name: "g-refunds", meta: { relates_to: "revenue" }, body: "Refunded orders excluded from revenue." },
    { type: "gotcha", name: "g-cents", meta: {}, body: "All money columns are integer cents — divide by 100." },
    { type: "gotcha", name: "g-unrelated", meta: {}, body: "Gameday parking lots open three hours early." },
  ];
  const revenue: ScorableDoc = { type: "metric", name: "revenue", meta: { summary: "Paid revenue." }, body: "" };

  it("surfaces the gotcha attached to a direct hit even without a shared query word", () => {
    // question shares no word with g-refunds' body, but it relates_to the hit
    const sel = selectGotchas(gotchas, [revenue], "how much did we earn?").map((g) => g.name);
    expect(sel).toContain("g-refunds");
  });

  it("drops gotchas that are neither attached nor query-relevant", () => {
    const sel = selectGotchas(gotchas, [revenue], "revenue in cents?").map((g) => g.name);
    expect(sel).toContain("g-refunds"); // attached
    expect(sel).toContain("g-cents"); // query-relevant ("cents")
    expect(sel).not.toContain("g-unrelated"); // neither
  });

  it("respects the cap", () => {
    expect(selectGotchas(gotchas, [revenue], "revenue cents parking", 1).length).toBe(1);
  });
});

describe("trap coverage (value eval)", () => {
  const corpus: ScorableDoc[] = [
    {
      type: "metric",
      name: "revenue",
      meta: { summary: "Recognized revenue, paid orders only.", keywords: ["revenue", "sales"] },
      body: "Sum of paid orders. Refunded orders are excluded entirely.",
    },
    {
      type: "gotcha",
      name: "refunds-excluded",
      meta: { keywords: ["refund", "revenue"] },
      body: "Refunded orders are excluded from revenue — never netted.",
    },
  ];

  it("ungrounded (no docs) covers nothing — the rate is the grounded lift", () => {
    const m = trapCoverage([], [{ question: "how much revenue?", trap: "x", signature: ["excluded"] }], 5);
    expect(m.coverageRate).toBe(0);
  });

  it("covers a trap when the fix surfaces, and reports what's missing when it doesn't", () => {
    const traps = [
      { question: "how much revenue did we make?", trap: "includes refunds", signature: ["excluded"] },
      { question: "how much revenue did we make?", trap: "nope", signature: ["this phrase is absent"] },
    ];
    const m = trapCoverage(corpus, traps, 5);
    expect(m.perCase[0].covered).toBe(true);
    expect(m.perCase[1].covered).toBe(false);
    expect(m.perCase[1].missing).toContain("this phrase is absent");
    expect(m.avgGotchasSurfaced).toBeGreaterThan(0); // the refunds gotcha shares a token
  });
});

describe("synonym query expansion (I8-clean semantic layer)", () => {
  const docs: ScorableDoc[] = [
    { type: "metric", name: "total_revenue", meta: { summary: "Recognized revenue.", keywords: ["revenue", "sales"] }, body: "Sum of paid invoices." },
    { type: "metric", name: "active_customers", meta: { summary: "Distinct buyers.", keywords: ["customers"] }, body: "Deduped customer count." },
  ];

  it("synonymsOf returns DOMAIN-GENERAL cluster neighbors, [] for unknown tokens", () => {
    expect(synonymsOf("earnings")).toContain("revenue"); // generic money cluster
    expect(synonymsOf("zzxq")).not.toContain("revenue"); // no thesaurus neighbor
    // the retired sports/e-commerce vocabulary is no longer a global synonym
    expect(synonymsOf("supporters")).not.toContain("fans");
    expect(synonymsOf("jersey")).not.toContain("merch");
  });

  it("synonymsOf covers plural↔singular morphology algorithmically", () => {
    expect(synonymsOf("customers")).toContain("customer");
    expect(synonymsOf("party")).toContain("parties");
  });

  it("a synonym-only query misses without expansion and hits with it", () => {
    const off = scoreDocs(docs, "how much earnings?").map((s) => s.doc.name);
    expect(off).not.toContain("total_revenue"); // "earnings" != "revenue" lexically
    const on = scoreDocs(docs, "how much earnings?", { synonyms: synonymsOf }).map((s) => s.doc.name);
    expect(on).toContain("total_revenue");
  });

  it("does not change ranking when the query matches exactly (no regression)", () => {
    const off = scoreDocs(docs, "customers").map((s) => s.doc.name);
    const on = scoreDocs(docs, "customers", { synonyms: synonymsOf }).map((s) => s.doc.name);
    expect(on).toEqual(off); // exact hit present → synonym fallback never fires here
  });
});

describe("structural lint", () => {
  it("flags a doc with no links in or out as an orphan", () => {
    const orphans = findOrphans(DOCS as never).map((o) => o.ref);
    expect(orphans).toContain("subscriptions");
    // a linked metric is NOT an orphan
    expect(orphans).not.toContain("revenue");
  });

  it("suggests a connection for topically-overlapping but unlinked docs", () => {
    const conns = suggestConnections(DOCS as never).map((c) =>
      [c.a, c.b].sort().join("|"),
    );
    expect(conns).toContain("arr_metric|mrr_metric");
    // already-linked pairs are not re-suggested
    expect(conns).not.toContain("net_revenue|revenue");
  });
});
