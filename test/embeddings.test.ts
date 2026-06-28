// SPDX-License-Identifier: Apache-2.0
/**
 * Hybrid retrieval (I8 opt-in local embeddings): fusion math, embedding-rescue,
 * and — most importantly — graceful degradation. These run with embeddings OFF
 * (no model loaded), proving the gateway never depends on the embedder being
 * present: disabled → null embedder, inert index, keyword retrieval unchanged.
 */
import { describe, expect, it } from "bun:test";
import { fuseRRF, retrieve, type ScorableDoc } from "../plugin/gateway/lib/search";
import { embeddingsEnabled, getEmbedder } from "../plugin/gateway/lib/embeddings";
import { EmbedIndex } from "../plugin/gateway/lib/embed-index";

const DOCS: ScorableDoc[] = [
  { type: "metric", name: "ticket_revenue", meta: { keywords: ["tickets", "seats"] }, body: "seat sales" },
  { type: "metric", name: "fan_count", meta: { keywords: ["fans"] }, body: "distinct fans" },
];

describe("graceful degradation (embeddings off by default)", () => {
  it("is disabled unless SETOKU_EMBEDDINGS=1", () => {
    expect(embeddingsEnabled()).toBe(false); // not set in the test env
  });

  it("getEmbedder() returns null when disabled (no native load)", async () => {
    expect(await getEmbedder()).toBeNull();
  });

  it("EmbedIndex is inert: not enabled, scores() is null, start() is a no-op", async () => {
    const idx = EmbedIndex.create();
    idx.start(() => DOCS as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(idx.enabled).toBe(false);
    expect(await idx.scores("anything")).toBeNull();
  });

  it("retrieve without embedScores is exactly the keyword path", () => {
    const a = retrieve(DOCS, "ticket seats", { k: 5 }).map((r) => r.doc.name);
    const b = retrieve(DOCS, "ticket seats", { k: 5, embedScores: undefined }).map((r) => r.doc.name);
    expect(a).toEqual(b);
  });
});

describe("reciprocal-rank fusion", () => {
  it("ranks an item agreed-on by both lists above either alone", () => {
    const fused = fuseRRF([["a", "b", "c"], ["b", "a", "d"]]);
    expect(fused[0]).toBe("a"); // a is high in both
    expect(fused).toContain("d");
  });

  it("weights bias the fusion toward the heavier list", () => {
    // disjoint lists: the heavy list's top (c) must outrank the light list's top (a)
    const fused = fuseRRF([["c"], ["a"]], 60, [5, 1]);
    expect(fused[0]).toBe("c");
  });
});

describe("embedding rescue (hybrid)", () => {
  it("surfaces an embedding-favored doc the keyword scorer misses entirely", () => {
    // query matches NO keyword in any doc → keyword ranking is empty; embedScores
    // promote fan_count, which must still be retrieved via fusion.
    const embedScores = new Map([["fan_count", 0.9], ["ticket_revenue", 0.1]]);
    const out = retrieve(DOCS, "zzz nomatch", { k: 5, embedScores }).map((r) => r.doc.name);
    expect(out).toContain("fan_count");
  });
});
