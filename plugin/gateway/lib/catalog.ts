// SPDX-License-Identifier: Apache-2.0
/**
 * Derived catalogs for lake tables whose payload is semi-structured.
 *
 * `setoku.app_events` is the sharpest instance: its schema is honest but
 * useless for discovery — `event_name LowCardinality(String)` and `properties
 * String` say nothing about WHICH events an app emits or what they carry. An
 * agent that asks "do we have pageviews?" sees a table blurbed "product
 * events", an opaque JSON column, and no way to know without guessing the SQL.
 * That is an unknown-unknown: the data is right there and the discovery tools
 * cannot point at it.
 *
 * So we derive the vocabulary FROM the data (I8-clean — an aggregate query, no
 * inference) and fold it into the tools that answer "what can I query":
 * `list_sources` (one line) and `get_schema` (the detail view). The same
 * catalog, plus the column names, backs find_context's coverage check — the
 * structural fallback for a question the knowledge store has nothing on.
 *
 * Cached per (lake, active roles). Roles are part of the key because the engine
 * filters by them: a session denied the events family gets an error, caches its
 * own empty answer, and can never be served a privileged session's rows.
 */
import { runLakeQuery } from "./lake";
import { stemToken, tokenize } from "./search";

/** One `event_name` an app actually emits, with what its payload carries. */
export interface EventKind {
  name: string;
  count: number;
  /** Earliest / latest event time seen (lake timestamps, "YYYY-MM-DD hh:mm:ss"). */
  firstTs: string;
  lastTs: string;
  /** Distinct actors — 0 when the producer never sets one. */
  actors: number;
  /** Property keys, sampled from recent rows of this event (never exhaustive). */
  keys: string[];
}

/** The lake table this catalog describes (the first-party events sink). */
export const EVENTS_TABLE = "app_events";
/** How many property keys we keep per event kind — enough to recognize the
 *  shape, short enough that a chatty payload can't dominate the tool output. */
const MAX_KEYS = 12;
/** Event kinds per catalog. A product with more than this has bigger discovery
 *  problems than one tool line; the count line still reports the true total. */
const MAX_KINDS = 40;

const TTL_MS = 10 * 60_000;
interface Entry {
  at: number;
  events: EventKind[];
}
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<EventKind[]>>();

const keyFor = (lakeUrl: string, roles: string[] | null): string =>
  `${lakeUrl}|${(roles ?? []).join(",")}`;

/** Test hook — drop every cached catalog. */
export function clearCatalogCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * The event vocabulary in the lake, most frequent first. `[]` when the table is
 * absent, empty, denied to this session, or the lake is unreachable — every
 * caller treats the catalog as a bonus, never a precondition, so a degraded
 * lake costs detail and never an error.
 *
 * `maxWaitMs` bounds how long a COLD read may block: find_context passes one so
 * a slow lake can never stall the tool that is documented as "always call
 * first" (it degrades to the coverage line without the schema pointer, and the
 * refresh lands for the next call).
 */
export async function eventCatalog(
  lakeUrl: string,
  opts: { statementTimeoutMs: number; maxWaitMs?: number },
  roles: string[] | null = null,
): Promise<EventKind[]> {
  const key = keyFor(lakeUrl, roles);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.events;

  let pending = inflight.get(key);
  if (!pending) {
    pending = refresh(lakeUrl, opts.statementTimeoutMs, roles, key).finally(
      () => {
        inflight.delete(key);
      },
    );
    inflight.set(key, pending);
  }
  if (hit) return hit.events; // stale-while-revalidate: serve it, refresh lands next
  if (opts.maxWaitMs == null) return pending;
  return Promise.race([
    pending,
    new Promise<EventKind[]>((resolve) =>
      setTimeout(() => resolve([]), opts.maxWaitMs),
    ),
  ]);
}

async function refresh(
  lakeUrl: string,
  statementTimeoutMs: number,
  roles: string[] | null,
  key: string,
): Promise<EventKind[]> {
  let events: EventKind[] = [];
  try {
    // groupArray(N) samples at most N rows per group, so the key scan stays
    // cheap on a large table — property keys are advertised as sampled, not
    // exhaustive, precisely because of this bound. Malformed JSON yields [].
    const res = await runLakeQuery(
      lakeUrl,
      `SELECT event_name AS name,
              count() AS n,
              toString(min(ts)) AS first_ts,
              toString(max(ts)) AS last_ts,
              uniqExact(actor) AS actors,
              arrayDistinct(arrayFlatten(groupArray(25)(JSONExtractKeys(properties)))) AS keys
       FROM setoku.${EVENTS_TABLE}
       GROUP BY event_name
       ORDER BY n DESC
       LIMIT ${MAX_KINDS}`,
      { rowCap: MAX_KINDS + 1, statementTimeoutMs },
      {},
      roles,
    );
    events = (res.rows as Array<Record<string, unknown>>).map((r) => ({
      name: String(r.name ?? ""),
      count: Number(r.n ?? 0),
      firstTs: String(r.first_ts ?? ""),
      lastTs: String(r.last_ts ?? ""),
      actors: Number(r.actors ?? 0),
      keys: (Array.isArray(r.keys) ? r.keys.map(String) : [])
        .sort()
        .slice(0, MAX_KEYS),
    }));
  } catch {
    /* table absent / denied / lake down — negative-cache for a TTL so a broken
       lake isn't re-probed on every discovery call */
  }
  cache.set(key, { at: Date.now(), events });
  return events;
}

/** Date part of a lake timestamp ("2026-07-03 12:00:00.000" → "2026-07-03"). */
const day = (ts: string): string => ts.slice(0, 10);

/**
 * The one-line catalog for `list_sources` — appended to the events blurb so the
 * capability list names the actual events instead of the generic category.
 * Null when nothing has been emitted yet (the blurb stands alone).
 */
export function catalogSummary(
  events: EventKind[],
  maxKinds = 4,
): string | null {
  if (!events.length) return null;
  const total = events.reduce((a, e) => a + e.count, 0);
  const first =
    events
      .map((e) => e.firstTs)
      .filter(Boolean)
      .sort()[0] ?? "";
  const last =
    events
      .map((e) => e.lastTs)
      .filter(Boolean)
      .sort()
      .at(-1) ?? "";
  const shown = events
    .slice(0, maxKinds)
    .map((e) =>
      e.keys.length ? `${e.name} (${e.keys.slice(0, 4).join(", ")})` : e.name,
    )
    .join(", ");
  const more =
    events.length > maxKinds ? `, +${events.length - maxKinds} more` : "";
  const span = first && last ? `, ${day(first)} → ${day(last)}` : "";
  return `emits ${shown}${more} — ${events.length} event kind${events.length === 1 ? "" : "s"}, ${total} events${span}`;
}

/**
 * The `get_schema` detail block — what the `properties String` column actually
 * contains, per event. Empty when there is no catalog to show.
 */
export function catalogDetail(events: EventKind[]): string[] {
  if (!events.length) return [];
  const out = [
    `event_name values (derived from the data; property keys sampled, not exhaustive):`,
  ];
  for (const e of events) {
    const span =
      e.firstTs && e.lastTs ? `${day(e.firstTs)} → ${day(e.lastTs)}` : "";
    const bits = [
      `${e.count} event${e.count === 1 ? "" : "s"}`,
      e.actors ? `${e.actors} actor${e.actors === 1 ? "" : "s"}` : "",
      span,
    ].filter(Boolean);
    out.push(
      `- ${e.name} — ${bits.join(", ")}${e.keys.length ? `; properties: ${e.keys.join(", ")}` : ""}`,
    );
  }
  out.push("");
  return out;
}

/* ------------------------- structural term matching ------------------------ */

/** Does a query term name this identifier token? Exact, plural-insensitive
 *  (the shared stem), or a ≥4-char prefix — so "views" reaches `page_viewed`
 *  and `SeatView` without "pay" reaching "payload". */
function termMatchesToken(term: string, token: string): boolean {
  const a = stemToken(term);
  const b = stemToken(token);
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

export interface StructuralTable {
  database: string;
  table: string;
  columns: string[];
}

/** What a term matched in the queryable surface, as display strings. */
export interface StructuralHit {
  term: string;
  matches: string[];
}

/**
 * Where a term the knowledge store never mentions DOES appear in the queryable
 * surface: table names, column names, and the derived event vocabulary. This is
 * find_context's fallback — the honest answer to "nothing is curated about
 * this" is not silence, it's "here is where that word lives in the data."
 *
 * Pure and model-free (I8). Access scoping is the caller's job: pass only the
 * schema and catalog this session may see.
 */
export function structuralMatches(
  terms: string[],
  tables: StructuralTable[],
  events: EventKind[],
  {
    maxPerTerm = 3,
    maxTerms = 3,
  }: { maxPerTerm?: number; maxTerms?: number } = {},
): StructuralHit[] {
  const out: StructuralHit[] = [];
  for (const term of terms) {
    const matches: string[] = [];
    for (const e of events) {
      if (tokenize(e.name).some((t) => termMatchesToken(term, t)))
        matches.push(`setoku.${EVENTS_TABLE} event_name='${e.name}'`);
      for (const k of e.keys) {
        if (tokenize(k).some((t) => termMatchesToken(term, t)))
          matches.push(`setoku.${EVENTS_TABLE} properties.${k} (${e.name})`);
      }
    }
    for (const t of tables) {
      if (tokenize(t.table).some((tok) => termMatchesToken(term, tok))) {
        matches.push(`${t.database}.${t.table}`);
        continue; // the table itself is the better pointer than its columns
      }
      for (const c of t.columns) {
        if (tokenize(c).some((tok) => termMatchesToken(term, tok)))
          matches.push(`${t.database}.${t.table}.${c}`);
      }
    }
    const deduped = [...new Set(matches)];
    if (deduped.length)
      out.push({ term, matches: deduped.slice(0, maxPerTerm) });
    if (out.length >= maxTerms) break;
  }
  return out;
}
