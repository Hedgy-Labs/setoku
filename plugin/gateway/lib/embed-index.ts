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
 * Scale: vectors are PERSISTED to the store (doc_embeddings), keyed by a content
 * hash + model id. On restart we load vectors and re-embed only docs whose text
 * (or the model) changed — startup is O(changed docs), not O(corpus). A 384-d
 * vector is ~1.5KB, so even 100k docs is ~150MB; the model+runtime dominates RAM.
 */
import { cosine, getEmbedder, type Embedder } from "./embeddings";
import { docRef, type ScorableDoc } from "./search";
import type { KnowledgeDoc, KnowledgeStore } from "./store";

/** Identifies the embedding space; changing the model invalidates persisted vecs. */
const MODEL_ID = "bge-small-en-v1.5";

/** The text we embed for a doc — name + summary + keywords + body (capped). The
 *  same representation the offline A/B uses, so eval tracks production. */
export function docTextForEmbedding(d: ScorableDoc): string {
  const kw = Array.isArray(d.meta.keywords)
    ? d.meta.keywords.join(" ")
    : String(d.meta.keywords ?? "");
  return `${d.name}. ${d.meta.summary ?? ""} ${kw} ${d.body}`.slice(0, 1200);
}

/** Cheap content hash for change detection (non-crypto is fine here). */
function textHash(text: string): string {
  return Bun.hash(text).toString(16);
}

export class EmbedIndex {
  private vecs = new Map<string, number[]>(); // DocRef (type:name) → embedding
  private embedder: Embedder | null = null;
  private store: KnowledgeStore | null = null;
  /** True only once the model loaded AND docs are embedded. */
  enabled = false;

  /** Create an inert index. Call start() to build it in the background. */
  static create(): EmbedIndex {
    return new EmbedIndex();
  }

  /** Kick off model load + initial embedding in the background (non-blocking).
   *  `getDocs` is read at build time so it sees the seeded store. `store` (when
   *  given) persists/loads vectors so restarts don't re-embed unchanged docs. */
  start(getDocs: () => KnowledgeDoc[], store?: KnowledgeStore): void {
    this.store = store ?? null;
    void (async () => {
      const e = await getEmbedder();
      if (!e) return; // disabled or failed → stays inert, callers fall back
      this.embedder = e;
      await this.rebuild(getDocs());
      this.enabled = true;
    })().catch((err) =>
      console.error(`[embeddings] index build failed (keyword fallback stays live): ${(err as Error).message}`),
    );
  }

  private async rebuild(docs: KnowledgeDoc[]): Promise<void> {
    if (!this.embedder) return;
    // The index is a pure projection of the current docs. Load persisted vectors
    // (keyed by DocRef), reuse unchanged ones, and PRUNE any whose doc no longer
    // exists — so renames/deletes can't leave orphan vectors behind.
    const persisted = new Map(
      (this.store?.getDocEmbeddings(MODEL_ID) ?? []).map((r) => [docRef(r), r]),
    );
    const indexable = docs.filter((d) => d.type !== "gotcha");
    const currentRefs = new Set(indexable.map(docRef));
    for (const [ref, r] of persisted)
      if (!currentRefs.has(ref)) this.store?.deleteDocEmbedding(r.type, r.name);

    const toEmbed: { doc: KnowledgeDoc; hash: string; text: string }[] = [];
    this.vecs = new Map();
    for (const d of indexable) {
      const text = docTextForEmbedding(d);
      const hash = textHash(text);
      const hit = persisted.get(docRef(d));
      if (hit && hit.hash === hash) this.vecs.set(docRef(d), hit.vec); // unchanged → reuse
      else toEmbed.push({ doc: d, hash, text });
    }
    if (toEmbed.length) {
      const vecs = await this.embedder.embedDocs(toEmbed.map((t) => t.text));
      toEmbed.forEach((t, i) => {
        this.vecs.set(docRef(t.doc), vecs[i]);
        this.store?.putDocEmbedding(t.doc.type, t.doc.name, MODEL_ID, t.hash, vecs[i]);
      });
    }
    console.error(
      `[embeddings] index ready — ${this.vecs.size} docs, dim ${this.embedder.dim} ` +
        `(${this.vecs.size - toEmbed.length} reused, ${toEmbed.length} embedded)`,
    );
  }

  /** Re-embed one doc after a curator upsert (gotchas are not indexed). */
  async upsert(doc: KnowledgeDoc): Promise<void> {
    if (!this.embedder || doc.type === "gotcha") return;
    try {
      const text = docTextForEmbedding(doc);
      const [v] = await this.embedder.embedDocs([text]);
      if (v) {
        this.vecs.set(docRef(doc), v);
        this.store?.putDocEmbedding(doc.type, doc.name, MODEL_ID, textHash(text), v);
      }
    } catch (e) {
      console.error(`[embeddings] upsert embed failed for ${doc.name}: ${(e as Error).message}`);
    }
  }

  /** Drop a doc's vector (in-memory + persisted) when it's deleted. */
  remove(doc: { type: string; name: string }): void {
    this.vecs.delete(docRef(doc));
    this.store?.deleteDocEmbedding(doc.type as KnowledgeDoc["type"], doc.name);
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
