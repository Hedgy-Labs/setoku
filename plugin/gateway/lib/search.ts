// SPDX-License-Identifier: Apache-2.0
/** Structural shape scoring needs — KnowledgeDoc satisfies this. */
export interface ScorableDoc {
  type: string;
  name: string;
  meta: Record<string, string | string[]>;
  body: string;
}

/** Lowercase alphanumeric tokens, splitting camelCase and snake_case. */
export function tokenize(text: string): string[] {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "for",
  "to",
  "and",
  "or",
  "is",
  "are",
  "how",
  "many",
  "much",
  "what",
  "which",
  "who",
  "do",
  "does",
  "we",
  "our",
  "with",
  "by",
  "per",
  "all",
  "each",
  "this",
  "that",
  "be",
  "have",
  "has",
]);

export function queryTokens(question: string): string[] {
  return [...new Set(tokenize(question).filter((t) => !STOP.has(t)))];
}

export interface ScoreOpts {
  /** Semantic-neighbor lookup (e.g. synonymsOf). When set, a query token with NO
   *  exact field hit falls back to its best-scoring neighbor, discounted. Pure
   *  table lookup — no inference (I8). */
  synonyms?: (token: string) => string[];
  /** Weight applied to a synonym match vs an exact match (default 0.5). */
  synonymDiscount?: number;
}

/**
 * Score artifact docs against a natural-language question.
 * Field-weighted term frequency — deliberately simple (spec D-decision: keyword
 * retrieval first). Optional `synonyms` adds I8-clean semantic expansion: it only
 * fires for a query token that has NO exact hit, and is discounted — so exact
 * matching (and thus the baseline) is unchanged when synonyms are off or absent.
 */
export function scoreDocs<T extends ScorableDoc>(
  docs: T[],
  question: string,
  opts: ScoreOpts = {},
): { doc: T; score: number }[] {
  const qts = queryTokens(question);
  if (!qts.length) return [];
  const discount = opts.synonymDiscount ?? 0.5;
  const scored = docs.map((doc) => {
    const nameTokens = new Set(tokenize(doc.name));
    const keywords = Array.isArray(doc.meta.keywords)
      ? doc.meta.keywords.join(" ")
      : String(doc.meta.keywords ?? "");
    const keywordTokens = new Set(tokenize(keywords));
    const summaryCounts = new Map<string, number>();
    for (const t of tokenize(
      `${doc.meta.summary ?? ""} ${doc.meta.question ?? ""} ${doc.meta.table ?? ""}`,
    ))
      summaryCounts.set(t, (summaryCounts.get(t) ?? 0) + 1);
    const bodyCounts = new Map<string, number>();
    for (const t of tokenize(doc.body))
      bodyCounts.set(t, (bodyCounts.get(t) ?? 0) + 1);
    // exact field-weighted score for a single token
    const fieldScore = (t: string): number => {
      let s = 0;
      if (nameTokens.has(t)) s += 6;
      if (keywordTokens.has(t)) s += 4;
      s += 2 * (summaryCounts.get(t) ?? 0);
      s += Math.min(3, bodyCounts.get(t) ?? 0); // cap body tf so long docs don't dominate
      return s;
    };
    let score = 0;
    let hits = 0;
    for (const qt of qts) {
      let s = fieldScore(qt);
      if (s === 0 && opts.synonyms) {
        let best = 0;
        for (const syn of opts.synonyms(qt)) {
          const ss = fieldScore(syn);
          if (ss > best) best = ss;
        }
        s = best * discount;
      }
      if (s > 0) hits += 1;
      score += s;
    }
    // small boost when most query terms hit the same doc
    score *= 1 + hits / Math.max(1, qts.length);
    return { doc, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

/* ------------------------------- link graph ------------------------------ */
//
// The knowledge store is an interlinked wiki, not a flat bag (the "LLM wiki"
// pattern). A doc declares outbound links in `meta.links` (an array of target
// doc names, or a comma/space-separated string); a gotcha's `relates_to` is an
// implicit link to the entity/metric it annotates. Links live in the existing
// free-form `meta` JSON, so there is NO schema migration. The graph is derived
// here (model-free, I8) and reused by retrieval (map-first expansion) and lint
// (orphans / suggested connections).

/** Lowercase + trim — link refs match doc names/tables case-insensitively. */
function lc(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

/** The raw, unresolved link refs a doc declares (meta.links + a gotcha's
 *  relates_to). Targets are doc names/tables; resolution happens in buildLinkGraph. */
export function rawLinks(doc: ScorableDoc): string[] {
  const out: string[] = [];
  const links = doc.meta.links;
  if (Array.isArray(links)) out.push(...links.map(String));
  else if (typeof links === "string") out.push(...links.split(/[,\n]/));
  // a gotcha (or any doc) may carry relates_to — treat it as a link target too
  const rel = doc.meta.relates_to ?? doc.meta.relatesTo;
  if (typeof rel === "string") out.push(...rel.split(/[,\n]/));
  return out.map((s) => s.trim()).filter(Boolean);
}

export interface LinkGraph {
  /** doc name → resolved out-link target doc names. */
  out: Map<string, Set<string>>;
  /** doc name → doc names that link TO it (inbound / backlinks). */
  back: Map<string, Set<string>>;
  /** Declared refs that resolved to no doc — surfaced by lint as broken links. */
  unresolved: { from: string; ref: string }[];
}

/**
 * Build the link graph over a doc set. A ref resolves to a doc by exact name,
 * then by meta.table, then by a unique substring of a name (the same tolerance
 * as store.getDoc). Self-links and unresolved refs are dropped from the graph
 * (the latter recorded in `unresolved` for lint). Pure + model-free.
 */
export function buildLinkGraph(docs: ScorableDoc[]): LinkGraph {
  const byName = new Map<string, string>(); // lc(name) → canonical name
  const byTable = new Map<string, string>();
  for (const d of docs) {
    byName.set(lc(d.name), d.name);
    const tbl = lc(d.meta.table);
    if (tbl && !byTable.has(tbl)) byTable.set(tbl, d.name);
  }
  const resolve = (ref: string): string | null => {
    const n = lc(ref);
    if (byName.has(n)) return byName.get(n)!;
    if (byTable.has(n)) return byTable.get(n)!;
    const hits = [...byName.entries()].filter(([k]) => k.includes(n));
    return hits.length === 1 ? hits[0][1] : null;
  };

  const out = new Map<string, Set<string>>();
  const back = new Map<string, Set<string>>();
  const unresolved: { from: string; ref: string }[] = [];
  for (const d of docs) {
    out.set(d.name, out.get(d.name) ?? new Set());
    back.set(d.name, back.get(d.name) ?? new Set());
  }
  for (const d of docs) {
    for (const ref of rawLinks(d)) {
      const target = resolve(ref);
      if (!target || target === d.name) {
        if (!target) unresolved.push({ from: d.name, ref });
        continue;
      }
      out.get(d.name)!.add(target);
      back.get(target)!.add(d.name);
    }
  }
  return { out, back, unresolved };
}

/** A doc's 1-hop neighbors (out-links ∪ backlinks), undirected. */
export function neighbors(graph: LinkGraph, name: string): string[] {
  return [
    ...(graph.out.get(name) ?? []),
    ...(graph.back.get(name) ?? []),
  ].filter((v, i, a) => a.indexOf(v) === i);
}

/* -------------------------------- retrieval ------------------------------- */

export interface RetrievedDoc<T extends ScorableDoc> {
  doc: T;
  score: number;
  /** "direct" = a keyword hit; "linked" = pulled in via a link from a direct hit. */
  via: "direct" | "linked";
  /** For a linked doc, the direct doc whose link surfaced it. */
  from?: string;
}

export interface RetrieveOpts {
  k?: number;
  /** Pull in 1-hop link-graph neighbors of the direct hits ("map-first"). */
  expandLinks?: boolean;
  /** Cap on linked neighbors added (default = k). */
  maxLinked?: number;
  /** Cap on PURELY STRUCTURAL linked neighbors — ones that don't match the query
   *  at all, only ride a link (default 2). Query-relevant neighbors aren't capped
   *  by this. Keeps "related context" without flooding precision. */
  maxStructuralLinked?: number;
  /** Precomputed graph (avoid rebuilding per query). */
  graph?: LinkGraph;
  /** I8-clean semantic expansion for the keyword scorer (see ScoreOpts). */
  synonyms?: (token: string) => string[];
  synonymDiscount?: number;
  /** Per-doc embedding cosine scores (doc name → score). When provided, the
   *  DIRECT ranking becomes a reciprocal-rank fusion of keyword and embedding
   *  rankings (hybrid retrieval). Computed by the caller (the local embed index /
   *  the offline eval) — search.ts itself never embeds (I8). */
  embedScores?: Map<string, number>;
  /** RRF weight on the keyword ranking relative to embeddings (default 2). >1 lets
   *  embeddings RESCUE keyword misses without overriding confident exact matches —
   *  so hybrid doesn't regress where keyword retrieval is already strong. */
  keywordWeight?: number;
}

/**
 * Reciprocal-rank fusion: combine several ranked lists into one. Robust and
 * parameter-light — an item ranked high in any list floats up; agreement
 * compounds. `kconst` damps the contribution of low ranks (standard ~60).
 */
export function fuseRRF(rankings: string[][], kconst = 60, weights?: number[]): string[] {
  const score = new Map<string, number>();
  rankings.forEach((r, li) => {
    const w = weights?.[li] ?? 1;
    r.forEach((name, i) => score.set(name, (score.get(name) ?? 0) + w / (kconst + i)));
  });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
}

/**
 * Retrieve context for a question. The base is the proven keyword scorer; with
 * `expandLinks`, the top-k direct hits' graph neighbors are appended ("map-first":
 * traverse the curated wiki instead of ranking the whole corpus). The direct
 * top-k is NEVER reordered or dropped — expansion only ADDS related docs — so
 * precision on the direct set is preserved by construction and only recall moves.
 * A linked doc that also scored on its own keeps its own (higher) score.
 */
export function retrieve<T extends ScorableDoc>(
  docs: T[],
  question: string,
  opts: RetrieveOpts = {},
): RetrievedDoc<T>[] {
  const k = opts.k ?? 5;
  const scored = scoreDocs(docs, question, {
    synonyms: opts.synonyms,
    synonymDiscount: opts.synonymDiscount,
  });
  const scoreByName = new Map(scored.map((s) => [s.doc.name, s.score]));
  // Direct ranking: keyword(+synonym) top-k, OR — when embedding scores are
  // supplied — a reciprocal-rank fusion of the keyword and embedding rankings
  // (hybrid). Fusion only reorders/augments which docs are "direct"; the rest of
  // the pipeline (link expansion, gotchas) is unchanged.
  let direct: { doc: T; score: number }[];
  if (opts.embedScores && opts.embedScores.size) {
    const byName = new Map(docs.map((d) => [d.name, d]));
    const kwRanked = scored.map((s) => s.doc.name);
    const emRanked = [...opts.embedScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map((e) => e[0]);
    direct = fuseRRF([kwRanked, emRanked], 60, [opts.keywordWeight ?? 5, 1])
      .slice(0, k)
      .map((name) => byName.get(name))
      .filter((d): d is T => !!d)
      .map((doc) => ({
        doc,
        score: scoreByName.get(doc.name) ?? opts.embedScores!.get(doc.name) ?? 0,
      }));
  } else {
    direct = scored.slice(0, k);
  }
  const result: RetrievedDoc<T>[] = direct.map((s) => ({
    doc: s.doc,
    score: s.score,
    via: "direct" as const,
  }));
  if (!opts.expandLinks) return result;

  const graph = opts.graph ?? buildLinkGraph(docs);
  const byName = new Map(docs.map((d) => [d.name, d]));
  const inResult = new Set(result.map((r) => r.doc.name));
  const seen = new Set(inResult);
  // Split neighbors: ones that ALSO matched the query (keep their real score —
  // genuinely relevant, earn recall) vs purely structural ones (inherit a damped
  // fraction of the parent's score — "related context", but the source of the
  // precision flood, so capped separately).
  const relevant: RetrievedDoc<T>[] = [];
  const structural: RetrievedDoc<T>[] = [];
  for (const d of direct) {
    for (const nbr of neighbors(graph, d.doc.name)) {
      if (seen.has(nbr)) continue;
      const doc = byName.get(nbr);
      if (!doc) continue;
      seen.add(nbr);
      const own = scoreByName.get(nbr) ?? 0;
      if (own > 0) relevant.push({ doc, score: own, via: "linked", from: d.doc.name });
      else structural.push({ doc, score: d.score * 0.4, via: "linked", from: d.doc.name });
    }
  }
  relevant.sort((a, b) => b.score - a.score);
  structural.sort((a, b) => b.score - a.score);
  const linked = [
    ...relevant,
    ...structural.slice(0, opts.maxStructuralLinked ?? 2),
  ].slice(0, opts.maxLinked ?? k);
  return [...result, ...linked];
}

/** Jaccard overlap of two token sets, in [0,1]. Shared by retrieval-quality and
 *  fact-dedup (both ask "how similar are these two bags of words?"). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Gotchas are one-liners: include any sharing at least one meaningful token with the question. */
export function matchGotchas(gotchas: string[], question: string): string[] {
  const qts = new Set(queryTokens(question));
  if (!qts.size) return [];
  return gotchas.filter((g) => tokenize(g).some((t) => qts.has(t)));
}

const gotchaText = (g: ScorableDoc) =>
  `${g.name} ${g.meta.summary ?? ""} ${g.body}`;

/** Query-relevance score for a gotcha: distinct query tokens it contains
 *  (weighted heavily) plus total occurrences. Used to rank/cap gotchas instead
 *  of dumping every one that shares a single word with the question. */
export function rankGotchas<T extends ScorableDoc>(
  gotchas: T[],
  question: string,
): { doc: T; score: number }[] {
  const qts = new Set(queryTokens(question));
  if (!qts.size) return [];
  return gotchas
    .map((g) => {
      const counts = new Map<string, number>();
      for (const t of tokenize(gotchaText(g)))
        if (qts.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      return { doc: g, score: counts.size * 10 + total };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Is this gotcha *about* the given doc? Explicit `relates_to`, else the doc's
 *  full name appears in the gotcha text (plural-aware) — the same content
 *  inference buildKnowledgeView uses to attach gotchas to subjects. */
function gotchaAttachedTo(g: ScorableDoc, hit: ScorableDoc): boolean {
  const rel = lc(g.meta.relates_to ?? g.meta.relatesTo);
  if (rel && (rel === lc(hit.name) || rel === lc(hit.meta.table))) return true;
  const nameTokens = tokenize(hit.name);
  if (!nameTokens.length) return false;
  const gset = new Set(tokenize(gotchaText(g)));
  return nameTokens.every(
    (t) => gset.has(t) || gset.has(`${t}s`) || (t.endsWith("s") && gset.has(t.slice(0, -1))),
  );
}

/**
 * Choose which gotchas to surface for a query, capped — the precise replacement
 * for "dump every gotcha sharing a word." A gotcha attached to one of the direct
 * hits (its metric/entity is what you asked about) is surfaced first (relevant by
 * construction); the rest of the budget is filled by query-relevance. A gotcha
 * that is neither attached nor query-relevant is dropped. Cuts context flooding
 * while *raising* precision. Returns gotcha docs in surface order.
 */
export function selectGotchas<T extends ScorableDoc>(
  gotchas: T[],
  hits: ScorableDoc[],
  question: string,
  // cap = 3: on the Bulldogs trap set this holds 100% trap coverage at ~2.9
  // gotchas/query (vs 5.2 uncapped); cap=2 loses a trap. Tuned via eval:value.
  cap = 3,
): T[] {
  const rel = new Map(rankGotchas(gotchas, question).map((x) => [x.doc.name, x.score]));
  return gotchas
    .map((g) => {
      const attached = hits.some((h) => gotchaAttachedTo(g, h));
      return { g, score: (attached ? 1000 : 0) + (rel.get(g.name) ?? 0) };
    })
    .filter((x) => x.score > 0) // attached OR query-relevant
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((x) => x.g);
}

/** Same one-token-overlap matching for pending corrections (content + relatesTo). */
export function matchByTokens<T>(
  items: T[],
  textOf: (item: T) => string,
  question: string,
): T[] {
  const qts = new Set(queryTokens(question));
  if (!qts.size) return [];
  return items.filter((item) => tokenize(textOf(item)).some((t) => qts.has(t)));
}
