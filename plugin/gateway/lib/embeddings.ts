// SPDX-License-Identifier: Apache-2.0
/**
 * Local, CPU-only embedding model — the I8 opt-in upgrade (default OFF).
 *
 * I8 forbids EXTERNAL inference; a bundled local model that runs in-process on the
 * box is the sanctioned upgrade (see docs/invariants.md). This module is the only
 * place the gateway touches an embedding model, and it is:
 *   • opt-in   — does nothing unless SETOKU_EMBEDDINGS=1
 *   • lazy     — `fastembed`/onnxruntime are dynamically imported, so a gateway
 *                with embeddings off never loads the native runtime at all
 *   • graceful — any init failure (missing native, OOM, download fail) returns
 *                null; callers fall back to keyword retrieval and keep serving
 *
 * Model: BGE-small-en-v1.5 (~130MB, 384-dim) — CPU, ~120ms/query. Asymmetric:
 * docs via embed(), queries via queryEmbed() (the BGE retrieval instruction).
 */

export interface Embedder {
  dim: number;
  embedDocs(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/** Embeddings are an explicit opt-in (default off) so existing deploys are inert. */
export function embeddingsEnabled(): boolean {
  return process.env.SETOKU_EMBEDDINGS === "1";
}

let cached: Promise<Embedder | null> | null = null;

/** The process-wide embedder, or null if disabled/unavailable. Memoized. */
export function getEmbedder(): Promise<Embedder | null> {
  if (!embeddingsEnabled()) return Promise.resolve(null);
  if (!cached) cached = init();
  return cached;
}

async function init(): Promise<Embedder | null> {
  try {
    // dynamic import: the native onnxruntime is never loaded when embeddings off
    const { FlagEmbedding, EmbeddingModel } = await import("fastembed");
    const cacheDir = process.env.SETOKU_EMBED_CACHE || undefined;
    const model = await FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15,
      ...(cacheDir ? { cacheDir } : {}),
    });
    const warm = await model.queryEmbed("warmup");
    const dim = (warm as ArrayLike<number>).length;
    console.error(`[embeddings] enabled — bge-small-en-v1.5, dim ${dim}`);
    return {
      dim,
      async embedDocs(texts) {
        const out: number[][] = [];
        for await (const batch of model.embed(texts, 64))
          for (const v of batch) out.push(Array.from(v as ArrayLike<number>));
        return out;
      },
      async embedQuery(text) {
        return Array.from((await model.queryEmbed(text)) as ArrayLike<number>);
      },
    };
  } catch (e) {
    console.error(
      `[embeddings] DISABLED — model init failed, falling back to keyword retrieval: ${(e as Error).message}`,
    );
    return null;
  }
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
