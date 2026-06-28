// SPDX-License-Identifier: Apache-2.0
/**
 * Setoku VALUE eval (gotcha-trap coverage) on the Bulldogs demo.
 *
 *   bun run eval:value            # scorecard
 *   bun run eval:value --gate     # exit 1 if below the spec's minTrapCoverage
 *
 * Each trap question is one where the naive (schema-only) answer is wrong; the
 * fix is a curated fact. This measures the NECESSARY condition for Setoku to add
 * value: does the trap-avoiding fact reach what find_context surfaces? It's
 * deterministic + model-free (I8) — the full answer-lift (does the agent's ANSWER
 * change?) is the in-session protocol in plugin/skills/eval/SKILL.md.
 *
 * "Ungrounded" = no curated store, so coverage is 0 by construction; the grounded
 * rate IS the grounded-vs-ungrounded lift. We also show baseline vs map-first.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore, seedFromFiles } from "../../plugin/gateway/lib/store";
import { trapCoverage, type TrapCase } from "../../plugin/gateway/lib/quality";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const DEMO = path.join(ROOT, "demo", "bulldogs");
const SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "value-traps.json"), "utf8"),
) as { k?: number; traps: TrapCase[]; gate?: { minTrapCoverage?: number } };

const gate = process.argv.includes("--gate");
const k = SPEC.k ?? 5;

// seed a throwaway store from the demo corpus = the "grounded" knowledge
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "setoku-value-")), "k.db");
const store = new KnowledgeStore(dbPath);
const n = seedFromFiles(store, DEMO);
const docs = store.listDocs();
store.db.close();

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const baseline = trapCoverage(docs, SPEC.traps, k);
const mapFirst = trapCoverage(docs, SPEC.traps, k, { expandLinks: true });
// ungrounded = no curated docs at all → 0 by construction
const ungrounded = trapCoverage([], SPEC.traps, k);

console.log(`# Setoku value scorecard — gotcha traps (Bulldogs demo, ${n} docs)\n`);
console.log(`Does the trap-avoiding fact reach the agent's context? (k=${k}, ${SPEC.traps.length} traps)\n`);
console.log(`| retrieval | trap coverage |`);
console.log(`| --- | --- |`);
console.log(`| ungrounded (no Setoku) | ${pct(ungrounded.coverageRate)} (${ungrounded.covered}/${ungrounded.cases}) |`);
console.log(`| grounded, baseline | ${pct(baseline.coverageRate)} (${baseline.covered}/${baseline.cases}) |`);
console.log(`| grounded, map-first | ${pct(mapFirst.coverageRate)} (${mapFirst.covered}/${mapFirst.cases}) |`);
console.log(`\n**grounded-vs-ungrounded lift: +${pct(mapFirst.coverageRate - ungrounded.coverageRate)}**\n`);

// context cost — coverage bought by flooding the window with gotchas is not a win
console.log(
  `context cost (map-first): ${mapFirst.avgDocsSurfaced.toFixed(1)} docs + ${mapFirst.avgGotchasSurfaced.toFixed(1)} gotchas surfaced per trap (of ${n} docs total)`,
);
const floody = mapFirst.perCase.filter((c) => c.gotchasSurfaced >= 8);
if (floody.length)
  console.log(
    `  ⚠ ${floody.length} trap(s) flood ≥8 gotchas into context — find_context caps neither; consider ranking gotchas and taking top-N.`,
  );
console.log("");

const uncovered = mapFirst.perCase.filter((c) => !c.covered);
if (uncovered.length) {
  console.log(`## Uncovered traps (the fix exists but isn't reachable — punch-list)`);
  for (const c of uncovered)
    console.log(`- "${c.question}"\n    missing from context: ${c.missing.join(", ")}`);
  console.log("");
}

const min = SPEC.gate?.minTrapCoverage;
if (gate && min != null) {
  if (mapFirst.coverageRate < min) {
    console.log(`❌ gate FAILED: trap coverage ${pct(mapFirst.coverageRate)} < ${pct(min)}`);
    process.exit(1);
  }
  console.log(`✅ gate passed (≥ ${pct(min)})`);
}
