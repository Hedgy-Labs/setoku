// SPDX-License-Identifier: Apache-2.0
/**
 * In-memory semantic index over curated docs — the doc-side of hybrid retrieval.
 *
 * Holds one embedding per non-gotcha doc (computed by the local model in
 * embeddings.ts) and scores a query against them by cosine. Built in the
 * background at startup and updated on upsert/delete, so the request path never
 * blocks on the model. Disabled (and inert) unless embeddings are enabled AND the
 * model loaded — every method no-ops to "no scores" otherwise, so find_context
 * falls back to keyword retrieval (I8 graceful degradation).
 *
 * Vectors live in memory (re-embedded at startup). For the demo's ~44 docs that's
 * a few seconds, once. Persisting vectors to the store is the scale follow-up.
 */
import { cosine, getEmbedder, type Embedder } from "./embeddings";
import type { ScorableDoc } from "./search";
import type { KnowledgeDoc } from "./store";

/** The text we embed for a doc — name + summary + keywords + body (capped). The
 *  same representation the offline A/B uses, so eval tracks production. */
export function docTextForEmbedding(d: ScorableDoc): string {
  const kw = Array.isArray(d.meta.keywords)
    ? d.meta.keywords.join(" ")
    : String(d.meta.keywords ?? "");
  return `${d.name}. ${d.meta.summary ?? ""} ${kw} ${d.body}`.slice(0, 1200);
}

export class EmbedIndex {
  private vecs = new Map<string, number[]>(); // doc name → embedding
  private embedder: Embedder | null = null;
  /** True only once the model loaded AND docs are embedded. */
  enabled = false;

  /** Create an inert index. Call start() to build it in the background. */
  static create(): EmbedIndex {
    return new EmbedIndex();
  }

  /** Kick off model load + initial embedding in the background (non-blocking).
   *  `getDocs` is read at build time so it sees the seeded store. */
  start(getDocs: () => KnowledgeDoc[]): void {
    void (async () => {
      const e = await getEmbedder();
      if (!e) return; // disabled or failed → stays inert, callers fall back
      this.embedder = e;
      await this.rebuild(getDocs());
      this.enabled = true;
      console.error(`[embeddings] index ready — ${this.vecs.size} docs, dim ${e.dim}`);
    })().catch((err) =>
      console.error(`[embeddings] index build failed (keyword fallback stays live): ${(err as Error).message}`),
    );
  }

  private async rebuild(docs: KnowledgeDoc[]): Promise<void> {
    if (!this.embedder) return;
    const indexable = docs.filter((d) => d.type !== "gotcha");
    const vecs = await this.embedder.embedDocs(indexable.map(docTextForEmbedding));
    this.vecs = new Map(indexable.map((d, i) => [d.name, vecs[i]]));
  }

  /** Re-embed one doc after a curator upsert (gotchas are not indexed). */
  async upsert(doc: KnowledgeDoc): Promise<void> {
    if (!this.embedder || doc.type === "gotcha") return;
    try {
      const [v] = await this.embedder.embedDocs([docTextForEmbedding(doc)]);
      if (v) this.vecs.set(doc.name, v);
    } catch (e) {
      console.error(`[embeddings] upsert embed failed for ${doc.name}: ${(e as Error).message}`);
    }
  }

  remove(name: string): void {
    this.vecs.delete(name);
  }

  /** Cosine score for every indexed doc, or null when unavailable (→ fall back). */
  async scores(question: string): Promise<Map<string, number> | null> {
    if (!this.enabled || !this.embedder || !this.vecs.size) return null;
    try {
      const qv = await this.embedder.embedQuery(question);
      const out = new Map<string, number>();
      for (const [name, v] of this.vecs) out.set(name, cosine(qv, v));
      return out;
    } catch (e) {
      console.error(`[embeddings] query embed failed (keyword fallback): ${(e as Error).message}`);
      return null;
    }
  }
}
