// SPDX-License-Identifier: Apache-2.0
/**
 * Per-tenant DERIVED synonym table (issue #33) — the domain-specific half of the
 * two-tier query expansion described in synonyms.ts.
 *
 * The synonym MECHANISM is a measured retrieval win (a lexical bridge that fires
 * only on a keyword miss, discounted, complementary to embeddings). What we
 * retired was the hand-curated, sports/e-commerce-specific GLOBAL thesaurus as
 * the *source*. Here the neighbor table is instead GENERATED OFFLINE by
 * clustering the tenant's OWN doc vocabulary with the local embedding model that
 * is already on the box:
 *
 *   tenant docs → salient vocabulary → embed each term (local model) →
 *   for each term keep its nearest neighbors above a cosine floor → neighbor table
 *
 * So every domain gets a lexical bridge over its OWN words (clinician↔physician,
 * sku↔product) with nobody hand-editing synonyms.ts.
 *
 * I8: the embedding runs on the box, in-process, in the BACKGROUND at build time
 * — never on the request path. The request path only does a `Map` lookup, exactly
 * like the base table. Building is opt-in on the embedder loading at all; if it
 * doesn't (embeddings off / model failed) this stays inert and callers fall back
 * to the base table (graceful degradation).
 */
import { cosine, getEmbedder, type Embedder } from "./embeddings";
import { STOP, tokenize, type ScorableDoc } from "./search";

/** An embed function over a batch of terms (the doc-side of an Embedder). */
export type EmbedFn = (terms: string[]) => Promise<number[][]>;

export interface DerivedOpts {
  /** Cosine floor for two terms to be considered neighbors (default 0.62). */
  minSim?: number;
  /** Max neighbors kept per term (default 6). */
  maxNeighbors?: number;
  /** Min length for a vocabulary term (default 4) — short tokens are noisy. */
  minTermLength?: number;
  /** Min corpus frequency for a term to enter the vocabulary (default 2). */
  minFrequency?: number;
  /** Cap on vocabulary size (most frequent first) to bound embedding cost
   *  (default 500). */
  maxVocab?: number;
}

/**
 * The salient vocabulary of a doc set: distinct content tokens that are long
 * enough, not stopwords, and occur often enough to be worth clustering — capped
 * to the most frequent `maxVocab` so the offline embed pass stays bounded on a
 * large corpus. Deterministic (frequency then alphabetical) so a rebuild over the
 * same corpus yields the same table.
 */
export function docVocabulary(docs: ScorableDoc[], opts: DerivedOpts = {}): string[] {
  const minLen = opts.minTermLength ?? 4;
  const minFreq = opts.minFrequency ?? 2;
  const maxVocab = opts.maxVocab ?? 500;
  const freq = new Map<string, number>();
  for (const d of docs) {
    const kw = Array.isArray(d.meta.keywords)
      ? d.meta.keywords.join(" ")
      : String(d.meta.keywords ?? "");
    const text = `${d.name} ${d.meta.summary ?? ""} ${kw} ${d.body}`;
    for (const t of tokenize(text)) {
      if (t.length < minLen || STOP.has(t) || /^\d+$/.test(t)) continue;
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= minFreq)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxVocab)
    .map(([t]) => t);
}

/**
 * Cluster a vocabulary into a neighbor table by cosine similarity of the local
 * embeddings. Pure over its inputs (the embed function is injected), so it is
 * unit-tested without the native model. Each term maps to its top `maxNeighbors`
 * neighbors above `minSim`, strongest first. Terms with no neighbor are omitted.
 */
export async function buildNeighborTable(
  vocab: string[],
  embed: EmbedFn,
  opts: DerivedOpts = {},
): Promise<Map<string, string[]>> {
  const minSim = opts.minSim ?? 0.62;
  const maxNeighbors = opts.maxNeighbors ?? 6;
  const table = new Map<string, string[]>();
  if (vocab.length < 2) return table;
  const vecs = await embed(vocab);
  for (let i = 0; i < vocab.length; i++) {
    const scored: { term: string; sim: number }[] = [];
    for (let j = 0; j < vocab.length; j++) {
      if (i === j || !vecs[i] || !vecs[j]) continue;
      const sim = cosine(vecs[i], vecs[j]);
      if (sim >= minSim) scored.push({ term: vocab[j], sim });
    }
    if (!scored.length) continue;
    scored.sort((a, b) => b.sim - a.sim);
    table.set(
      vocab[i],
      scored.slice(0, maxNeighbors).map((s) => s.term),
    );
  }
  return table;
}

/**
 * Lifecycle wrapper mirroring EmbedIndex: created inert, built in the background
 * from the seeded store, and queried on the request path as a pure `Map` lookup.
 * Inert (empty table, `neighbors` → []) until a build with a live embedder
 * completes — so a gateway with embeddings off transparently uses only the base
 * table.
 */
export class DerivedSynonyms {
  private table = new Map<string, string[]>();
  /** True once a build with a live embedder has populated the table. */
  enabled = false;

  static create(): DerivedSynonyms {
    return new DerivedSynonyms();
  }

  /**
   * Kick off the offline build in the background (non-blocking). `getDocs` is
   * read at build time so it sees the seeded store. `embedder` is injectable for
   * tests; production passes none and the process-wide local model is used.
   */
  start(
    getDocs: () => ScorableDoc[],
    opts: DerivedOpts & { embedder?: Embedder | null } = {},
  ): void {
    void (async () => {
      const e = opts.embedder !== undefined ? opts.embedder : await getEmbedder();
      if (!e) return; // embeddings off / model failed → stays inert, base table only
      await this.rebuild(getDocs(), (terms) => e.embedDocs(terms), opts);
      this.enabled = true;
    })().catch((err) =>
      console.error(
        `[derived-synonyms] build failed (base table stays live): ${(err as Error).message}`,
      ),
    );
  }

  /** Rebuild the table from the current docs. */
  async rebuild(docs: ScorableDoc[], embed: EmbedFn, opts: DerivedOpts = {}): Promise<void> {
    const vocab = docVocabulary(docs, opts);
    this.table = await buildNeighborTable(vocab, embed, opts);
    console.error(
      `[derived-synonyms] table ready — ${this.table.size} terms from ${vocab.length} vocabulary`,
    );
  }

  /** Derived neighbors of a token (empty if none / inert). The SynonymLookup seam. */
  neighbors = (token: string): string[] => this.table.get(token) ?? [];
}
