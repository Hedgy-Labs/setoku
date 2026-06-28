// SPDX-License-Identifier: Apache-2.0
/**
 * Hybrid retrieval (I8 opt-in local embeddings): fusion math, embedding-rescue,
 * and — most importantly — graceful degradation. These run with embeddings OFF
 * (no model loaded), proving the gateway never depends on the embedder being
 * present: disabled → null embedder, inert index, keyword retrieval unchanged.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fuseRRF, retrieve, type ScorableDoc } from "../plugin/gateway/lib/search";
import { embeddingsEnabled, getEmbedder } from "../plugin/gateway/lib/embeddings";
import { EmbedIndex } from "../plugin/gateway/lib/embed-index";
import { KnowledgeStore } from "../plugin/gateway/lib/store";

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

describe("vector persistence (startup is O(changed docs), not O(corpus))", () => {
  it("round-trips embeddings as Float32 BLOBs, scoped by model", () => {
    const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "emb-store-")), "k.db");
    const s = new KnowledgeStore(db);
    const vec = [0.1, -0.25, 0.5, 0.75];
    s.putDocEmbedding("metric", "revenue", "bge-small-en-v1.5", "h1", vec);
    const got = s.getDocEmbeddings("bge-small-en-v1.5");
    expect(got.length).toBe(1);
    expect(got[0].name).toBe("revenue");
    expect(got[0].type).toBe("metric");
    expect(got[0].hash).toBe("h1");
    for (let i = 0; i < vec.length; i++) expect(got[0].vec[i]).toBeCloseTo(vec[i], 5);
    expect(s.getDocEmbeddings("some-other-model").length).toBe(0); // model-scoped
    s.db.close();
  });
});

describe("embedding rescue (hybrid)", () => {
  it("surfaces an embedding-favored doc the keyword scorer misses entirely", () => {
    // query matches NO keyword in any doc → keyword ranking is empty; embedScores
    // (keyed by DocRef, as EmbedIndex.scores produces) promote fan_count, which
    // must still be retrieved via fusion.
    const embedScores = new Map([["metric:fan_count", 0.9], ["metric:ticket_revenue", 0.1]]);
    const out = retrieve(DOCS, "zzz nomatch", { k: 5, embedScores }).map((r) => r.doc.name);
    expect(out).toContain("fan_count");
  });
});
