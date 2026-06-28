// SPDX-License-Identifier: Apache-2.0
/**
 * Static semantic-neighbor table for query expansion (the I8-clean stand-in for
 * embeddings).
 *
 * I8 forbids server-side inference, so the gateway can't embed a query at request
 * time. Instead, semantic relatedness is reduced to a STATIC neighbor table the
 * gateway only does lookups against — no model call. Today the table is a curated
 * thesaurus of general business/sports-business clusters; in production the SAME
 * table can be GENERATED OFFLINE from real embeddings (cluster terms by cosine,
 * emit neighbor lists) — the gateway code path is identical either way.
 *
 * The table is built from concept CLUSTERS: every term in a cluster expands to
 * the others. Keep clusters CONCEPTUAL (a thesaurus), not mappings to specific
 * eval phrasings — improvements must generalize (measured on a held-out split).
 */

const CLUSTERS: string[][] = [
  ["fans", "fan", "fanbase", "supporters", "supporter", "followers", "following"],
  [
    "sponsorship", "sponsor", "sponsors", "sponsored", "partner", "partners",
    "partnership", "partnerships", "brand", "brands", "advertiser", "advertisers",
    "backer", "backers", "corporate", "commercial",
  ],
  [
    "media", "broadcast", "broadcasting", "broadcaster", "tv", "television",
    "radio", "network", "networks", "streaming", "rights",
  ],
  [
    "food", "beverage", "beverages", "fnb", "concession", "concessions", "snack",
    "snacks", "drink", "drinks", "refreshments", "catering",
  ],
  [
    "labor", "labour", "staff", "staffing", "worker", "workers", "workforce",
    "crew", "employee", "employees", "personnel", "wages", "payroll", "headcount",
  ],
  [
    "renewal", "renewals", "renew", "renewed", "retention", "retain", "subscriber",
    "subscribers", "subscription", "membership", "memberships", "resubscribe",
  ],
  [
    "attendance", "attendees", "attendee", "crowd", "turnstile", "turnstiles",
    "gate", "ballpark", "stadium", "arena", "matchday", "gameday",
  ],
  [
    "merch", "merchandise", "apparel", "jersey", "jerseys", "shop", "store",
    "gear", "clothing",
  ],
  ["pos", "kiosk", "stand", "stands", "instadium", "invenue"],
  [
    "revenue", "earnings", "income", "sales", "money", "takings", "receipts",
    "proceeds", "turnover",
  ],
  [
    "incident", "incidents", "ejection", "ejections", "injury", "injuries",
    "medical", "security", "breach", "emergency",
  ],
  [
    "identity", "dedupe", "deduplicate", "deduplication", "duplicate", "duplicates",
    "match", "matching", "resolve", "resolution", "linkage", "link",
  ],
  [
    "account", "accounts", "buyer", "buyers", "customer", "customers", "contact",
    "contacts", "patron", "patrons",
  ],
  ["opponent", "opponents", "rival", "rivals", "team", "teams", "matchup", "matchups"],
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

/** Semantic neighbors of a token (empty if unknown). Pure lookup — no inference. */
export function synonymsOf(token: string): string[] {
  const s = TABLE.get(token);
  return s ? [...s] : [];
}
