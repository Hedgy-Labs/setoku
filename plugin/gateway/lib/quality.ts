// SPDX-License-Identifier: Apache-2.0
/**
 * Structured quality metrics for the fact database (issue #10).
 *
 * The curated knowledge store is a pipeline:
 *
 *   proposals/corrections → curated facts → retrieval (find_context) → answer
 *
 * The existing `/setoku:eval` skill scores the LAST box (end-to-end answer
 * accuracy via golden questions). This module scores the INTERMEDIATE layers so
 * a restructuring of the store can be credited (or caught regressing) before it
 * reaches an answer. Every metric here is DETERMINISTIC — pure token/set math
 * over data you already have, reusing the real retrieval scorer (search.ts).
 * No model, no network, no embeddings → it runs for free in CI and needs no
 * API key (I8: no server-side inference).
 *
 * Two metrics need a model IN THE LOOP for the real world (is fact X
 * contradicting fact Y? did the auto-judge decide correctly?). This module does
 * not call one — it SCORES a detector's output against planted/labeled ground
 * truth, so the scoring stays deterministic even when the detector is an LLM.
 *
 * The metrics are deliberately representation-agnostic: retrieval cases key on
 * natural-language questions and doc NAMES, never internal ids — so the golden
 * sets survive the very migration they measure (free-text docs → a more formal
 * fact structure).
 */
import {
  buildLinkGraph,
  jaccard,
  retrieve,
  scoreDocs,
  selectGotchas,
  tokenize,
  type LinkGraph,
  type ScorableDoc,
} from "./search";
import { synonymsOf } from "./synonyms";

/* --------------------------------- types --------------------------------- */

/** One labeled retrieval expectation: a question and the doc names that should answer it. */
export interface RetrievalCase {
  question: string;
  /** Doc names that are relevant. A name absent from the store counts as a coverage gap. */
  relevant: string[];
}

export interface RetrievalMetrics {
  k: number;
  cases: number;
  /** Macro-averaged over cases. */
  precisionAtK: number;
  recallAtK: number;
  /** Mean reciprocal rank of the first relevant doc. */
  mrr: number;
  /** Fraction of cases with at least one relevant doc in the top-k. */
  hitRate: number;
  /** Whether link-expansion ("map-first") was applied to the returned set. */
  expandedLinks: boolean;
  /** Per-case detail, in input order. */
  perCase: {
    question: string;
    relevant: string[];
    retrieved: string[];
    hit: boolean;
    firstRelevantRank: number | null;
  }[];
}

export interface RetrievalOpts {
  /** Append 1-hop link-graph neighbors of the direct top-k to the returned set. */
  expandLinks?: boolean;
  /** Cap on linked neighbors added per case (default = k). */
  maxLinked?: number;
  /** Precomputed graph (built from `docs` if omitted). */
  graph?: LinkGraph;
  /** I8-clean semantic query expansion via the static synonym table. */
  expandSynonyms?: boolean;
}

/** A pair of docs that look like near-duplicates (candidates for "merge repetitive facts"). */
export interface RedundantPair {
  a: string;
  b: string;
  /** Jaccard token overlap in [0,1]. */
  similarity: number;
}

/** One auto-judgement decision compared against the human-gold label. */
export interface JudgementRow {
  /** Stable id for the proposal (for reporting). */
  id?: string;
  gold: "accept" | "reject";
  predicted: "accept" | "reject";
}

export interface JudgementMetrics {
  total: number;
  /** accept = positive class. */
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  accuracy: number;
  /** Precision of "accept" decisions. */
  precision: number;
  recall: number;
  /**
   * Fraction of proposals that SHOULD be rejected but were accepted — FP/(FP+TN).
   * The load-bearing number for auto-judgement (I2/I9): a high false-accept rate
   * means an agent is waving bad knowledge past the human-click membrane.
   */
  falseAcceptRate: number;
}

/** Precision/recall of a defect detector (e.g. the compaction / "REM sleep" pass). */
export interface DefectMetrics {
  found: number;
  planted: number;
  truePositives: number;
  precision: number;
  recall: number;
  f1: number;
  /** Planted defects the detector missed (by key). */
  missed: string[];
  /** Things the detector flagged that were not planted (by key). */
  spurious: string[];
}

export interface KnowledgeStats {
  docs: number;
  byType: Record<string, number>;
  totalTokens: number;
  avgTokensPerDoc: number;
  /** Near-duplicate pairs at the default threshold — a redundancy proxy. */
  redundantPairs: number;
}

/* ------------------------------- retrieval ------------------------------- */

/**
 * Score retrieval quality against labeled cases, using the SAME scorer that
 * powers find_context (so the metric tracks production behavior exactly).
 */
export function retrievalMetrics<T extends ScorableDoc>(
  docs: T[],
  cases: RetrievalCase[],
  k = 5,
  opts: RetrievalOpts = {},
): RetrievalMetrics {
  const perCase: RetrievalMetrics["perCase"] = [];
  let precisionSum = 0;
  let recallSum = 0;
  let rrSum = 0;
  let hits = 0;
  // The eval scores the SAME retrieve() the gateway uses (one code path, so the
  // metric can't drift from production). `retrieve` returns the direct top-k plus
  // its capped link-graph neighbors; the full keyword ranking (for MRR /
  // firstRelevantRank) still comes from scoreDocs, whose direct order retrieve
  // preserves — so a recall gain can't come from reshuffling, only from surfacing
  // genuinely linked/expanded context.
  const graph = opts.expandLinks ? (opts.graph ?? buildLinkGraph(docs)) : undefined;
  const scoreOpts = opts.expandSynonyms ? { synonyms: synonymsOf } : {};
  for (const c of cases) {
    const ranked = scoreDocs(docs, c.question, scoreOpts).map((s) => s.doc.name);
    const topk = retrieve(docs, c.question, {
      k,
      expandLinks: opts.expandLinks,
      maxLinked: opts.maxLinked ?? k,
      graph,
      synonyms: opts.expandSynonyms ? synonymsOf : undefined,
    }).map((r) => r.doc.name);
    const relevant = new Set(c.relevant);
    const matched = topk.filter((n) => relevant.has(n));

    // precision among what was actually returned (scoreDocs returns only
    // docs with score > 0, so topk can be < k). Dividing by k instead would
    // cap precision below 100% on small curated stores — the common case
    // here — and misread as a retrieval problem. recall@k / MRR are the
    // headline metrics; precision is "of what I surfaced, how much was right".
    const precision = topk.length ? matched.length / topk.length : 0;
    const recall = relevant.size ? matched.length / relevant.size : 0;

    let firstRelevantRank: number | null = null;
    for (let i = 0; i < ranked.length; i++) {
      if (relevant.has(ranked[i])) {
        firstRelevantRank = i + 1;
        break;
      }
    }
    const rr =
      firstRelevantRank && firstRelevantRank <= k ? 1 / firstRelevantRank : 0;
    const hit = matched.length > 0;

    precisionSum += precision;
    recallSum += recall;
    rrSum += rr;
    if (hit) hits += 1;

    perCase.push({
      question: c.question,
      relevant: c.relevant,
      retrieved: topk,
      hit,
      firstRelevantRank,
    });
  }

  const n = Math.max(1, cases.length);
  return {
    k,
    cases: cases.length,
    precisionAtK: precisionSum / n,
    recallAtK: recallSum / n,
    mrr: rrSum / n,
    hitRate: hits / n,
    expandedLinks: !!graph,
    perCase,
  };
}

/* ---------------------------- gotcha-trap value -------------------------- */

/**
 * A "trap" question: one where the NAIVE answer is wrong, and only a curated
 * fact saves it (refunds excluded, cents→dollars, dedupe-by-email, …). This is
 * how we measure Setoku's *value*, not just its retrieval: does the trap-avoiding
 * fact actually reach the agent's context when the real question is asked?
 */
export interface TrapCase {
  question: string;
  /** What the naive (no-Setoku) answer gets wrong — for the report, not scoring. */
  trap: string;
  /** Distinctive substrings of the trap-avoiding fact; ALL must appear in the
   *  surfaced context for the trap to count as "covered" (case-insensitive). */
  signature: string[];
  /** Optional doc names that must be surfaced (in addition to the signature). */
  requires?: string[];
  /** Plain-language rubric for the in-session answer-lift check (not used here). */
  expect?: string;
}

export interface TrapMetrics {
  cases: number;
  covered: number;
  /** Fraction of traps whose fix reached the surfaced context. */
  coverageRate: number;
  expandedLinks: boolean;
  /** Context cost: mean docs + gotchas surfaced per trap. High coverage bought
   *  by flooding the context with gotchas is a precision/token problem, not a
   *  win — so the value scorecard reports the cost alongside the coverage. */
  avgDocsSurfaced: number;
  avgGotchasSurfaced: number;
  perCase: {
    question: string;
    covered: boolean;
    docsSurfaced: number;
    gotchasSurfaced: number;
    /** Signature terms / required docs that did NOT surface. */
    missing: string[];
  }[];
}

/**
 * Deterministic, model-free proxy for Setoku's value: for each trap question,
 * reproduce what `find_context` would surface (map-first `retrieve` over the
 * non-gotcha docs + `matchGotchas` token-overlap over the gotchas — exactly the
 * production split in app.ts) and check whether the trap-avoiding fact is in it.
 * It does NOT run the agent or grade an answer (that needs a model, I8 — see the
 * in-session answer-lift protocol in the eval skill); it measures the NECESSARY
 * condition: the fix is reachable. Ungrounded (no curated docs) is 0 by
 * construction, so the coverage rate IS the grounded-vs-ungrounded lift.
 */
export function trapCoverage<T extends ScorableDoc>(
  docs: T[],
  traps: TrapCase[],
  k = 5,
  opts: RetrievalOpts = {},
): TrapMetrics {
  const nonGotcha = docs.filter((d) => d.type !== "gotcha");
  const gotchaDocs = docs.filter((d) => d.type === "gotcha");
  const graph =
    opts.expandLinks ? (opts.graph ?? buildLinkGraph(nonGotcha)) : undefined;

  let covered = 0;
  const perCase = traps.map((t) => {
    // mirror find_context exactly: map-first retrieve over non-gotcha docs, then
    // capped/attached gotcha selection against the DIRECT hits.
    const retrieved = retrieve(nonGotcha, t.question, {
      k,
      expandLinks: opts.expandLinks,
      maxLinked: opts.maxLinked ?? k,
      graph,
      synonyms: synonymsOf, // mirror find_context (I8-clean expansion)
    });
    const direct = retrieved.filter((r) => r.via === "direct");
    const linked = retrieved.filter((r) => r.via === "linked");
    const selected = selectGotchas(gotchaDocs, direct.map((d) => d.doc), t.question);
    const surfacedNames = [
      ...retrieved.map((r) => r.doc.name),
      ...selected.map((g) => g.name),
    ];
    // the text the agent actually sees: direct docs in full, linked as one-liners
    // (name+summary), selected gotchas as their body.
    const surfacedText = [
      ...direct.map((r) => `${r.doc.name} ${r.doc.meta.summary ?? ""} ${r.doc.body}`),
      ...linked.map((r) => `${r.doc.name} ${r.doc.meta.summary ?? ""}`),
      ...selected.map((g) => g.body || g.name),
    ]
      .join(" ")
      .toLowerCase();

    const gotchasSurfaced = selected.length;
    const missing = [
      ...t.signature.filter((s) => !surfacedText.includes(s.toLowerCase())),
      ...(t.requires ?? []).filter((r) => !surfacedNames.includes(r)),
    ];
    const isCovered = missing.length === 0;
    if (isCovered) covered += 1;
    return {
      question: t.question,
      covered: isCovered,
      docsSurfaced: retrieved.length,
      gotchasSurfaced,
      missing,
    };
  });

  const sum = (f: (c: TrapMetrics["perCase"][number]) => number) =>
    perCase.reduce((n, c) => n + f(c), 0);
  const denom = Math.max(1, perCase.length);
  return {
    cases: traps.length,
    covered,
    coverageRate: traps.length ? covered / traps.length : 0,
    expandedLinks: !!graph,
    avgDocsSurfaced: sum((c) => c.docsSurfaced) / denom,
    avgGotchasSurfaced: sum((c) => c.gotchasSurfaced) / denom,
    perCase,
  };
}

/* ------------------------------- redundancy ------------------------------ */

/** Combined searchable text of a doc (name + keywords + summary + body). */
function docText(doc: ScorableDoc): string {
  const kw = Array.isArray(doc.meta.keywords)
    ? doc.meta.keywords.join(" ")
    : String(doc.meta.keywords ?? "");
  const summary = String(doc.meta.summary ?? "");
  return `${doc.name} ${kw} ${summary} ${doc.body}`;
}

/**
 * Find near-duplicate doc pairs by Jaccard token overlap — the deterministic
 * signal behind "merge repetitive facts". Both the detector AND its scoring are
 * model-free here, so duplicate detection can run and be graded at zero cost.
 */
export function redundancyReport<T extends ScorableDoc>(
  docs: T[],
  threshold = 0.6,
): RedundantPair[] {
  const tokens = docs.map((d) => new Set(tokenize(docText(d))));
  const pairs: RedundantPair[] = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const sim = jaccard(tokens[i], tokens[j]);
      if (sim >= threshold) {
        pairs.push({ a: docs[i].name, b: docs[j].name, similarity: sim });
      }
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

/* ------------------------------ auto-judgement --------------------------- */

/**
 * Score auto-judgement against human-gold accept/reject labels. The headline
 * number is `falseAcceptRate` — see JudgementMetrics (I2/I9).
 */
export function judgementMetrics(rows: JudgementRow[]): JudgementMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const r of rows) {
    const p = r.predicted === "accept";
    const g = r.gold === "accept";
    if (p && g) tp += 1;
    else if (p && !g) fp += 1;
    else if (!p && !g) tn += 1;
    else fn += 1;
  }
  const total = rows.length;
  const safeDiv = (num: number, den: number) => (den ? num / den : 0);
  return {
    total,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    accuracy: safeDiv(tp + tn, total),
    precision: safeDiv(tp, tp + fp),
    recall: safeDiv(tp, tp + fn),
    falseAcceptRate: safeDiv(fp, fp + tn),
  };
}

/* ------------------------------ defect detection ------------------------- */

/**
 * Grade a defect detector (the compaction / "REM sleep" pass) against PLANTED
 * ground truth. Keys are opaque strings the caller defines (e.g. a normalized
 * "dup:NameA|NameB" or "contradiction:X|Y"); both sets are compared as sets, so
 * order within a key is the caller's responsibility to normalize.
 */
export function defectMetrics(
  found: Iterable<string>,
  planted: Iterable<string>,
): DefectMetrics {
  const foundSet = new Set(found);
  const plantedSet = new Set(planted);
  let tp = 0;
  for (const f of foundSet) if (plantedSet.has(f)) tp += 1;
  const precision = foundSet.size ? tp / foundSet.size : 0;
  const recall = plantedSet.size ? tp / plantedSet.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    found: foundSet.size,
    planted: plantedSet.size,
    truePositives: tp,
    precision,
    recall,
    f1,
    missed: [...plantedSet].filter((p) => !foundSet.has(p)),
    spurious: [...foundSet].filter((f) => !plantedSet.has(f)),
  };
}

/* --------------------------------- stats --------------------------------- */

export function knowledgeStats<T extends ScorableDoc>(
  docs: T[],
  redundancyThreshold = 0.6,
  /** Precomputed pair count, to avoid recomputing the O(n²) report when the
   *  caller already has it (e.g. the CLI runs redundancyReport separately). */
  precomputedRedundantPairs?: number,
): KnowledgeStats {
  const byType: Record<string, number> = {};
  let totalTokens = 0;
  for (const d of docs) {
    byType[d.type] = (byType[d.type] ?? 0) + 1;
    totalTokens += tokenize(docText(d)).length;
  }
  return {
    docs: docs.length,
    byType,
    totalTokens,
    avgTokensPerDoc: docs.length ? totalTokens / docs.length : 0,
    redundantPairs:
      precomputedRedundantPairs ??
      redundancyReport(docs, redundancyThreshold).length,
  };
}
