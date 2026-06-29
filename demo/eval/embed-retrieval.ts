// SPDX-License-Identifier: Apache-2.0
/**
 * Hybrid-retrieval benchmark on the Bulldogs demo — exercises the REAL production
 * path (EmbedIndex + retrieve with embedScores), so the number is what ships.
 *
 *   SETOKU_EMBEDDINGS=1 bun demo/eval/embed-retrieval.ts
 *
 * The embedding model runs LOCALLY and offline here (same as on the box). Compares
 * recall@k on dev / held-out test: keyword · +synonyms · +map-first · +hybrid.
 */
process.env.SETOKU_EMBEDDINGS = "1";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore, seedFromFiles } from "../../plugin/gateway/lib/store";
import { retrieve } from "../../plugin/gateway/lib/search";
import { synonymsOf } from "../../plugin/gateway/lib/synonyms";
import { EmbedIndex } from "../../plugin/gateway/lib/embed-index";
import { retrievalMetrics, type RetrievalCase } from "../../plugin/gateway/lib/quality";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const SPEC = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "paraphrases.json"), "utf8")) as {
  k?: number; dev: RetrievalCase[]; test: RetrievalCase[];
};
const k = SPEC.k ?? 5;

const store = new KnowledgeStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "emb-")), "k.db"));
seedFromFiles(store, path.join(ROOT, "demo", "bulldogs"));
const docs = store.listDocs();
store.db.close();

const idx = EmbedIndex.create();
idx.start(() => docs);
// wait for the background build to finish (the gateway doesn't wait; the eval does)
for (let i = 0; i < 120 && !idx.enabled; i++) await new Promise((r) => setTimeout(r, 250));
if (!idx.enabled) {
  console.error("embed index never became ready (model load failed?) — aborting");
  process.exit(1);
}

async function hybridRecall(cases: RetrievalCase[]): Promise<number> {
  let sum = 0;
  for (const c of cases) {
    const embedScores = (await idx.scores(c.question)) ?? undefined;
    const top = retrieve(docs, c.question, {
      k, expandLinks: true, maxLinked: k, synonyms: synonymsOf, embedScores,
    }).map((r) => r.doc.name).slice(0, k);
    const rel = new Set(c.relevant);
    sum += top.filter((n) => rel.has(n)).length / Math.max(1, rel.size);
  }
  return sum / Math.max(1, cases.length);
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
console.log(`# Hybrid retrieval recall@${k} — production path (Bulldogs demo, local bge-small)\n`);
console.log(`| split | keyword | +synonyms | +map-first | +hybrid (emb) |`);
console.log(`| --- | --- | --- | --- | --- |`);
for (const [label, cases] of [["dev", SPEC.dev], ["test (held-out)", SPEC.test]] as [string, RetrievalCase[]][]) {
  const base = retrievalMetrics(docs, cases, k).recallAtK;
  const syn = retrievalMetrics(docs, cases, k, { expandSynonyms: true }).recallAtK;
  const mf = retrievalMetrics(docs, cases, k, { expandLinks: true, expandSynonyms: true }).recallAtK;
  const hy = await hybridRecall(cases);
  console.log(`| ${label} (${cases.length}) | ${pct(base)} | ${pct(syn)} | ${pct(mf)} | ${pct(hy)} |`);
}
