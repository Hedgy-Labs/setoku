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
 */

import { BEAT_LIVE_MS, familyOf } from "./sources";
import type { SourcesData } from "./approval";

/**
 * Plain-language domain for each source family — what a person would say the
 * data IS, not the vendor that supplies it. "Monarch" means nothing to a reader
 * asking about their mortgage; "personal finance" does.
 *
 * Keyed by the family label (the part before " · " in a LAKE_SOURCES `source`),
 * so adding a connector to a family it already belongs to needs nothing here. A
 * family with no entry falls back to its own label, which is never wrong — only
 * less helpful. `test/roster.test.ts` fails if a family loses its phrase.
 */
export const FAMILY_DOMAIN: Record<string, string> = {
  Monarch: "personal finance: transactions, balances, net worth, budgets, investment holdings",
  Gmail: "personal email: senders, subjects, bodies",
  GitHub: "software development activity: issues, pull requests, commits, code review",
  Mercury: "business banking: balances, transactions, burn, runway",
  Slack: "team chat archive: channel messages and thread replies",
  Vercel: "web hosting logs: requests, build and runtime errors, latency",
  Render: "app server logs: stdout/stderr, deploy and runtime errors",
  "First-party events": "product analytics: first-party events the app emits",
  Postgres: "the application database, mirrored table-for-table as biz.*",
};

/** Families that are plumbing, not a thing anyone "has data about". */
const NOT_A_DOMAIN = new Set(["Unrouted (raw)", "Postgres mirror"]);

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

/** `["Monarch", "Gmail"]` → `"personal finance …; personal email …"`. */
function domains(families: string[]): string[] {
  return families.map((f) => FAMILY_DOMAIN[f] ?? f);
}

/**
 * The one-line roster prepended to the entry-point tool descriptions — the only
 * text a client is guaranteed to read before deciding whether this connector is
 * relevant. Null when nothing is connected (say nothing rather than promise an
 * empty box).
 *
 * Deliberately omits the box name: this line repeats across every entry-point
 * tool, and the box name already prefixes each of their names (the connector
 * installs as `<box>-setoku`). It's carried once, in serverInstructions.
 */
export function rosterLine(roster: BoxRoster | null): string | null {
  if (!roster) return null;
  const parts = domains(roster.families);
  if (roster.mirrored > 0) parts.push(FAMILY_DOMAIN.Postgres);
  if (!parts.length) return null;
  return `THIS CONNECTOR'S DATA covers: ${parts.join("; ")}.`;
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

  const parts = roster ? domains(roster.families) : [];
  if (roster && roster.mirrored > 0) {
    parts.push(`${FAMILY_DOMAIN.Postgres} (${roster.mirrored} table${roster.mirrored === 1 ? "" : "s"})`);
  }
  if (parts.length) {
    lines.push("Connected right now:", ...parts.map((p) => `- ${p}`), "");
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
