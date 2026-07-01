// SPDX-License-Identifier: Apache-2.0
/**
 * Per-tenant DERIVED synonyms (issue #33): a non-sports tenant gets synonym-tier
 * recall over its OWN vocabulary without anyone hand-editing synonyms.ts, and the
 * retired global thesaurus is gone from the base table.
 *
 * The offline clustering is driven by an INJECTED fake embedder (deterministic
 * one-hot vectors), so these run model-free in CI — proving the mechanism, not
 * the specific BGE geometry.
 */
process.env.SETOKU_EMBEDDINGS = "0"; // never load the native model in the suite
import { describe, expect, it } from "bun:test";
import { retrieve, scoreDocs, type ScorableDoc } from "../plugin/gateway/lib/search";
import { combineSynonyms, synonymsOf } from "../plugin/gateway/lib/synonyms";
import {
  buildNeighborTable,
  docVocabulary,
  DerivedSynonyms,
  type EmbedFn,
} from "../plugin/gateway/lib/derived-synonyms";
import type { Embedder } from "../plugin/gateway/lib/embeddings";

/** Deterministic fake embedder: terms in the same group get identical one-hot
 *  vectors (cosine 1); every other term gets its own dimension (cosine 0). */
function fakeEmbed(groups: string[][]): EmbedFn {
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((t) => groupOf.set(t, i)));
  let next = groups.length;
  const dimOf = new Map<string, number>();
  const dim = (t: string): number => {
    if (groupOf.has(t)) return groupOf.get(t)!;
    if (!dimOf.has(t)) dimOf.set(t, next++);
    return dimOf.get(t)!;
  };
  return async (terms) => {
    terms.forEach(dim); // assign every dimension first so all vectors share length
    const D = next;
    return terms.map((t) => {
      const v = new Array(D).fill(0);
      v[dim(t)] = 1;
      return v;
    });
  };
}

/** A tenant in a domain the retired thesaurus never covered (retail catalog):
 *  "product" and "sku" are used interchangeably, but only in the tenant's docs. */
const CATALOG: string[][] = [["product", "products", "sku", "skus", "item", "items"]];

describe("docVocabulary", () => {
  const docs: ScorableDoc[] = [
    { type: "metric", name: "revenue_report", meta: { keywords: ["revenue", "money"] }, body: "revenue revenue revenue revenue growth the 2024" },
    { type: "note", name: "growth", meta: { summary: "growth trend" }, body: "growth details 42" },
  ];

  it("keeps salient terms, drops stopwords / short tokens / numbers", () => {
    const vocab = docVocabulary(docs, { minFrequency: 2, minTermLength: 4 });
    expect(vocab).toContain("revenue");
    expect(vocab).toContain("growth");
    expect(vocab).not.toContain("the"); // stopword
    expect(vocab).not.toContain("2024"); // pure number
    expect(vocab).not.toContain("42"); // pure number
    expect(vocab.every((t) => t.length >= 4)).toBe(true);
  });

  it("is deterministic and honors the vocab cap (frequency-ranked)", () => {
    const a = docVocabulary(docs, { minFrequency: 1, minTermLength: 3, maxVocab: 3 });
    const b = docVocabulary(docs, { minFrequency: 1, minTermLength: 3, maxVocab: 3 });
    expect(a).toEqual(b);
    expect(a.length).toBe(3);
    expect(a[0]).toBe("revenue"); // highest frequency ranks first
  });
});

describe("buildNeighborTable", () => {
  it("clusters embedding-near terms, omits terms with no neighbor", async () => {
    const vocab = ["product", "sku", "item", "revenue"];
    const table = await buildNeighborTable(vocab, fakeEmbed(CATALOG), { minSim: 0.62 });
    expect(table.get("product")).toEqual(expect.arrayContaining(["sku", "item"]));
    expect(table.get("product")).not.toContain("revenue"); // orthogonal → below floor
    expect(table.has("revenue")).toBe(false); // no neighbor → omitted
  });

  it("respects maxNeighbors and never lists the term itself", async () => {
    const vocab = ["product", "sku", "item", "products"];
    const table = await buildNeighborTable(vocab, fakeEmbed(CATALOG), { maxNeighbors: 2 });
    const n = table.get("product")!;
    expect(n.length).toBe(2);
    expect(n).not.toContain("product");
  });

  it("returns an empty table for a degenerate vocabulary", async () => {
    expect((await buildNeighborTable([], fakeEmbed(CATALOG))).size).toBe(0);
    expect((await buildNeighborTable(["only"], fakeEmbed(CATALOG))).size).toBe(0);
  });
});

describe("DerivedSynonyms lifecycle", () => {
  const docs: ScorableDoc[] = [
    { type: "metric", name: "catalog", meta: { keywords: ["product", "sku"] }, body: "product product sku sku" },
  ];
  const embedder: Embedder = {
    id: "fake",
    dim: 1,
    embedDocs: fakeEmbed(CATALOG),
    embedQuery: async () => [0],
  };

  it("stays inert with no embedder (base table only)", async () => {
    const d = DerivedSynonyms.create();
    d.start(() => docs, { embedder: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(d.enabled).toBe(false);
    expect(d.neighbors("product")).toEqual([]);
  });

  it("builds a per-tenant table from the seeded docs", async () => {
    const d = DerivedSynonyms.create();
    await d.rebuild(docs, embedder.embedDocs, { minFrequency: 1, minTermLength: 3 });
    expect(d.neighbors("product")).toContain("sku");
  });
});

describe("acceptance: a non-sports tenant gets synonym-tier recall", () => {
  // The retired global thesaurus knew nothing about retail catalogs.
  const docs: ScorableDoc[] = [
    { type: "metric", name: "sku_inventory", meta: { keywords: ["sku", "skus"] }, body: "distinct skus on hand" },
    { type: "note", name: "catalog_glossary", meta: { summary: "product and sku are interchangeable" }, body: "each product maps to exactly one sku; product product" },
  ];

  it("the base table alone misses the paraphrase (no hand-authored bridge)", () => {
    // "product" never appears in the target metric — only "sku" does.
    const hits = scoreDocs(docs, "product", { synonyms: synonymsOf }).map((s) => s.doc.name);
    expect(hits).not.toContain("sku_inventory");
  });

  it("the derived table bridges product→sku and recovers the metric", async () => {
    const derived = DerivedSynonyms.create();
    await derived.rebuild(docs, fakeEmbed(CATALOG), { minFrequency: 1, minTermLength: 3 });
    const synonyms = combineSynonyms(synonymsOf, derived.neighbors);
    const hits = retrieve(docs, "product", { k: 5, synonyms }).map((r) => r.doc.name);
    expect(hits).toContain("sku_inventory"); // recovered without editing synonyms.ts
  });
});

describe("the retired global thesaurus is gone from the base table", () => {
  it("sports/e-commerce vocabulary no longer expands globally", () => {
    // Morphology (plural↔singular) still applies; the THESAURUS bridges are gone.
    expect(synonymsOf("supporters")).not.toContain("fans");
    expect(synonymsOf("sponsor")).not.toContain("partner");
    expect(synonymsOf("turnstile")).not.toContain("attendance");
    expect(synonymsOf("opponent")).toContain("opponents"); // only morphology remains
    expect(synonymsOf("opponent")).not.toContain("rival"); // the thesaurus bridge is gone
  });

  it("keeps the domain-general base (money + morphology)", () => {
    expect(synonymsOf("earnings")).toContain("revenue");
    expect(synonymsOf("fans")).toContain("fan"); // morphology survives, thesaurus doesn't
  });
});
