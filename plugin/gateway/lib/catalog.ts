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
 * catalog, plus the column names, backs find_context's coverage check.
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
  /** Distinct event_ids — app_events is a ReplacingMergeTree fed by an
   *  at-least-once client, so a plain count() over-reports retried deliveries
   *  until parts merge. */
  count: number;
  /** Earliest / latest event time seen (lake timestamps, "YYYY-MM-DD hh:mm:ss"). */
  firstTs: string;
  lastTs: string;
  /** Distinct actors — 0 when the producer never sets one. */
  actors: number;
  /** Property keys, sampled from rows of this event (never exhaustive). */
  keys: string[];
}

/** The derived vocabulary plus the totals needed to describe it honestly. */
export interface EventCatalog {
  /** The most frequent kinds, capped at MAX_KINDS. */
  events: EventKind[];
  /** Distinct event_name values in the table — the TRUE count, which exceeds
   *  `events.length` when the catalog is truncated. */
  kinds: number;
  /** True when `events` is a top-N slice rather than the whole vocabulary. */
  truncated: boolean;
}

export const EMPTY_CATALOG: EventCatalog = {
  events: [],
  kinds: 0,
  truncated: false,
};

/** The lake table this catalog describes (the first-party events sink). */
export const EVENTS_TABLE = "app_events";
/** How many property keys we keep per event kind — enough to recognize the
 *  shape, short enough that a chatty payload can't dominate the tool output. */
const MAX_KEYS = 12;
/** Event kinds per catalog. More than this and `truncated` says so, rather than
 *  the slice quietly passing for the whole vocabulary. */
const MAX_KINDS = 40;
/** Producer-controlled strings (event names, property keys) are rendered into
 *  agent-facing text, so they are length-capped and stripped of control
 *  characters — a newline in an event name would otherwise let whoever holds an
 *  ingest token inject headings into gateway-authored guidance. */
const MAX_NAME_CHARS = 64;
const MAX_KEY_CHARS = 40;

const TTL_MS = 10 * 60_000;
interface Entry {
  at: number;
  catalog: EventCatalog;
  /** Did the last refresh actually reach the lake? A failed refresh keeps the
   *  previous vocabulary rather than blanking it (see refresh). */
  ok: boolean;
}
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<EventCatalog>>();

const keyFor = (lakeUrl: string, roles: string[] | null): string =>
  `${lakeUrl}|${(roles ?? []).join(",")}`;

/** Test hook — drop every cached catalog. */
export function clearCatalogCache(): void {
  cache.clear();
  inflight.clear();
}

/** Test hook — age every entry past its TTL, so the next read revalidates
 *  without waiting ten real minutes. Keeps the ENTRIES (unlike clear), which is
 *  the point: it exercises the refresh-over-existing-data path. */
export function expireCatalogCache(): void {
  for (const e of cache.values()) e.at = 0;
}

/** Strip control characters and cap length — applied to every producer-supplied
 *  string before it can reach a tool result. */
function clean(s: string, max: number): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The event vocabulary in the lake, most frequent first. EMPTY_CATALOG when the
 * table is absent, empty, denied to this session, or the lake is unreachable —
 * every caller treats the catalog as a bonus, never a precondition, so a
 * degraded lake costs detail and never an error.
 *
 * `maxWaitMs` bounds how long a COLD read may block. Callers on a latency-
 * sensitive path pass one so a slow lake can never stall the tool (they degrade
 * to no catalog, and the refresh lands for the next call).
 */
export async function eventCatalog(
  lakeUrl: string,
  opts: { statementTimeoutMs: number; maxWaitMs?: number },
  roles: string[] | null = null,
): Promise<EventCatalog> {
  const key = keyFor(lakeUrl, roles);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.catalog;

  let pending = inflight.get(key);
  if (!pending) {
    pending = refresh(lakeUrl, opts.statementTimeoutMs, roles, key).finally(
      () => {
        inflight.delete(key);
      },
    );
    inflight.set(key, pending);
  }
  if (hit) return hit.catalog; // stale-while-revalidate: serve it, refresh lands next
  if (opts.maxWaitMs == null) return pending;
  return Promise.race([
    pending,
    new Promise<EventCatalog>((resolve) =>
      setTimeout(() => resolve(EMPTY_CATALOG), opts.maxWaitMs),
    ),
  ]);
}

async function refresh(
  lakeUrl: string,
  statementTimeoutMs: number,
  roles: string[] | null,
  key: string,
): Promise<EventCatalog> {
  const prior = cache.get(key);
  let catalog: EventCatalog | null = null;
  try {
    // JSONExtractKeys runs on the groupArray SAMPLE (arrayMap over ≤10 collected
    // strings per kind), never per row — parsing every payload in the table just
    // to learn its key names would make this aggregate cost O(rows) JSON parses.
    // kinds_total is a scalar subquery over a LowCardinality column: cheap, and
    // the only way the summary can say "40 of 120" instead of implying 40 is all.
    const res = await runLakeQuery(
      lakeUrl,
      `SELECT event_name AS name,
              uniqExact(event_id) AS n,
              toString(min(ts)) AS first_ts,
              toString(max(ts)) AS last_ts,
              uniqExact(actor) AS actors,
              arrayDistinct(arrayFlatten(arrayMap(p -> JSONExtractKeys(p), groupArray(10)(properties)))) AS keys,
              (SELECT uniqExact(event_name) FROM setoku.${EVENTS_TABLE}) AS kinds_total
       FROM setoku.${EVENTS_TABLE}
       GROUP BY event_name
       ORDER BY n DESC
       LIMIT ${MAX_KINDS}`,
      { rowCap: MAX_KINDS + 1, statementTimeoutMs },
      {},
      roles,
    );
    const rows = res.rows as Array<Record<string, unknown>>;
    const events: EventKind[] = rows.map((r) => ({
      name: clean(String(r.name ?? ""), MAX_NAME_CHARS),
      count: Number(r.n ?? 0),
      firstTs: String(r.first_ts ?? ""),
      lastTs: String(r.last_ts ?? ""),
      actors: Number(r.actors ?? 0),
      keys: (Array.isArray(r.keys)
        ? r.keys.map((k) => clean(String(k), MAX_KEY_CHARS))
        : []
      )
        .filter(Boolean)
        .sort()
        .slice(0, MAX_KEYS),
    }));
    const kinds = Math.max(Number(rows[0]?.kinds_total ?? 0), events.length);
    catalog = { events, kinds, truncated: kinds > events.length };
  } catch {
    /* table absent / denied / lake down — `catalog` stays null, handled below */
  }
  // A FAILED refresh must not blank a good catalog: a transient blip would
  // otherwise make get_schema/list_sources report "no events" for a full TTL —
  // the exact wrong answer this whole file exists to prevent. Keep the previous
  // vocabulary and retry at the next TTL. (Access changes can't leak through
  // this: the cache key carries the session's roles, so a newly-denied identity
  // has a different key and starts empty.)
  const entry: Entry = catalog
    ? { at: Date.now(), catalog, ok: true }
    : { at: Date.now(), catalog: prior?.catalog ?? EMPTY_CATALOG, ok: false };
  cache.set(key, entry);
  return entry.catalog;
}

/** Date part of a lake timestamp ("2026-07-03 12:00:00.000" → "2026-07-03"). */
const day = (ts: string): string => ts.slice(0, 10);

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The one-line catalog for `list_sources` — appended to the events blurb so the
 * capability list names the actual events instead of the generic category.
 * Null when nothing has been emitted yet (the blurb stands alone).
 */
export function catalogSummary(cat: EventCatalog, maxKinds = 4): string | null {
  const { events } = cat;
  if (!events.length) return null;
  const shown = events
    .slice(0, maxKinds)
    .map((e) =>
      e.keys.length ? `${e.name} (${e.keys.slice(0, 4).join(", ")})` : e.name,
    )
    .join(", ");
  const more =
    events.length > maxKinds ? `, +${events.length - maxKinds} more` : "";
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
  const span = first && last ? `, ${day(first)} → ${day(last)}` : "";
  // Counts are only ever claimed for what was actually measured: when the
  // vocabulary is truncated, the event total covers the shown kinds alone.
  const sum = events.reduce((a, e) => a + e.count, 0);
  const totals = cat.truncated
    ? `${events.length} of ${cat.kinds} event kinds (${plural(sum, "event")} in those)`
    : `${plural(cat.kinds, "event kind")}, ${plural(sum, "event")}`;
  return `emits ${shown}${more} — ${totals}${span}`;
}

/**
 * The `get_schema` detail block — what the `properties String` column actually
 * contains, per event. Empty when there is no catalog to show.
 */
export function catalogDetail(cat: EventCatalog): string[] {
  if (!cat.events.length) return [];
  const out = [
    cat.truncated
      ? `event_name values — top ${cat.events.length} of ${cat.kinds} (derived from the data; property keys sampled, not exhaustive):`
      : `event_name values (derived from the data; property keys sampled, not exhaustive):`,
  ];
  for (const e of cat.events) {
    const span =
      e.firstTs && e.lastTs ? `${day(e.firstTs)} → ${day(e.lastTs)}` : "";
    const bits = [
      plural(e.count, "event"),
      e.actors ? plural(e.actors, "actor") : "",
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

/** Does a query term name this identifier token? Exact, plural-insensitive (the
 *  shared stem), or a ≥4-char prefix — so "views" reaches `page_viewed` and
 *  `SeatView` without "pay" reaching "payload". */
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
