// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway-side view of the business-DB mirror (ingest/pg-mirror, issue #47).
 * Reads `setoku.pg_mirror_runs` to learn which tables are mirrored into
 * `biz.*` and how fresh each copy is ("data as of" = the table's last
 * successful reload). Feeds:
 *   - the run_query / publish-time steering ("this table is mirrored — use the
 *     mirror"),
 *   - the mirror "as of" stamp on /healthz and the app frame chrome.
 *
 * Two consumers with different stakes share this cache:
 *   - HOT paths (run_query steering/gate, healthz, the app-chrome stamp) use
 *     the stale-while-revalidate read — bounded latency, degrades to "no
 *     mirror" on a lake blip (a missed gate on an ad-hoc query is transient).
 *   - The PUBLISH gate (prepPanels) passes {fresh:true}: a panel is a durable,
 *     repeating query, so it's worth an actual lake round-trip to know the
 *     real mirror set rather than trusting a cold or negative cache.
 * A lake that is genuinely down still degrades to "no mirror" — publishing
 * postgres panels is then the only thing that can work at all.
 */
import { runLakeQuery } from "./lake";

export interface MirroredTable {
  /** ClickHouse-side name (query as biz.<target>). */
  target: string;
  /** Source pg table, schema-qualified (e.g. "ticketing.seat_txn"). */
  source: string;
  /** Last successful reload (ISO, UTC) — the copy's "data as of". */
  asOf: string;
}

/** Lake timestamp ("2026-07-03 12:00:00.000", UTC) → ISO string. */
const lakeTsToIso = (s: string): string => {
  let t = s.includes("T") ? s : s.replace(" ", "T");
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(t)) t += "Z";
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? s : new Date(ms).toISOString();
};

const TTL_MS = 60_000;
/** How long a COLD-cache caller waits for the first lake read before giving up
 *  with "no mirror". Everything downstream is advisory chrome/nudges, so a
 *  degraded lake must never stall run_query/healthz/the public data poll —
 *  those paths were lake-free before the mirror existed. */
const COLD_WAIT_MS = 1_000;
let cache: { at: number; url: string; tables: MirroredTable[] } | null = null;
let inflight: Promise<MirroredTable[]> | null = null;

let lastRefreshErred = false;

async function refresh(lakeUrl: string): Promise<MirroredTable[]> {
  let tables: MirroredTable[] = [];
  lastRefreshErred = false;
  try {
    // Only tables that still exist in biz count — pg_mirror_runs keeps history
    // for pruned tables, which must not resurrect steering hints. 'unchanged'
    // runs are verified-fresh checks (the source provably didn't move since
    // the last reload, so no restream) — they advance "as of" like a reload.
    const res = await runLakeQuery(
      lakeUrl,
      `SELECT r.target_table AS target, anyLast(r.source_table) AS source, toString(max(r.finished_at)) AS as_of
       FROM setoku.pg_mirror_runs AS r
       WHERE r.status IN ('ok', 'unchanged') AND r.target_table IN (SELECT name FROM system.tables WHERE database = 'biz')
       GROUP BY r.target_table`,
      { rowCap: 500, statementTimeoutMs: 5_000 },
    );
    tables = res.rows.map((r) => ({
      target: String(r.target),
      source: String(r.source),
      asOf: lakeTsToIso(String(r.as_of)),
    }));
  } catch {
    /* no mirror on this box / lake unreachable — degrade to "no mirror"
       (negative-cached for a TTL so a down lake isn't re-probed per call) */
    lastRefreshErred = true;
  }
  cache = { at: Date.now(), url: lakeUrl, tables };
  return tables;
}

/** Currently-mirrored tables with per-table freshness; [] when the mirror (or
 *  the lake) isn't there.
 *
 *  Default (hot paths): stale-while-revalidate — an expired cache answers
 *  immediately while one shared refresh updates it in the background, and a
 *  cold cache waits at most COLD_WAIT_MS, so callers never inherit the lake's
 *  latency.
 *
 *  {fresh:true} (the publish gate): a fresh or known-good cached answer, or a
 *  full awaited refresh — a cold cache, an expired cache, or a negative cache
 *  from an earlier error never silently disables a durable-artifact gate. */
export async function mirroredTables(lakeUrl: string, opts: { fresh?: boolean } = {}): Promise<MirroredTable[]> {
  if (cache && cache.url !== lakeUrl) cache = null;
  const cacheFresh = cache != null && Date.now() - cache.at < TTL_MS;
  if (cacheFresh && (!opts.fresh || cache!.tables.length > 0 || !lastRefreshErred)) return cache!.tables;
  if (!inflight) {
    inflight = refresh(lakeUrl).finally(() => {
      inflight = null;
    });
  }
  if (opts.fresh) return inflight; // publish is rare and not latency-critical — wait for truth
  if (cache) return cache.tables; // stale — serve it, the refresh lands for the next caller
  return Promise.race([
    inflight,
    new Promise<MirroredTable[]>((resolve) => setTimeout(() => resolve([]), COLD_WAIT_MS)),
  ]);
}

/** Test hook. */
export function clearMirrorCache(): void {
  cache = null;
  inflight = null;
}

/** The honest "data as of" for a set of biz tables: the OLDEST fresh copy among
 *  the ones referenced (an app is only as current as its stalest input). Null
 *  when none are referenced/mirrored. */
export function mirrorAsOf(tables: MirroredTable[], referencedTargets?: string[]): string | null {
  const pool = referencedTargets?.length
    ? tables.filter((t) => referencedTargets.includes(t.target))
    : tables;
  if (!pool.length) return null;
  return pool.map((t) => t.asOf).sort()[0];
}

/** biz.<target> references in a panel's clickhouse SQL (case-insensitive,
 *  backtick-tolerant, boundary-checked so biz.orders never claims
 *  biz.orders_archive). Purely for the freshness stamp — never access control. */
export function referencedBizTables(sql: string, tables: MirroredTable[]): string[] {
  return tables
    .filter((t) => {
      const n = t.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:\\bbiz|\`biz\`)\\.(?:\`${n}\`|${n}(?![\\w$]))`, "i").test(sql);
    })
    .map((t) => t.target);
}
