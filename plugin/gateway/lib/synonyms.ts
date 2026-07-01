// SPDX-License-Identifier: Apache-2.0
/**
 * Query-expansion neighbor tables — the I8-clean stand-in for request-time
 * inference.
 *
 * I8 forbids server-side inference, so the gateway can't embed a query at request
 * time. Instead, semantic relatedness is reduced to STATIC neighbor tables the
 * gateway only does lookups against — no model call on the request path.
 *
 * There are two tiers, both consumed through the same `(token) => string[]` seam:
 *
 *   1. This module — a SMALL, DOMAIN-GENERAL base that is safe for EVERY tenant:
 *      generic money/count words plus algorithmic plural↔singular morphology.
 *      No sports/e-commerce/vertical vocabulary lives here anymore (issue #33):
 *      a hand-curated *global* thesaurus only helped tenants whose domain matched
 *      it and was inert for everyone else.
 *
 *   2. `derived-synonyms.ts` — a PER-TENANT table generated OFFLINE by clustering
 *      the tenant's own doc vocabulary with the local embedding model already on
 *      the box. That is where domain-specific bridges (clinician↔physician,
 *      SKU↔product, …) now come from — derived, not authored.
 *
 * `combineSynonyms` fuses the two so a caller sees one lookup. The base clusters
 * are built from concept CLUSTERS: every term in a cluster expands to the others.
 */

/** A semantic-neighbor lookup: a token → its neighbors (excluding itself). */
export type SynonymLookup = (token: string) => string[];

/**
 * Domain-general base clusters. Deliberately tiny and vertical-agnostic — these
 * words mean the same thing in any business (money, counting). Anything specific
 * to a domain must come from the derived per-tenant table, not from here.
 */
const CLUSTERS: string[][] = [
  ["revenue", "earnings", "income", "sales", "money", "turnover", "proceeds", "receipts", "takings"],
  ["cost", "costs", "expense", "expenses", "spend", "spending", "outlay", "outlays"],
  ["count", "number", "total", "sum", "quantity", "volume", "amount", "tally"],
  ["average", "avg", "mean", "median", "typical"],
  ["customer", "customers", "client", "clients", "account", "accounts", "user", "users"],
];

/** term → its in-cluster neighbors (excluding itself), deduped. Built once. */
const TABLE: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const cluster of CLUSTERS)
    for (const term of cluster) {
      const set = m.get(term) ?? new Set<string>();
      for (const other of cluster) if (other !== term) set.add(other);
      m.set(term, set);
    }
  return m;
})();

/**
 * Domain-general plural↔singular morphology, derived algorithmically instead of
 * being enumerated in a table. Handles the common English regulars only
 * (`-s`, `-es`, `-ies`) — deliberately conservative: synonym expansion fires
 * only on an exact-match MISS and is discounted, so an occasional over-eager stem
 * is bounded-harmless, and a real domain morphology gap is caught by the derived
 * table. Never returns the input itself.
 */
function morphology(token: string): string[] {
  const out = new Set<string>();
  if (token.length >= 4 && token.endsWith("ies")) out.add(token.slice(0, -3) + "y"); // parties → party
  if (token.length >= 4 && token.endsWith("es")) out.add(token.slice(0, -2)); // boxes → box
  if (token.length >= 3 && token.endsWith("s")) out.add(token.slice(0, -1)); // fans → fan
  if (token.length >= 3 && !token.endsWith("s")) {
    out.add(token + "s"); // fan → fans
    if (/[^aeiou]y$/.test(token)) out.add(token.slice(0, -1) + "ies"); // party → parties
    if (/(s|x|z|ch|sh)$/.test(token)) out.add(token + "es"); // box → boxes
  }
  out.delete(token);
  return [...out];
}

/**
 * Base (domain-general) semantic neighbors of a token: the static cluster table
 * plus algorithmic morphology. Empty for an unknown, non-inflected token. Pure
 * lookup — no inference (I8).
 */
export function synonymsOf(token: string): string[] {
  const out = new Set<string>(morphology(token));
  const s = TABLE.get(token);
  if (s) for (const n of s) out.add(n);
  out.delete(token);
  return [...out];
}

/**
 * Fuse several neighbor lookups (e.g. the base table + a per-tenant derived
 * table) into one. Neighbors are deduped and never include the input token, so
 * the result is drop-in for the single-lookup `synonyms` seam in search.ts.
 */
export function combineSynonyms(...lookups: SynonymLookup[]): SynonymLookup {
  return (token: string) => {
    const out = new Set<string>();
    for (const lookup of lookups) for (const n of lookup(token)) out.add(n);
    out.delete(token);
    return [...out];
  };
}
