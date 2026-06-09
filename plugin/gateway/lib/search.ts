import type { ContextDoc } from "./artifact";

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

/**
 * Score artifact docs against a natural-language question.
 * Field-weighted term frequency — deliberately simple (spec D-decision: keyword
 * retrieval first, embeddings only if recall proves insufficient).
 */
export function scoreDocs(
  docs: ContextDoc[],
  question: string,
): { doc: ContextDoc; score: number }[] {
  const qts = queryTokens(question);
  if (!qts.length) return [];
  const scored = docs.map((doc) => {
    const nameTokens = new Set(tokenize(doc.name));
    const keywords = Array.isArray(doc.meta.keywords)
      ? doc.meta.keywords.join(" ")
      : String(doc.meta.keywords ?? "");
    const keywordTokens = new Set(tokenize(keywords));
    const summaryTokens = tokenize(
      `${doc.meta.summary ?? ""} ${doc.meta.question ?? ""} ${doc.meta.table ?? ""}`,
    );
    const bodyCounts = new Map<string, number>();
    for (const t of tokenize(doc.body))
      bodyCounts.set(t, (bodyCounts.get(t) ?? 0) + 1);
    let score = 0;
    let hits = 0;
    for (const qt of qts) {
      let s = 0;
      if (nameTokens.has(qt)) s += 6;
      if (keywordTokens.has(qt)) s += 4;
      s += 2 * summaryTokens.filter((t) => t === qt).length;
      s += Math.min(3, bodyCounts.get(qt) ?? 0); // cap body tf so long docs don't dominate
      if (s > 0) hits += 1;
      score += s;
    }
    // small boost when most query terms hit the same doc
    score *= 1 + hits / Math.max(1, qts.length);
    return { doc, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

/** Gotchas are one-liners: include any sharing at least one meaningful token with the question. */
export function matchGotchas(gotchas: string[], question: string): string[] {
  const qts = new Set(queryTokens(question));
  if (!qts.size) return [];
  return gotchas.filter((g) => tokenize(g).some((t) => qts.has(t)));
}
