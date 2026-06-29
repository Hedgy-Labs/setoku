// SPDX-License-Identifier: Apache-2.0
/**
 * Retrieval HILLCLIMB test on the Bulldogs demo.
 *
 *   bun run eval:retrieval
 *
 * Paraphrased questions (synonyms/rewordings NOT in the docs' wording) → the docs
 * that truly answer them, scored by recall@k / MRR — objective, model-free, no
 * self-grading. Designed to FAIL: keyword retrieval has no synonym/IDF handling,
 * so this set does not saturate at 100% — that headroom is the point. Tune on the
 * `dev` split; the held-out `test` split is the honest number (improvements must
 * generalize, not memorize phrasings).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore, seedFromFiles } from "../../plugin/gateway/lib/store";
import { retrievalMetrics, type RetrievalCase } from "../../plugin/gateway/lib/quality";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "paraphrases.json"), "utf8"),
) as { k?: number; dev: RetrievalCase[]; test: RetrievalCase[] };
const k = SPEC.k ?? 5;

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "setoku-retr-")), "k.db");
const store = new KnowledgeStore(dbPath);
seedFromFiles(store, path.join(ROOT, "demo", "bulldogs"));
const docs = store.listDocs();
store.db.close();

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
function row(label: string, cases: RetrievalCase[]) {
  const b = retrievalMetrics(docs, cases, k);
  const m = retrievalMetrics(docs, cases, k, { expandLinks: true });
  const syn = retrievalMetrics(docs, cases, k, { expandLinks: true, expandSynonyms: true });
  console.log(
    `| ${label} (${cases.length}) | ${pct(b.recallAtK)} | ${pct(m.recallAtK)} | ${pct(syn.recallAtK)} | ${pct(syn.hitRate)} | ${syn.mrr.toFixed(2)} |`,
  );
  return syn;
}

console.log(`# Retrieval hillclimb — paraphrase recall (Bulldogs demo, k=${k})\n`);
console.log(`recall@k progression: baseline keyword → +map-first → +synonyms (I8-clean expansion)\n`);
console.log(`| split | base | +map-first | +synonyms | hit | MRR |`);
console.log(`| --- | --- | --- | --- | --- | --- |`);
const dev = row("dev", SPEC.dev);
const test = row("test (held-out)", SPEC.test);

const misses = test.perCase.filter((c) => !c.hit);
if (misses.length) {
  console.log(`\n## Held-out misses — the gap to climb`);
  for (const c of misses)
    console.log(`- ✗ "${c.question}" → wanted ${c.relevant.join("/")}; got [${c.retrieved.join(", ") || "nothing"}]`);
}
console.log(
  `\nHeadroom on held-out test: ${pct(1 - test.recallAtK)} of recall@${k} still to win (synonym/IDF gap — keyword-only retrieval can't bridge it).`,
);
