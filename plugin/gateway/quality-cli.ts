// SPDX-License-Identifier: Apache-2.0
/**
 * Fact-database quality scorecard runner (issue #10).
 *
 * Deterministic, model-free, zero-API-cost: it scores the structural quality of
 * a knowledge store against a frozen eval spec and prints a scorecard. Runs in
 * CI for free (no key, I8) and can gate the regression direction with --gate.
 *
 *   bun plugin/gateway/quality-cli.ts --spec <spec.json> [--db <knowledge.db>] [--json] [--gate]
 *
 * Docs come from --db (a real KnowledgeStore) if given, else from inline `docs`
 * in the spec (self-contained runs / fixtures). The fuzzy dimensions
 * (contradiction detection, auto-judgement) are scored from labels/planted
 * ground truth supplied in the spec — the detector that PRODUCED those labels
 * may be an in-session LLM (run on Max), but the scoring here stays free.
 */
import fs from "node:fs";
import { findOrphans, suggestConnections } from "./lib/facts";
import { KnowledgeStore, type KnowledgeDoc } from "./lib/store";
import {
  defectMetrics,
  judgementMetrics,
  knowledgeStats,
  redundancyReport,
  retrievalMetrics,
  type JudgementRow,
  type RetrievalCase,
} from "./lib/quality";
import { buildLinkGraph, type ScorableDoc } from "./lib/search";

interface QualitySpec {
  /** Inline docs for self-contained runs; ignored when --db is supplied. */
  docs?: ScorableDoc[];
  k?: number;
  redundancyThreshold?: number;
  retrieval?: RetrievalCase[];
  judgement?: JudgementRow[];
  /**
   * Planted-defect ground truth for the compaction pass. `found` is the
   * detector output; if omitted, duplicate keys ("dup:A|B") are auto-derived
   * from the deterministic redundancy report (the detector IS model-free there).
   */
  defects?: { planted: string[]; found?: string[] };
  /** Cap on linked neighbors added per case in the expanded ("map-first") run. */
  maxLinked?: number;
  /** Optional CI gate thresholds (checked only with --gate). */
  gate?: {
    minHitRate?: number;
    minRecallAtK?: number;
    /** Floor on recall@k for the map-first (link-expanded) retrieval. */
    minRecallAtKExpanded?: number;
    /** Floor on precision@k for map-first — guards against flooding the result
     *  with low-value linked neighbors (recall must not be bought too cheaply). */
    minPrecisionAtKExpanded?: number;
    maxFalseAcceptRate?: number;
    minDefectRecall?: number;
    /** Ceiling on declared links that resolve to no doc. */
    maxBrokenLinks?: number;
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function dupKey(a: string, b: string): string {
  return `dup:${[a, b].sort().join("|")}`;
}

function connKey(a: string, b: string): string {
  return `connection:${[a, b].sort().join("|")}`;
}

function parseArgs(argv: string[]) {
  const out: { spec?: string; db?: string; json: boolean; gate: boolean } = {
    json: false,
    gate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") out.spec = argv[++i];
    else if (a === "--db") out.db = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--gate") out.gate = true;
  }
  return out;
}

export function runQuality(spec: QualitySpec, docs: ScorableDoc[]) {
  const k = spec.k ?? 5;
  const threshold = spec.redundancyThreshold ?? 0.6;

  const redundant = redundancyReport(docs, threshold);
  const stats = knowledgeStats(docs, threshold, redundant.length);

  // Wiki structure: the link graph + its two structural lint signals. All
  // model-free (I8). `docs` may be ScorableDoc (inline spec) or KnowledgeDoc
  // (--db) — both carry type/name/meta, which is all the detectors read.
  const graph = buildLinkGraph(docs);
  const kdocs = docs as KnowledgeDoc[];
  const orphans = findOrphans(kdocs, graph);
  const connections = suggestConnections(kdocs, graph);
  const linkCount = [...graph.out.values()].reduce((n, s) => n + s.size, 0);
  const link = {
    links: linkCount,
    orphans: orphans.map((o) => o.ref),
    connections: connections.map((c) => ({ a: c.a, b: c.b, similarity: c.similarity })),
    broken: graph.unresolved,
  };

  // Retrieval, scored two ways from the SAME keyword ranker: baseline (top-k)
  // and map-first (top-k + 1-hop link neighbors). The A/B is the guardrail —
  // link-expansion must lift recall without dropping the baseline's precision.
  const retrieval = spec.retrieval?.length
    ? retrievalMetrics(docs, spec.retrieval, k)
    : null;
  const retrievalExpanded = spec.retrieval?.length
    ? retrievalMetrics(docs, spec.retrieval, k, {
        expandLinks: true,
        maxLinked: spec.maxLinked ?? k,
        graph,
      })
    : null;

  const judgement = spec.judgement?.length
    ? judgementMetrics(spec.judgement)
    : null;

  let defects = null;
  // Detectors are auto-derived from the model-free passes: duplicates
  // (redundancy), orphans + missing connections (link graph), broken links.
  // So orphan:/connection:/broken:/dup: planted keys are all gradable here with
  // no supplied `found`. Any OTHER planted kind (e.g. contradiction:) needs an
  // explicit detector output and is reported unscored.
  let defectsUnscored: string[] = [];
  if (spec.defects?.planted?.length) {
    if (spec.defects.found) {
      defects = defectMetrics(spec.defects.found, spec.defects.planted);
    } else {
      const derived = [
        ...redundant.map((p) => dupKey(p.a, p.b)),
        ...orphans.map((o) => `orphan:${o.ref}`),
        ...connections.map((c) => connKey(c.a, c.b)),
        ...graph.unresolved.map((u) => `broken:${u.from}|${u.ref}`),
      ];
      const gradable = (key: string) =>
        ["dup:", "orphan:", "connection:", "broken:"].some((p) => key.startsWith(p));
      const planted = spec.defects.planted.filter(gradable);
      defectsUnscored = spec.defects.planted.filter((key) => !gradable(key));
      defects = defectMetrics(derived, planted);
    }
  }

  return {
    stats,
    link,
    retrieval,
    retrievalExpanded,
    redundant,
    judgement,
    defects,
    defectsUnscored,
    k,
    threshold,
  };
}

type QualityResult = ReturnType<typeof runQuality>;

function renderScorecard(r: QualityResult): string {
  const lines: string[] = [];
  lines.push("# Fact-database quality scorecard\n");

  lines.push("## Store");
  lines.push(`- docs: **${r.stats.docs}** (${
    Object.entries(r.stats.byType)
      .map(([t, n]) => `${t}:${n}`)
      .join(", ") || "—"
  })`);
  lines.push(`- tokens: **${r.stats.totalTokens}** (avg ${r.stats.avgTokensPerDoc.toFixed(1)}/doc)`);
  lines.push(`- near-duplicate pairs (≥${r.threshold}): **${r.stats.redundantPairs}**`);
  lines.push(
    `- links: **${r.link.links}** · orphans: **${r.link.orphans.length}** · suggested connections: **${r.link.connections.length}** · broken links: **${r.link.broken.length}**`,
  );
  if (r.link.orphans.length) lines.push(`  - orphaned: ${r.link.orphans.join(", ")}`);
  if (r.link.broken.length)
    lines.push(`  - broken: ${r.link.broken.map((b) => `${b.from}→${b.ref}`).join(", ")}`);
  lines.push("");

  if (r.retrieval) {
    const m = r.retrieval;
    const e = r.retrievalExpanded;
    const delta = (a: number, b: number) => {
      const d = b - a;
      return d === 0 ? "±0" : `${d > 0 ? "+" : ""}${pct(d)}`;
    };
    lines.push(`## Retrieval (k=${m.k}, ${m.cases} cases)`);
    lines.push(`map-first = keyword top-k + 1-hop link neighbors of those hits.\n`);
    lines.push(`| metric | baseline | map-first | Δ |`);
    lines.push(`| --- | --- | --- | --- |`);
    lines.push(`| hit rate | ${pct(m.hitRate)} | ${e ? pct(e.hitRate) : "—"} | ${e ? delta(m.hitRate, e.hitRate) : ""} |`);
    lines.push(`| recall@${m.k} | ${pct(m.recallAtK)} | ${e ? pct(e.recallAtK) : "—"} | ${e ? delta(m.recallAtK, e.recallAtK) : ""} |`);
    lines.push(`| precision@${m.k} | ${pct(m.precisionAtK)} | ${e ? pct(e.precisionAtK) : "—"} | ${e ? delta(m.precisionAtK, e.precisionAtK) : ""} |`);
    lines.push(`| MRR | ${m.mrr.toFixed(3)} | ${e ? e.mrr.toFixed(3) : "—"} | |`);
    const misses = m.perCase.filter((c) => !c.hit);
    if (misses.length) {
      lines.push(`\nRetrieval misses (no relevant doc in top-${m.k}):`);
      for (const c of misses)
        lines.push(`- "${c.question}" — expected ${c.relevant.join(", ")}`);
    }
    lines.push("");
  }

  if (r.redundant.length) {
    lines.push("## Redundancy (merge candidates)");
    for (const p of r.redundant.slice(0, 10))
      lines.push(`- ${p.a} ↔ ${p.b} (${pct(p.similarity)})`);
    lines.push("");
  }

  if (r.judgement) {
    const j = r.judgement;
    lines.push(`## Auto-judgement (${j.total} decisions)`);
    lines.push(`| metric | value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| accuracy | ${pct(j.accuracy)} |`);
    lines.push(`| accept precision | ${pct(j.precision)} |`);
    lines.push(`| accept recall | ${pct(j.recall)} |`);
    lines.push(`| **false-accept rate** (I9) | **${pct(j.falseAcceptRate)}** |`);
    lines.push(`\nconfusion: TP ${j.truePositives} · FP ${j.falsePositives} · TN ${j.trueNegatives} · FN ${j.falseNegatives}\n`);
  }

  if (r.defects) {
    const d = r.defects;
    lines.push("## Defect detection (compaction / planted ground truth)");
    lines.push(`| metric | value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| recall | ${pct(d.recall)} (${d.truePositives}/${d.planted}) |`);
    lines.push(`| precision | ${pct(d.precision)} |`);
    lines.push(`| F1 | ${d.f1.toFixed(3)} |`);
    if (d.missed.length) lines.push(`\nmissed: ${d.missed.join(", ")}`);
    if (d.spurious.length) lines.push(`spurious: ${d.spurious.join(", ")}`);
    if (r.defectsUnscored.length)
      lines.push(
        `unscored (no detector output supplied — pass defects.found): ${r.defectsUnscored.join(", ")}`,
      );
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Returns [] when no gate configured or all pass; otherwise the list of
 * failures. A threshold that references a dimension absent from the run is
 * itself a failure (e.g. minHitRate set but no retrieval cases ran) — silently
 * skipping it would let a misconfigured spec report a passing gate in CI.
 */
export function checkGate(spec: QualitySpec, r: QualityResult): string[] {
  const g = spec.gate;
  if (!g) return [];
  const fails: string[] = [];
  if (g.minHitRate != null) {
    if (!r.retrieval) fails.push("minHitRate set but no retrieval cases ran");
    else if (r.retrieval.hitRate < g.minHitRate)
      fails.push(`hit rate ${pct(r.retrieval.hitRate)} < ${pct(g.minHitRate)}`);
  }
  if (g.minRecallAtK != null) {
    if (!r.retrieval) fails.push("minRecallAtK set but no retrieval cases ran");
    else if (r.retrieval.recallAtK < g.minRecallAtK)
      fails.push(`recall@k ${pct(r.retrieval.recallAtK)} < ${pct(g.minRecallAtK)}`);
  }
  if (g.minRecallAtKExpanded != null) {
    if (!r.retrievalExpanded)
      fails.push("minRecallAtKExpanded set but no retrieval cases ran");
    else if (r.retrievalExpanded.recallAtK < g.minRecallAtKExpanded)
      fails.push(
        `map-first recall@k ${pct(r.retrievalExpanded.recallAtK)} < ${pct(g.minRecallAtKExpanded)}`,
      );
  }
  if (g.minPrecisionAtKExpanded != null) {
    if (!r.retrievalExpanded)
      fails.push("minPrecisionAtKExpanded set but no retrieval cases ran");
    else if (r.retrievalExpanded.precisionAtK < g.minPrecisionAtKExpanded)
      fails.push(
        `map-first precision@k ${pct(r.retrievalExpanded.precisionAtK)} < ${pct(g.minPrecisionAtKExpanded)}`,
      );
  }
  if (g.maxBrokenLinks != null && r.link.broken.length > g.maxBrokenLinks)
    fails.push(`broken links ${r.link.broken.length} > ${g.maxBrokenLinks}`);
  if (g.maxFalseAcceptRate != null) {
    if (!r.judgement)
      fails.push("maxFalseAcceptRate set but no judgement decisions ran");
    else if (r.judgement.falseAcceptRate > g.maxFalseAcceptRate)
      fails.push(`false-accept rate ${pct(r.judgement.falseAcceptRate)} > ${pct(g.maxFalseAcceptRate)}`);
  }
  if (g.minDefectRecall != null) {
    if (!r.defects) fails.push("minDefectRecall set but no defects scored");
    else if (r.defects.recall < g.minDefectRecall)
      fails.push(`defect recall ${pct(r.defects.recall)} < ${pct(g.minDefectRecall)}`);
  }
  return fails;
}

function main() {
  const args = parseArgs(Bun.argv.slice(2));
  if (!args.spec) {
    console.error(
      "usage: bun plugin/gateway/quality-cli.ts --spec <spec.json> [--db <knowledge.db>] [--json] [--gate]",
    );
    process.exit(2);
  }

  let spec: QualitySpec;
  try {
    spec = JSON.parse(fs.readFileSync(args.spec, "utf8"));
  } catch (e) {
    console.error(`could not read/parse spec ${args.spec}: ${(e as Error).message}`);
    process.exit(2);
  }

  // Constructing a KnowledgeStore creates the db file + dirs, so a typo'd --db
  // would silently leave an empty store behind. Require the path to exist.
  if (args.db && !fs.existsSync(args.db)) {
    console.error(`--db not found: ${args.db}`);
    process.exit(2);
  }
  const docs: ScorableDoc[] = args.db
    ? new KnowledgeStore(args.db).listDocs()
    : (spec.docs ?? []);

  if (!docs.length) {
    console.error(
      "no docs to score: pass --db <knowledge.db> or include `docs` in the spec.",
    );
    process.exit(2);
  }

  const result = runQuality(spec, docs);
  const fails = args.gate ? checkGate(spec, result) : [];

  if (args.json) {
    console.log(JSON.stringify({ ...result, gateFailures: fails }, null, 2));
  } else {
    console.log(renderScorecard(result));
    if (args.gate) {
      console.log(
        fails.length
          ? `\n❌ gate FAILED:\n- ${fails.join("\n- ")}`
          : "\n✅ gate passed",
      );
    }
  }
  process.exit(args.gate && fails.length ? 1 : 0);
}

if (import.meta.main) main();
