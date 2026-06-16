// SPDX-License-Identifier: Apache-2.0
/**
 * Structured fact layer for the knowledge store (issue #10 — see
 * docs/knowledge-facts.md for the design and the invariant reasoning).
 *
 * A Fact is a relaxed, NL-friendly triple (subject, predicate, object) carrying
 * a concise `claim` and separate `commentary` — the pragmatic descendant of a
 * Prolog clause, sized for business knowledge. Facts are DERIVED from the
 * existing docs + corrections (extractFacts), so everything here runs on the
 * real store with no schema migration.
 *
 * Three processes operate on facts — proposal structuring (avenue 1), compaction
 * (avenue 2), auto-judgement (avenue 3) — and ALL of them are:
 *   • model-free (I8: no server-side inference; semantic upgrades run in-session)
 *   • recommend-only (I2/I9: they propose/annotate; the human click commits)
 *
 * Quality is measured by lib/quality.ts and gated by the #11 harness.
 */
import { jaccard, tokenize } from "./search";
import type { Correction, DocType, KnowledgeDoc } from "./store";

/* --------------------------------- types --------------------------------- */

export interface Provenance {
  source?: string;
  author?: string;
  ts?: string;
}

export interface Fact {
  /** Normalized topic key, e.g. "metric:revenue", "entity:customer". */
  subject: string;
  /** Kind of claim, e.g. "definition", "excludes", "unit", "gotcha", "join". */
  predicate: string;
  /** Comparable right-hand side, normalized for equality checks. */
  object: string;
  /** Canonical, concise human-readable fact — the thing worth storing. */
  claim: string;
  /** Reasoning/context — kept for review, never part of an answer (avenue 1). */
  commentary?: string;
  provenance?: Provenance;
  confidence?: number;
  origin: "doc" | "correction";
  /** Doc name or correction id, to trace back. */
  ref: string;
}

/** A structured proposal: concise fact separated from its commentary (avenue 1). */
export interface Proposal {
  subject?: string;
  predicate?: string;
  fact: string;
  commentary?: string;
  provenance?: Provenance;
}

export interface WellFormedness {
  score: number; // 0..1
  reasons: string[];
}

export interface MergeCandidate {
  kind: "merge";
  a: string; // fact ref
  b: string;
  subject: string;
  similarity: number;
  reason: string;
}

export interface ContradictionCandidate {
  kind: "contradiction";
  a: string;
  b: string;
  subject: string;
  reason: string;
}

export interface FlagCandidate {
  kind: "flag";
  ref: string;
  subject: string;
  reason: string;
}

export interface CompactionReport {
  merges: MergeCandidate[];
  contradictions: ContradictionCandidate[];
  flags: FlagCandidate[];
  stats: { facts: number; subjects: number };
}

export type Verdict = "accept" | "reject" | "review";

export interface Recommendation {
  verdict: Verdict;
  confidence: number; // 0..1
  reasons: string[];
}

/* ------------------------------ normalization ---------------------------- */

/** Lowercase, collapse whitespace, strip surrounding punctuation. */
export function normalize(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .trim();
}

/** The first sentence/line, trimmed and length-capped — the concise claim. */
export function conciseClaim(text: string, cap = 200): string {
  const firstLine = String(text ?? "")
    .replace(/^#+\s.*$/gm, "") // drop markdown headers
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const claim = firstSentence.trim();
  return claim.length > cap ? `${claim.slice(0, cap - 1).trim()}…` : claim;
}

/** Split free text into a concise fact + the rest as commentary (avenue 1). */
export function splitFactCommentary(text: string): {
  fact: string;
  commentary: string;
} {
  const fact = conciseClaim(text);
  const rest = String(text ?? "").trim();
  const idx = rest.indexOf(fact.replace(/…$/, ""));
  const commentary =
    idx >= 0 ? rest.slice(idx + fact.replace(/…$/, "").length).trim() : "";
  return { fact, commentary };
}

const DOC_PREDICATE: Record<DocType, string> = {
  entity: "entity",
  metric: "definition",
  query: "query",
  overview: "overview",
  gotcha: "gotcha",
};

/* ------------------------------- extraction ------------------------------ */

/** Derive facts from curated docs + corrections — no schema change (avenue 4). */
export function extractFacts(
  docs: KnowledgeDoc[],
  corrections: Correction[] = [],
): Fact[] {
  const facts: Fact[] = [];

  // Resolve a correction's free-text `relatesTo` onto a real doc subject so a
  // correction that contradicts curated knowledge groups with it. Indexed by
  // both doc name and table.
  const subjectByKey = new Map<string, string>();

  for (const d of docs) {
    const subject = `${d.type}:${normalize(d.name)}`;
    subjectByKey.set(normalize(d.name), subject);
    const tbl = normalize(String(d.meta.table ?? ""));
    if (tbl) subjectByKey.set(tbl, subject);

    const summary = String(d.meta.summary ?? "");
    const claim = conciseClaim(summary || d.body || d.name);
    const { commentary } = splitFactCommentary(summary || d.body);
    const source =
      String(d.meta.source ?? "") || String(d.meta.table ?? "") || undefined;
    facts.push({
      subject,
      predicate: DOC_PREDICATE[d.type] ?? "fact",
      object: normalize(claim),
      claim,
      commentary: commentary || undefined,
      provenance: {
        source,
        author: d.updatedBy ?? undefined,
        ts: d.updatedAt ?? undefined,
      },
      confidence: d.verified ? 1 : 0.5,
      origin: "doc",
      ref: d.name,
    });
  }

  for (const c of corrections) {
    // structured proposals carry the concise fact authoritatively (avenue 1);
    // legacy single-blob proposals fall back to the heuristic split.
    const claim = c.fact?.trim() || conciseClaim(c.content);
    const commentary = c.fact?.trim()
      ? c.content || undefined
      : splitFactCommentary(c.content).commentary || undefined;
    const rel = c.relatesTo ? normalize(c.relatesTo) : "";
    const subject = rel
      ? (subjectByKey.get(rel) ?? `topic:${rel}`)
      : "unscoped";
    facts.push({
      subject,
      predicate: c.kind || "fact",
      object: normalize(claim),
      claim,
      commentary: commentary || undefined,
      provenance: { author: c.user, ts: c.ts },
      confidence: 0.4, // pending, unverified
      origin: "correction",
      ref: `correction:${c.id}`,
    });
  }

  return facts;
}

/** Combined token set for similarity (claim carries the meaning, not commentary). */
function factTokens(f: Fact): Set<string> {
  return new Set(tokenize(`${f.subject} ${f.predicate} ${f.claim}`));
}

/** Resolve a free-text subject onto an existing fact's subject key, so a
 *  proposal groups with the curated knowledge it relates to (e.g. raw
 *  "revenue" → "metric:revenue"). Falls back to a bare "topic:" key. */
function resolveSubject(raw: string | undefined, existing: Fact[]): string {
  if (!raw) return "unscoped";
  const n = normalize(raw);
  for (const e of existing) if (e.subject === n) return e.subject;
  for (const e of existing) if (e.subject.endsWith(`:${n}`)) return e.subject;
  return `topic:${n}`;
}

/* ---------------------- avenue 1: structured proposals ------------------- */

/**
 * Score how well-formed a structured proposal is — the queue's first triage
 * signal. Deterministic; the semantic split of a legacy blob is in-session.
 */
export function wellFormedness(p: Proposal): WellFormedness {
  const reasons: string[] = [];
  let score = 0;
  const fact = (p.fact ?? "").trim();

  if (fact.length === 0) {
    return { score: 0, reasons: ["empty fact"] };
  }
  // a single concise claim, not a paragraph
  const sentences = fact.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length);
  if (sentences.length <= 1) {
    score += 0.4;
    reasons.push("single claim");
  } else {
    reasons.push(`${sentences.length} sentences — split into separate facts`);
  }
  if (fact.length <= 200) {
    score += 0.2;
    reasons.push("concise");
  } else {
    reasons.push("over 200 chars — likely carries commentary; move it out");
  }
  if (p.subject && normalize(p.subject).length) {
    score += 0.2;
    reasons.push("has subject");
  } else {
    reasons.push("no subject — what entity/metric is this about?");
  }
  if (p.provenance?.source) {
    score += 0.2;
    reasons.push("has provenance");
  } else {
    reasons.push("no source");
  }
  return { score: Math.min(1, score), reasons };
}

/* ----------------------- avenue 2: compaction pass ----------------------- */

/** Antonym clusters that signal a contradiction when two facts about the same
 *  subject sit on opposite sides. Conservative on purpose — these produce
 *  human-review candidates, not auto-edits. */
const ANTONYMS: string[][] = [
  ["include", "included", "includes", "including"],
  ["exclude", "excluded", "excludes", "excluding"],
  ["active", "enabled"],
  ["inactive", "disabled", "deleted"],
  ["gross"],
  ["net", "netted"],
  ["before"],
  ["after"],
  ["increase", "increased", "increasing"],
  ["decrease", "decreased", "decreasing"],
];

/** Map a token to its antonym-group index, or -1. Index pairs (0,1),(2,3),…
 *  are opposites. */
function antonymGroup(token: string): number {
  for (let i = 0; i < ANTONYMS.length; i++)
    if (ANTONYMS[i].includes(token)) return i;
  return -1;
}

function opposingGroups(g1: number, g2: number): boolean {
  if (g1 < 0 || g2 < 0) return false;
  // groups are laid out in opposing pairs: (0,1), (2,3), ...
  return Math.floor(g1 / 2) === Math.floor(g2 / 2) && g1 !== g2;
}

/** Predicates whose object is atomic enough that "different object" is a real
 *  conflict (vs. free-prose definitions, where it never would be). */
const ATOMIC_PREDICATES = new Set(["unit", "status", "type", "grain", "format"]);

const NUM_RE = /-?\d[\d,]*\.?\d*/g;

/** Numbers in text, excluding 4-digit years (1900–2099). Years are dates, not
 *  quantities to compare — treating one as a quantity produced a false
 *  contradiction on the real store ("2026" read as disagreeing with "7"). We
 *  trade catching year-vs-year conflicts for precision; this is a
 *  recommend-only pass, so a false flag costs more than a miss. */
function numbers(text: string): string[] {
  return (text.match(NUM_RE) ?? [])
    .map((n) => n.replace(/,/g, ""))
    .filter((n) => !/^(?:19|20)\d{2}$/.test(n));
}

/** Token set of a claim with numbers stripped — for the "same statement,
 *  different number" check. */
function nonNumericTokens(text: string): Set<string> {
  return new Set(tokenize(text.replace(NUM_RE, " ")));
}

/**
 * Near-duplicate facts (avenue 2 merge candidates). Same-subject pairs flag at
 * `threshold`; different-subject pairs need much stronger evidence
 * (`crossSubjectThreshold`) — that catches "two metrics that are really the
 * same" without merging facts that merely share common words.
 */
export function findDuplicates(
  facts: Fact[],
  threshold = 0.6,
  crossSubjectThreshold = 0.8,
): MergeCandidate[] {
  // compare claim content (not subject/predicate) — dedup is about whether the
  // two facts SAY the same thing.
  const tokens = facts.map((f) => new Set(tokenize(f.claim)));
  const out: MergeCandidate[] = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const sameSubject = facts[i].subject === facts[j].subject;
      const sim = jaccard(tokens[i], tokens[j]);
      const bar = sameSubject ? threshold : crossSubjectThreshold;
      if (sim < bar) continue;
      out.push({
        kind: "merge",
        a: facts[i].ref,
        b: facts[j].ref,
        subject: facts[i].subject,
        similarity: sim,
        reason: sameSubject
          ? `${(sim * 100).toFixed(0)}% token overlap on subject ${facts[i].subject}`
          : `${(sim * 100).toFixed(0)}% overlap across subjects ${facts[i].subject} / ${facts[j].subject} — likely the same fact`,
      });
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity);
}

/** Facts about the same subject that conflict (avenue 2). Three deterministic
 *  signals: atomic-predicate object mismatch, antonym clash, numeric mismatch. */
export function findContradictions(facts: Fact[]): ContradictionCandidate[] {
  const bySubject = new Map<string, Fact[]>();
  for (const f of facts) {
    const arr = bySubject.get(f.subject) ?? [];
    arr.push(f);
    bySubject.set(f.subject, arr);
  }

  const out: ContradictionCandidate[] = [];
  for (const [subject, group] of bySubject) {
    if (subject === "unscoped" || group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const reason = conflictReason(a, b);
        if (reason)
          out.push({ kind: "contradiction", a: a.ref, b: b.ref, subject, reason });
      }
    }
  }
  return out;
}

function conflictReason(a: Fact, b: Fact): string | null {
  // 1 — atomic predicate, different object
  if (
    a.predicate === b.predicate &&
    ATOMIC_PREDICATES.has(a.predicate) &&
    a.object !== b.object
  ) {
    return `${a.predicate} disagrees: "${a.object}" vs "${b.object}"`;
  }

  const ta = tokenize(a.claim);
  const tb = tokenize(b.claim);
  const setB = new Set(tb);

  // 2 — antonym clash, with shared context to avoid noise
  const shared = ta.filter((t) => setB.has(t)).length;
  if (shared >= 1) {
    for (const x of ta) {
      const gx = antonymGroup(x);
      if (gx < 0) continue;
      for (const y of tb) {
        if (opposingGroups(gx, antonymGroup(y)))
          return `opposing terms "${x}" vs "${y}" on the same subject`;
      }
    }
  }

  // 3 — numeric mismatch: only when the two claims are otherwise nearly the
  // SAME statement (so we're comparing the same quantity), not merely two
  // claims that each happen to contain a number.
  if (a.predicate === b.predicate) {
    const na = numbers(a.claim);
    const nb = numbers(b.claim);
    if (
      na.length &&
      nb.length &&
      na[0] !== nb[0] &&
      jaccard(nonNumericTokens(a.claim), nonNumericTokens(b.claim)) >= 0.5
    )
      return `numbers disagree: ${na[0]} vs ${nb[0]}`;
  }

  return null;
}

/** Facts whose provenance points outside the known set of sources (avenue 2).
 *  knownSources is optional — without it, nothing is flagged (no false stales). */
export function findStale(facts: Fact[], knownSources?: Set<string>): FlagCandidate[] {
  if (!knownSources) return [];
  const out: FlagCandidate[] = [];
  for (const f of facts) {
    const src = f.provenance?.source;
    if (src && !knownSources.has(src))
      out.push({
        kind: "flag",
        ref: f.ref,
        subject: f.subject,
        reason: `source "${src}" no longer present`,
      });
  }
  return out;
}

export interface CompactOpts {
  duplicateThreshold?: number;
  knownSources?: Set<string>;
}

/** The full compaction ("REM sleep") pass — a report of PROPOSED actions. */
export function compact(facts: Fact[], opts: CompactOpts = {}): CompactionReport {
  return {
    merges: findDuplicates(facts, opts.duplicateThreshold ?? 0.6),
    contradictions: findContradictions(facts),
    flags: findStale(facts, opts.knownSources),
    stats: {
      facts: facts.length,
      subjects: new Set(facts.map((f) => f.subject)).size,
    },
  };
}

/* --------------------- subject-grouped knowledge view -------------------- */

export interface KnowledgeMember {
  name: string;
  type: string;
  /** Concise fact (avenue 1) shown by default; body is the drill-in. */
  claim: string;
  body: string;
  verified: boolean;
  /** Per-doc flags: "conflict", "duplicate", "verbose". */
  flags: string[];
}

export interface SubjectGroup {
  key: string;
  label: string;
  /** The headline type of the subject (entity/metric/…). */
  primaryType: string;
  members: KnowledgeMember[];
  /** Subject-level flags, e.g. "review" when a contradiction touches it. */
  flags: string[];
}

export interface KnowledgeHealth {
  contradictions: number;
  duplicates: number;
  verbose: number;
  stale: number;
}

export interface KnowledgeView {
  docs: number;
  subjects: SubjectGroup[];
  health: KnowledgeHealth;
  /** Drill-in detail for the health bar. */
  contradictions: ContradictionCandidate[];
  merges: MergeCandidate[];
}

/** A body longer than this (tokens) carries detail beyond its concise fact. */
const VERBOSE_TOKENS = 60;

/** Token presence that tolerates simple singular/plural (customer ↔ customers). */
function hasTokenLike(set: Set<string>, t: string): boolean {
  return set.has(t) || set.has(`${t}s`) || (t.endsWith("s") && set.has(t.slice(0, -1)));
}

/**
 * Infer which canonical subject a gotcha is about from its text, when it
 * carries no explicit relates_to. Conservative: every token of a subject's name
 * must appear (plural-aware); the most specific (longest) name wins; ambiguous
 * or no match → left standalone (we'd rather under-group than mis-group).
 */
function inferGotchaTarget(
  text: Set<string>,
  canon: { key: string; tokens: string[] }[],
): string | undefined {
  let best: { key: string; score: number } | null = null;
  for (const c of canon) {
    if (!c.tokens.length) continue;
    if (c.tokens.every((t) => hasTokenLike(text, t))) {
      const score = c.tokens.length;
      if (!best || score > best.score) best = { key: c.key, score };
    }
  }
  return best?.key;
}

const SUBJECT_RANK: Record<string, number> = {
  overview: 0,
  entity: 1,
  metric: 2,
  query: 3,
  gotcha: 4,
};

/**
 * Build the subject-grouped knowledge view for /admin/knowledge: canonical
 * subjects are the non-gotcha docs; gotchas attach to the entity/metric they
 * declare via `relates_to` (else stand alone). Compaction flags (contradiction,
 * duplicate, stale) and verbosity are folded in. Pure + model-free (I8).
 */
export function buildKnowledgeView(
  docs: KnowledgeDoc[],
  pending: Correction[] = [],
): KnowledgeView {
  // canonical subjects + a lookup from name/table to subject key
  const groups = new Map<string, SubjectGroup>();
  const keyByRef = new Map<string, string>(); // normalized name/table → subject key

  const ensureGroup = (key: string, label: string, type: string): SubjectGroup => {
    let g = groups.get(key);
    if (!g) {
      g = { key, label, primaryType: type, members: [], flags: [] };
      groups.set(key, g);
    }
    return g;
  };

  for (const d of docs.filter((x) => x.type !== "gotcha")) {
    const key = `${d.type}:${normalize(d.name)}`;
    ensureGroup(key, d.name, d.type);
    keyByRef.set(normalize(d.name), key);
    const tbl = normalize(String(d.meta.table ?? ""));
    if (tbl) keyByRef.set(tbl, key);
  }

  const memberOf = (d: KnowledgeDoc): KnowledgeMember => {
    const claim = conciseClaim(String(d.meta.summary ?? "") || d.body || d.name);
    const flags: string[] = [];
    if (tokenize(d.body).length > VERBOSE_TOKENS) flags.push("verbose");
    return { name: d.name, type: d.type, claim, body: d.body, verified: d.verified, flags };
  };

  for (const d of docs.filter((x) => x.type !== "gotcha")) {
    const key = `${d.type}:${normalize(d.name)}`;
    groups.get(key)!.members.push(memberOf(d));
  }

  // canonical subjects' name tokens, for content-based gotcha attachment
  const canon = [...groups.values()].map((g) => ({
    key: g.key,
    tokens: tokenize(g.label),
  }));

  // attach gotchas to their related subject (explicit relates_to first, then
  // inferred from content), else give them their own group
  for (const g of docs.filter((x) => x.type === "gotcha")) {
    const rel = normalize(String(g.meta.relates_to ?? g.meta.relatesTo ?? ""));
    const explicit = rel ? keyByRef.get(rel) : undefined;
    const inferred =
      explicit ??
      inferGotchaTarget(
        new Set(tokenize(`${g.name} ${g.meta.summary ?? ""} ${g.body}`)),
        canon,
      );
    const key = inferred ?? `gotcha:${normalize(g.name)}`;
    if (!inferred) ensureGroup(key, g.name, "gotcha");
    groups.get(key)!.members.push(memberOf(g));
  }

  // fold in compaction flags (contradictions can involve a pending correction)
  const report = compact(extractFacts(docs, pending));
  const flagRef = (ref: string, flag: string) => {
    for (const g of groups.values())
      for (const m of g.members)
        if (m.name === ref && !m.flags.includes(flag)) {
          m.flags.push(flag);
          if (flag === "conflict" && !g.flags.includes("review")) g.flags.push("review");
        }
  };
  for (const c of report.contradictions) {
    flagRef(c.a, "conflict");
    flagRef(c.b, "conflict");
  }
  for (const m of report.merges) {
    flagRef(m.a, "duplicate");
    flagRef(m.b, "duplicate");
  }

  const subjects = [...groups.values()].sort(
    (a, b) =>
      (SUBJECT_RANK[a.primaryType] ?? 9) - (SUBJECT_RANK[b.primaryType] ?? 9) ||
      a.label.localeCompare(b.label),
  );

  const verbose = subjects.reduce(
    (n, g) => n + g.members.filter((m) => m.flags.includes("verbose")).length,
    0,
  );

  return {
    docs: docs.length,
    subjects,
    health: {
      contradictions: report.contradictions.length,
      duplicates: report.merges.length,
      verbose,
      stale: report.flags.length,
    },
    contradictions: report.contradictions,
    merges: report.merges,
  };
}

/* ---------------------- avenue 3: advisory auto-judgement ---------------- */

export interface JudgeOpts {
  duplicateThreshold?: number;
  /** Below this well-formedness, recommend reject. */
  minWellFormed?: number;
}

/**
 * Recommend (never decide) accept/reject/review for a proposal against the
 * existing curated facts. ADVISORY: the verdict annotates the human queue; the
 * accept click stays with a person (I2/I9). Measured by the harness's
 * false-accept rate.
 */
export function judgeProposal(
  p: Proposal,
  existing: Fact[],
  opts: JudgeOpts = {},
): Recommendation {
  const reasons: string[] = [];
  const wf = wellFormedness(p);
  const dupThreshold = opts.duplicateThreshold ?? 0.6;
  const minWF = opts.minWellFormed ?? 0.4;

  // malformed → reject (cheap, safe, high-precision)
  if (wf.score < minWF) {
    return {
      verdict: "reject",
      confidence: 0.6,
      reasons: [`malformed (${wf.score.toFixed(2)})`, ...wf.reasons],
    };
  }

  const pFact: Fact = {
    subject: resolveSubject(p.subject, existing),
    predicate: p.predicate || "fact",
    object: normalize(p.fact),
    claim: p.fact,
    origin: "correction",
    ref: "proposal",
  };
  const pTokens = factTokens(pFact);

  // duplicate of something already curated → reject as redundant
  let bestDup = 0;
  let dupRef = "";
  for (const e of existing) {
    if (e.subject !== pFact.subject) continue;
    const sim = jaccard(pTokens, factTokens(e));
    if (sim > bestDup) {
      bestDup = sim;
      dupRef = e.ref;
    }
  }
  if (bestDup >= dupThreshold) {
    return {
      verdict: "reject",
      confidence: Math.min(0.9, bestDup),
      reasons: [`duplicate of ${dupRef} (${(bestDup * 100).toFixed(0)}%)`],
    };
  }

  // contradicts an existing fact → REVIEW (it may be the correction — never
  // auto-reject a contradiction)
  for (const e of existing) {
    if (e.subject !== pFact.subject) continue;
    const reason = conflictReason(pFact, e);
    if (reason)
      return {
        verdict: "review",
        confidence: 0.5,
        reasons: [`conflicts with ${e.ref}: ${reason}`],
      };
  }

  // well-formed, novel, non-conflicting
  reasons.push(...wf.reasons);
  const confidence = wf.score * (p.provenance?.source ? 1 : 0.85);
  return {
    verdict: confidence >= 0.7 ? "accept" : "review",
    confidence,
    reasons,
  };
}
