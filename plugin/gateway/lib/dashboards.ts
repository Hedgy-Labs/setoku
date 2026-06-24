// SPDX-License-Identifier: Apache-2.0
/**
 * Live-dashboard rendering. A dashboard's panels are saved read-only queries the
 * box re-runs through the SAME governed path as run_query (the gateway's own
 * read-only DB/lake role, caps, audit) — never a stored user token. Results are
 * cached per panel for the dashboard's refresh TTL so a hammered public link
 * doesn't re-run every query on every hit, and the view carries an honest
 * "updated N ago" stamp.
 *
 * Shared by the publish dry-run (app.ts) and the HTTP render path (http.ts) so
 * there is one execution and one cache, not two.
 */
import { loadConfig, resolveDatabaseUrl, resolveLakeUrl, type SetokuConfig } from "./config";
import { runReadOnlyQuery, type QueryOutcome } from "./db";
import { runLakeQuery } from "./lake";
import type { DashboardPanel, KnowledgeStore, PublishedReport } from "./store";

/** Default refresh TTL when a dashboard doesn't declare one. */
export const DEFAULT_REFRESH_SECONDS = 300;
/** Floor on refresh TTL — guards the DB from a too-eager dashboard. */
export const MIN_REFRESH_SECONDS = 30;
/** Cap on panels per dashboard — keeps one view's fan-out bounded. */
export const MAX_PANELS = 12;

// One membrane gate, shared by run_query and dashboard panel execution (I2/I9):
// a session that can commit curated knowledge must not read the untrusted bulk
// text in the lake. Reads cleanly for either caller.
export const LAKE_MEMBRANE_ERROR =
  "This is a curator session — reading the lake (clickhouse dialect) is disabled here so a session " +
  "that can commit curated knowledge can't ingest untrusted bulk text (the I2/I9 membrane). Use an " +
  "analyst connector to query the lake.";

/** Errored cache is retried sooner than a successful one — a transient DB blip
 *  shouldn't pin an error on screen for the whole refresh TTL. */
const ERROR_TTL_MS = 30_000;

/** Execute one panel's saved query through the governed read path. Throws on a
 *  curator session reading the lake, an unconfigured source, or a query error. */
export async function runPanel(
  projectDir: string,
  config: SetokuConfig,
  panel: DashboardPanel,
  opts: { denyLakeRead?: boolean } = {},
): Promise<QueryOutcome> {
  if (panel.dialect === "clickhouse") {
    if (opts.denyLakeRead) throw new Error(LAKE_MEMBRANE_ERROR);
    const lake = resolveLakeUrl(projectDir, config);
    if (!lake.ok) throw new Error(lake.error);
    return runLakeQuery(lake.url, panel.sql, config);
  }
  const db = resolveDatabaseUrl(projectDir, config);
  if (!db.ok) throw new Error(db.error);
  return runReadOnlyQuery(db.url, panel.sql, config);
}

/** One panel's data as handed to the template / provenance drawer. */
export interface RenderedPanel {
  key: string;
  title?: string;
  dialect: DashboardPanel["dialect"];
  metricId?: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** When the served rows were computed (cache or fresh run). */
  computedAt: string;
  /** A hard error with no prior good data to fall back to. */
  error: string | null;
  /** A refresh failed but we're serving the last good rows (transient blip). */
  refreshError?: string | null;
}

function ttlMs(dash: { refreshSeconds: number | null }): number {
  const s = Math.max(MIN_REFRESH_SECONDS, dash.refreshSeconds ?? DEFAULT_REFRESH_SECONDS);
  return s * 1000;
}

type RenderInput = PublishedReport | (Omit<PublishedReport, "body"> & { body?: string });

// In-flight render coalescing. A single dashboard view hits two endpoints (the
// sandboxed /frame for rows + /data for provenance), and a popular public link
// fans many viewers at one moment; without this each would independently re-run
// every panel on a cold/expired cache. Concurrent NON-force renders of the same
// dashboard share one execution; force renders are never shared.
const inFlight = new Map<string, Promise<RenderedPanel[]>>();

/**
 * Render every panel of a dashboard, serving cached rows within the refresh TTL
 * and re-running stale ones. `force` bypasses the cache (manual refresh). A run
 * error keeps the last good rows when there are any (flagged via refreshError),
 * otherwise it surfaces as a hard panel error. Panels run concurrently, and
 * concurrent renders of the same dashboard are coalesced.
 */
export function renderDashboard(
  store: KnowledgeStore,
  projectDir: string,
  dash: RenderInput,
  opts: { force?: boolean; denyLakeRead?: boolean; now?: number } = {},
): Promise<RenderedPanel[]> {
  if (!(dash.panels ?? []).length) return Promise.resolve([]);
  const key = `${dash.id}:${opts.force ? 1 : 0}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = renderUncoalesced(store, projectDir, dash, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function renderUncoalesced(
  store: KnowledgeStore,
  projectDir: string,
  dash: RenderInput,
  opts: { force?: boolean; denyLakeRead?: boolean; now?: number },
): Promise<RenderedPanel[]> {
  const panels = dash.panels ?? [];
  const cfg = loadConfig(projectDir);
  const config = cfg.ok ? cfg.config : null;
  const now = opts.now ?? Date.now();
  const limit = ttlMs(dash);

  // Independent panels run concurrently — total latency is the slowest query,
  // not the sum (Promise.all preserves order).
  return Promise.all(
    panels.map(async (panel): Promise<RenderedPanel> => {
      const base = { key: panel.key, title: panel.title, dialect: panel.dialect, metricId: panel.metricId ?? null };
      const cached = store.getPanelCache(dash.id, panel.key);
      // An errored cache row is retried sooner than the full refresh TTL.
      const cacheLimit = cached?.error ? Math.min(ERROR_TTL_MS, limit) : limit;
      const fresh = !opts.force && cached != null && now - Date.parse(cached.computedAt) < cacheLimit;
      if (fresh && cached) {
        return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, computedAt: cached.computedAt, error: cached.error };
      }
      if (!config) {
        // Config gone (env/DB unconfigured) — surface it without failing the whole render.
        const msg = cfg.ok ? "no config" : cfg.error;
        if (cached && !cached.error) {
          return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, computedAt: cached.computedAt, error: null, refreshError: msg };
        }
        return { ...base, columns: [], rows: [], rowCount: 0, computedAt: new Date(now).toISOString(), error: msg };
      }
      try {
        const r = await runPanel(projectDir, config, panel, { denyLakeRead: opts.denyLakeRead });
        const computedAt = store.putPanelCache(dash.id, panel.key, { columns: r.columns, rows: r.rows, rowCount: r.rowCount, error: null });
        return { ...base, columns: r.columns, rows: r.rows, rowCount: r.rowCount, computedAt, error: null };
      } catch (e) {
        const msg = (e as Error).message;
        if (cached && !cached.error) {
          // Keep showing the last good data; flag the failed refresh.
          return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, computedAt: cached.computedAt, error: null, refreshError: msg };
        }
        const computedAt = store.putPanelCache(dash.id, panel.key, { columns: [], rows: [], rowCount: 0, error: msg });
        return { ...base, columns: [], rows: [], rowCount: 0, computedAt, error: msg };
      }
    }),
  );
}

/** The freshest "computed at" across panels (for the shell's "updated N ago"). */
export function newestComputedAt(panels: RenderedPanel[]): string | null {
  let best: number | null = null;
  for (const p of panels) {
    const t = Date.parse(p.computedAt);
    if (!Number.isNaN(t) && (best == null || t > best)) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}
