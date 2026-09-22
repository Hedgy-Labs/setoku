// SPDX-License-Identifier: Apache-2.0
/**
 * The box roster — what THIS deployment actually holds, rendered into the two
 * surfaces a client reads BEFORE it calls any tool: the MCP server
 * `instructions` (sent once, at connect) and the entry-point tool descriptions.
 *
 * Why this exists: every static string in the tool surface used to say
 * "business" — business context, biz.*, Slack archive. On a box whose lake is
 * Monarch + Gmail, that teaches a client the connector is a work-analytics tool,
 * and it then answers "I don't have access to your personal finances" without
 * calling anything. `list_sources` had the truth all along, but only in its
 * RETURN value: you had to already suspect the answer to call the tool that
 * tells you. Discovery that requires calling the discovery tool isn't discovery.
 *
 * So the roster is derived from the same live probe the /admin Sources page
 * reads (one cached snapshot, no new ClickHouse load) and pushed OUT to where a
 * client looks first.
 *
 * ## The budget (the second bug)
 *
 * Saying it isn't enough — it has to survive the client. A host that renders a
 * tool picker truncates the description to a preview (~90 chars observed on
 * claude.ai), and the roster's first family ate the whole budget: a campsh box
 * showed "software development activity: issues, pull reque…" and the reader
 * concluded there was no email here — while sitting on a Gmail lake. Everything
 * after the first semicolon was invisible.
 *
 * So each family now renders at three lengths, for three different readers:
 *
 * - `short` — the HEAD, front-loaded and budgeted so the whole domain list fits
 *   inside a preview. This is the string a truncating client actually shows.
 * - `long`  — the full phrase, after the head, for a client with room.
 * - `vendor` + `keywords` — the TAIL, appended to entry-point descriptions.
 *   Nobody reads it; the embedder does. Tool search is a retrieval problem
 *   before it is a reading problem, and a description that never says "email"
 *   or "Gmail" loses the inbox question to the Gmail connector before any of
 *   the prose above gets a chance.
 *
 * The vendor name earns its place for one more reason: a client that can't see
 * Gmail data is already here will offer to CONNECT Gmail, sending the user to
 * re-link a source this box has polled for months.
 */

import { BEAT_LIVE_MS, familyOf } from "./sources";
import type { SourcesData } from "./approval";

export interface FamilyDomain {
  /** 1–2 words for the head — what a question would call it ("email"). */
  short: string;
  /** The vendor behind it, when there is one: the strongest retrieval anchor
   *  we own, and the thing that stops "shall I connect Gmail?" for a box that
   *  already has Gmail. Null for families no vendor supplies. */
  vendor: string | null;
  /** The full phrase — what a person would say the data IS. */
  long: string;
  /** Extra words a real question uses, for the retrieval tail only. */
  keywords: string[];
}

/**
 * Plain-language domain for each source family — what the data IS, not just the
 * vendor that supplies it. "Monarch" means nothing to a reader asking about
 * their mortgage; "finance" does. (The vendor rides alongside for retrieval,
 * never instead of the domain.)
 *
 * Keyed by the family label (the part before " · " in a LAKE_SOURCES `source`),
 * so adding a connector to a family it already belongs to needs nothing here. A
 * family with no entry falls back to its own label, which is never wrong — only
 * less helpful. `test/roster.test.ts` fails if a family loses its entry.
 */
export const FAMILY_DOMAIN: Record<string, FamilyDomain> = {
  Monarch: {
    short: "finance",
    vendor: "Monarch Money",
    long: "personal finance: transactions, balances, net worth, budgets, investment holdings",
    keywords: ["spending", "net worth", "budget", "investments"],
  },
  Gmail: {
    short: "email",
    vendor: "Gmail",
    long: "personal email: senders, subjects, bodies",
    keywords: ["inbox", "messages", "attachments", "receipts"],
  },
  GitHub: {
    short: "code",
    vendor: "GitHub",
    long: "software development activity: issues, pull requests, commits, code review",
    keywords: ["pull requests", "commits", "issues", "code review"],
  },
  Mercury: {
    short: "banking",
    vendor: "Mercury",
    long: "business banking: balances, transactions, burn, runway",
    keywords: ["bank", "burn", "runway", "payments"],
  },
  Slack: {
    short: "chat",
    vendor: "Slack",
    long: "team chat archive: channel messages and thread replies",
    keywords: ["channels", "threads", "what the team said"],
  },
  Vercel: {
    short: "web logs",
    vendor: "Vercel",
    long: "web hosting logs: requests, build and runtime errors, latency",
    keywords: ["requests", "latency", "deploys", "errors"],
  },
  Render: {
    short: "server logs",
    vendor: "Render",
    long: "app server logs: stdout/stderr, deploy and runtime errors",
    keywords: ["stderr", "crashes", "deploys"],
  },
  "First-party events": {
    short: "analytics",
    vendor: null,
    long: "product analytics: first-party events the app emits",
    keywords: ["events", "signups", "funnel", "usage"],
  },
  Postgres: {
    short: "app database",
    vendor: null,
    long: "the application database, mirrored table-for-table as biz.*",
    keywords: ["biz.*", "users", "orders", "application tables"],
  },
};

/** Families that are plumbing, not a thing anyone "has data about". */
const NOT_A_DOMAIN = new Set(["Unrouted (raw)", "Postgres mirror"]);

/** The mirror's head entry — the `biz.*` is load-bearing (it's the query path),
 *  so it survives even when vendors get dropped for budget. */
const MIRROR_SHORT = "app database (biz.*)";

/** The shortest description preview we've seen a host render. The head must fit
 *  INSIDE it, prefix included — a budget that counts only the family text ships
 *  a line that still gets cut, which is the whole bug. */
const PREVIEW_BUDGET = 90;
/** Kept short on purpose: every character here is a character the domain list
 *  doesn't get. */
const HEAD_PREFIX = "Data here: ";
const HEAD_BUDGET = PREVIEW_BUDGET - HEAD_PREFIX.length;
/** Tail budget. Long enough to anchor every family, short enough not to drown
 *  the description it rides on. */
const KEYWORD_BUDGET = 260;
/** Title suffix budget — titles sit next to the tool name in a picker. */
const TITLE_BUDGET = 56;

export interface BoxRoster {
  /** Short human name for this box (config.name, e.g. "campsh"), or null. */
  box: string | null;
  /** Connected source families, in LAKE_SOURCES order. */
  families: string[];
  /** Count of biz.* mirrored tables (0 when no mirror runs here). */
  mirrored: number;
  /** Curated docs visible to this identity. */
  docs: number;
}

/**
 * The families that are actually CONNECTED: at least one table holding rows, or
 * a connector beating within the liveness window. Bootstrap creates every lake
 * table up front, so existence alone proves nothing — and a family whose poller
 * is merely paused still has queryable history, so rows alone don't either.
 * (Same rule list_sources and the Sources page draw, in one place.)
 */
export function connectedFamilies(tables: SourcesData["lake"]["tables"], nowMs: number): string[] {
  const live = new Set<string>();
  for (const t of tables) {
    const family = familyOf(t.source);
    if (NOT_A_DOMAIN.has(family)) continue;
    const beatMs = t.beat ? Date.parse(t.beat) : NaN;
    const flowing = Number.isFinite(beatMs) && nowMs - beatMs < BEAT_LIVE_MS;
    if ((t.rows ?? 0) > 0 || flowing) live.add(family);
  }
  return [...live];
}

/** Build the roster from the /admin Sources snapshot. */
export function rosterFrom(sources: SourcesData, box: string | null, nowMs: number): BoxRoster {
  return {
    box,
    families: connectedFamilies(sources.lake.tables, nowMs),
    mirrored: sources.mirror.tables.length,
    docs: sources.knowledge.docs,
  };
}

/** A family's entry, or a never-wrong fallback built from its label. */
function domainOf(family: string): FamilyDomain {
  return FAMILY_DOMAIN[family] ?? { short: family, vendor: null, long: family, keywords: [] };
}

/** `["Monarch", "Gmail"]` → the full phrases. */
function longs(families: string[]): string[] {
  return families.map((f) => domainOf(f).long);
}

/**
 * The budgeted head: every connected domain in as few characters as possible,
 * because on a truncating client this is the ONLY part that gets read.
 *
 * Degrades in order — vendors go first (the tail still carries them), then
 * families spill into a count. A head that names 4 of 7 and says so beats one
 * cut mid-word, which is what the reader silently treats as "that's all there
 * is". Returns "" when nothing is connected.
 */
function head(families: string[], mirrored: number): string {
  const entries = families.map(domainOf);
  const shorts = entries.map((e) => e.short);
  const withVendor = entries.map((e) => (e.vendor ? `${e.short} (${e.vendor})` : e.short));
  if (mirrored > 0) {
    shorts.push(MIRROR_SHORT);
    withVendor.push(MIRROR_SHORT);
  }
  if (!shorts.length) return "";

  for (const parts of [withVendor, shorts]) {
    const line = parts.join(", ");
    if (line.length <= HEAD_BUDGET) return line;
  }
  // Still over: keep what fits (always at least one) and count the rest.
  const kept: string[] = [];
  for (const p of shorts) {
    if (kept.length && [...kept, p].join(", ").length > HEAD_BUDGET - 22) break;
    kept.push(p);
  }
  const rest = shorts.length - kept.length;
  return rest > 0 ? `${kept.join(", ")}, +${rest} more (list_sources)` : kept.join(", ");
}

/**
 * The roster prefix on the entry-point tool descriptions — the only text a
 * client is guaranteed to read before deciding whether this connector is
 * relevant. Head first, detail after: a preview that keeps 90 characters still
 * comes away knowing every domain this box holds. Null when nothing is
 * connected (say nothing rather than promise an empty box).
 *
 * Deliberately omits the box name: this line repeats across every entry-point
 * tool, and the box name already prefixes each of their names (the connector
 * installs as `<box>-setoku`). It's carried once, in serverInstructions.
 */
export function rosterLine(roster: BoxRoster | null): string | null {
  if (!roster) return null;
  const h = head(roster.families, roster.mirrored);
  if (!h) return null;
  const detail = longs(roster.families);
  if (roster.mirrored > 0) detail.push(FAMILY_DOMAIN.Postgres.long);
  return `${HEAD_PREFIX}${h}. In detail: ${detail.join("; ")}.`;
}

/**
 * The retrieval tail, appended to entry-point descriptions. Written for the
 * embedder behind a host's tool search, not for a reader: the words a question
 * actually uses ("inbox", "receipts", "runway") plus the vendor names, which
 * are the sharpest anchors there are.
 *
 * Round-robin across families so a budget cut costs every family its LAST
 * keyword rather than costing the last family everything.
 */
export function rosterKeywords(roster: BoxRoster | null): string | null {
  if (!roster) return null;
  const families = [...roster.families];
  if (roster.mirrored > 0) families.push("Postgres");
  const perFamily = families.map((f) => {
    const d = domainOf(f);
    return [...(d.vendor ? [d.vendor] : []), ...d.keywords];
  });
  const depth = Math.max(0, ...perFamily.map((l) => l.length));
  const words: string[] = [];
  for (let i = 0; i < depth; i++) {
    for (const list of perFamily) if (list[i]) words.push(list[i]);
  }
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (seen.has(w.toLowerCase())) continue; // two families can share a word
    if (kept.length && [...kept, w].join(", ").length > KEYWORD_BUDGET) break;
    seen.add(w.toLowerCase());
    kept.push(w);
  }
  if (!kept.length) return null;
  return `Also matches: ${kept.join(", ")}.`;
}

/**
 * Domain list for the entry-point tool TITLES — the shortest surface of all,
 * rendered beside the tool name in a picker that may never show a description.
 * Shorts only, no vendors. Null when nothing is connected.
 */
export function rosterTitle(roster: BoxRoster | null): string | null {
  if (!roster) return null;
  const shorts = roster.families.map((f) => domainOf(f).short);
  if (roster.mirrored > 0) shorts.push(domainOf("Postgres").short);
  if (!shorts.length) return null;
  const kept: string[] = [];
  for (const s of shorts) {
    if (kept.length && [...kept, s].join(", ").length > TITLE_BUDGET) return `${kept.join(", ")}…`;
    kept.push(s);
  }
  return kept.join(", ");
}

/**
 * MCP server `instructions` — sent once in the initialize response, before any
 * tool call. This is the highest-leverage string we own: it is read exactly when
 * a client is forming its prior about what the connector is for, which is the
 * moment the old surface got wrong.
 *
 * The standing rule at the end is the actual bug fix. "I don't think Setoku has
 * that" is a claim about capability, and the client is not entitled to make it
 * from the tool names alone — list_sources is cheap and authoritative.
 */
export function serverInstructions(
  roster: BoxRoster | null,
  caps: { canWrite: boolean; denyLakeRead: boolean },
): string {
  const box = roster?.box ? `the "${roster.box}" box` : "this box";
  const lines = [
    `Setoku is the governed query path into ONE company's or person's own data (${box}), and nothing ` +
      `else. What it holds is set by whoever deployed it: it may be company data, personal data, or ` +
      `both. Do not assume from the connector's name.`,
    "",
  ];

  // Vendors ride the bullets here (there's room): a client that can't see Gmail
  // is already connected offers to connect it, which is the screenshot bug.
  const bullets = roster
    ? roster.families.map((f) => {
        const d = domainOf(f);
        return d.vendor ? `${d.long} (via ${d.vendor})` : d.long;
      })
    : [];
  if (roster && roster.mirrored > 0) {
    bullets.push(
      `${FAMILY_DOMAIN.Postgres.long} (${roster.mirrored} table${roster.mirrored === 1 ? "" : "s"})`,
    );
  }
  if (bullets.length) {
    // The compact head leads, so even a client that truncates instructions gets
    // the whole domain list before it runs out of room.
    lines.push(
      `Connected right now — ${head(roster!.families, roster!.mirrored)}:`,
      ...bullets.map((p) => `- ${p}`),
      "",
    );
  } else if (roster) {
    lines.push(
      "No source is flowing into this box yet — call list_sources for the current state before " +
        "telling the user what is or isn't available.",
      "",
    );
  }

  lines.push(
    "How to use it:",
    "- Call find_context FIRST on any question about this data — it returns what the numbers MEAN " +
      "here (definitions, gotchas, canonical SQL), which you cannot infer from column names.",
    `- Query with run_query, dialect:"clickhouse". get_schema lists every table you may touch.`,
  );
  if (roster && roster.docs === 0) {
    lines.push(
      "- The knowledge store is empty, so find_context will come back thin. That says nothing about " +
        "what data exists — check get_schema, and say what you assumed.",
    );
  }
  if (caps.denyLakeRead) {
    lines.push(
      "- This is a CURATOR session: you can commit knowledge but cannot read the data itself. Switch " +
        "to the everyday connector to query.",
    );
  } else if (!caps.canWrite) {
    lines.push(
      "- You cannot commit knowledge from this session. Capture anything the user teaches you with " +
        "report_correction; a human approves it in /admin.",
    );
  }

  lines.push(
    "",
    "STANDING RULE: never tell the user Setoku doesn't have data for something without calling " +
      "list_sources (and, for a specific table, get_schema) in that same turn. Connected sources " +
      "change without the tool list changing, the knowledge store being quiet on a topic is not " +
      "evidence the data is missing, and a wrong 'I don't have access to that' is the single " +
      "worst answer this connector can give — it sends the user away from data they own.",
  );
  return lines.join("\n");
}
