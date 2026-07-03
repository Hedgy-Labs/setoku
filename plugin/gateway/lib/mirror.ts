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
 * Everything here is best-effort advisory metadata: one cached lake query, and
 * a box without the mirror (or with the lake down) degrades to "no mirror" —
 * never an error on the caller's path.
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
let cache: { at: number; url: string; tables: MirroredTable[] } | null = null;

/** Currently-mirrored tables with per-table freshness. Cached ~60 s so the
 *  render/query hot paths never add more than a rare, small lake read; [] when
 *  the mirror (or the lake) isn't there. */
export async function mirroredTables(lakeUrl: string): Promise<MirroredTable[]> {
  if (cache && cache.url === lakeUrl && Date.now() - cache.at < TTL_MS) return cache.tables;
  let tables: MirroredTable[] = [];
  try {
    // Only tables that still exist in biz count — pg_mirror_runs keeps history
    // for pruned tables, which must not resurrect steering hints.
    const res = await runLakeQuery(
      lakeUrl,
      `SELECT r.target_table AS target, anyLast(r.source_table) AS source, toString(max(r.finished_at)) AS as_of
       FROM setoku.pg_mirror_runs AS r
       WHERE r.status = 'ok' AND r.target_table IN (SELECT name FROM system.tables WHERE database = 'biz')
       GROUP BY r.target_table`,
      { rowCap: 500, statementTimeoutMs: 5_000 },
    );
    tables = res.rows.map((r) => ({
      target: String(r.target),
      source: String(r.source),
      asOf: lakeTsToIso(String(r.as_of)),
    }));
  } catch {
    /* no mirror on this box / lake unreachable — degrade to "no mirror" */
  }
  cache = { at: Date.now(), url: lakeUrl, tables };
  return tables;
}

/** Test hook. */
export function clearMirrorCache(): void {
  cache = null;
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
 *  backtick-tolerant). Purely for the freshness stamp — never access control. */
export function referencedBizTables(sql: string, tables: MirroredTable[]): string[] {
  const lower = sql.toLowerCase();
  return tables.filter((t) => {
    const name = t.target.toLowerCase();
    return (
      lower.includes(`biz.${name}`) ||
      lower.includes(`biz.\`${name}\``) ||
      lower.includes(`\`biz\`.\`${name}\``)
    );
  }).map((t) => t.target);
}
