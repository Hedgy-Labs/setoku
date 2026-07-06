// SPDX-License-Identifier: Apache-2.0
/**
 * Live-app rendering. A app's panels are saved read-only queries the
 * box re-runs through the SAME governed path as run_query (the gateway's own
 * read-only DB/lake role, caps, audit) — never a stored user token. Results are
 * cached per panel for the app's refresh TTL so a hammered public link
 * doesn't re-run every query on every hit, and the view carries an honest
 * "updated N ago" stamp.
 *
 * Shared by the publish dry-run (app.ts) and the HTTP render path (http.ts) so
 * there is one execution and one cache, not two.
 */
import { loadConfig, resolveDatabaseUrl, resolveLakeUrl, type SetokuConfig } from "./config";
import { runReadOnlyQuery, type QueryOutcome } from "./db";
import { runLakeQuery } from "./lake";
import {
  resolveParams,
  compilePostgres,
  compileClickhouse,
  paramsVariant,
  type AppParam,
  type ParamValue,
} from "./params";
import type { AppPanel, KnowledgeStore, PublishedReport } from "./store";

/** A panel's SQL compiled with its bound param values, ready to execute. */
export interface CompiledPanel {
  text: string;
  /** Postgres positional bind values ($1…$n). */
  values?: ParamValue[];
  /** ClickHouse param_<name> values. */
  chParams?: Record<string, string>;
  /** Param names this panel references (for the cache-variant key). */
  referenced: string[];
}

/** Default refresh TTL when an app doesn't declare one. */
export const DEFAULT_REFRESH_SECONDS = 300;
/** Floor on refresh TTL — guards the DB from a too-eager app. */
export const MIN_REFRESH_SECONDS = 30;
/** Ceiling on refresh TTL — a "live" link that never refreshes isn't live; cap
 *  it so cached data can't silently go stale for days behind a fresh-looking UI. */
export const MAX_REFRESH_SECONDS = 86_400;
/** Cap on panels per app — keeps one view's fan-out bounded. Loose on purpose
 *  (seeing how rich a single app wants to get); the real backstop is
 *  MAX_RENDER_ROW_BYTES, which bounds the payload regardless of panel count. */
export const MAX_PANELS = 100;
/** Ceiling on the serialized panel-rows payload handed to one render. Bounds the
 *  injected frame document + the cached/served JSON regardless of rowCap × panels. */
export const MAX_RENDER_ROW_BYTES = 3_500_000;

/**
 * Whether a published body is a FULL HTML document (legacy "html" format, served
 * as-is) vs a fragment the app runtime wraps. A real document OPENS with the
 * doctype/`<html>` tag — possibly behind a leading banner comment or `<?xml ?>`
 * prolog. We skip that leading whitespace/comment/prolog and then require the tag
 * AT that position, so:
 *   - a fragment that merely CONTAINS `<html` elsewhere (a code snippet, a template
 *     string) is NOT misclassified as a document, and
 *   - a document that opens with `<!-- generated -->` or `<?xml ?>` before the
 *     doctype still IS one.
 * One definition shared by publish, update, and render so they always agree.
 */
export function isFullDoc(body: string): boolean {
  let s = body.replace(/^\s+/, "");
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^<!--[\s\S]*?-->\s*/, "").replace(/^<\?xml\b[\s\S]*?\?>\s*/i, "");
  } while (s !== prev); // strip any run of leading comments / xml prologs
  return /^(?:<!doctype|<html[\s>])/i.test(s);
}

// One membrane gate, shared by run_query and app panel execution (I2/I9):
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
  panel: AppPanel,
  compiled: CompiledPanel,
  opts: { denyLakeRead?: boolean } = {},
): Promise<QueryOutcome> {
  if (panel.dialect === "clickhouse") {
    if (opts.denyLakeRead) throw new Error(LAKE_MEMBRANE_ERROR);
    const lake = resolveLakeUrl(projectDir, config);
    if (!lake.ok) throw new Error(lake.error);
    return runLakeQuery(lake.url, compiled.text, config, compiled.chParams ?? {});
  }
  const db = resolveDatabaseUrl(projectDir, config);
  if (!db.ok) throw new Error(db.error);
  return runReadOnlyQuery(db.url, compiled.text, config, compiled.values ?? []);
}

/** Compile a panel's `:name` tokens to engine placeholders + bound values, using
 *  the app's declared params and the resolved (viewer-or-default) values. Throws
 *  on a panel that references an undeclared param (caught per-panel at render). */
export function compilePanel(
  panel: AppPanel,
  declared: AppParam[],
  resolved: Map<string, ParamValue>,
): CompiledPanel {
  if (panel.dialect === "clickhouse") {
    const c = compileClickhouse(panel.sql, declared, resolved);
    return { text: c.text, chParams: c.chParams, referenced: c.referenced };
  }
  const c = compilePostgres(panel.sql, resolved);
  return { text: c.text, values: c.values, referenced: c.referenced };
}

/** One panel's data as handed to the template / provenance drawer. */
export interface RenderedPanel {
  key: string;
  title?: string;
  dialect: AppPanel["dialect"];
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
  /** Serving last-good rows past the refresh TTL while a background refresh
   *  runs (stale-while-revalidate) — the next view gets the fresh rows. */
  refreshing?: boolean;
  /** Wall-clock ms of the execution that produced the served rows (null on
   *  legacy cache rows). Telemetry for "which panel is slow". */
  durationMs?: number | null;
}

function ttlMs(dash: { refreshSeconds: number | null }): number {
  const s = Math.max(MIN_REFRESH_SECONDS, dash.refreshSeconds ?? DEFAULT_REFRESH_SECONDS);
  return s * 1000;
}

type RenderInput = PublishedReport | (Omit<PublishedReport, "body"> & { body?: string });

// In-flight render coalescing. A single app view hits two endpoints (the
// sandboxed /frame for rows + /data for provenance), and a popular public link
// fans many viewers at one moment; without this each would independently re-run
// every panel on a cold/expired cache. Concurrent NON-force renders of the same
// app share one execution; force renders are never shared.
const inFlight = new Map<string, Promise<RenderedPanel[]>>();

// In-flight BACKGROUND refreshes (stale-while-revalidate), keyed per panel
// variant so a burst of stale views triggers exactly one re-run each. Separate
// from `inFlight`: that coalesces whole-app renders a viewer is waiting on;
// these are fire-and-forget cache fills nobody awaits.
const bgRefreshes = new Map<string, Promise<void>>();

/** Await all currently-running background panel refreshes (test seam — lets a
 *  test observe the cache the refresh will fill without polling). */
export function flushBackgroundPanelRefreshes(): Promise<void> {
  return Promise.all([...bgRefreshes.values()]).then(() => undefined);
}

/** Kick a fire-and-forget refresh of one stale panel variant. Returns whether
 *  a refresh is actually running (started now, or already in flight) — false
 *  means the public per-app budget denied it, and the caller should say
 *  "rate-limited", not "refreshing". The budget is charged HERE, at actual
 *  execution — a background run is still a real query against prod. On failure
 *  the last-good cache row is left in place (parity with the blocking path's
 *  keepLastGood): its stamp keeps aging, so once it crosses the stale ceiling
 *  SWR stops applying and the blocking path surfaces the hard error instead of
 *  masking it forever. */
function startBackgroundRefresh(
  store: KnowledgeStore,
  projectDir: string,
  config: SetokuConfig,
  appId: string,
  panel: AppPanel,
  compiled: CompiledPanel,
  cacheKey: string,
  opts: { denyLakeRead?: boolean; tryFreshRun?: () => boolean },
): boolean {
  const key = `${appId}:${cacheKey}:${opts.denyLakeRead ? 1 : 0}`;
  if (bgRefreshes.has(key)) return true;
  if (opts.tryFreshRun && !opts.tryFreshRun()) return false;
  const p = (async () => {
    const t0 = performance.now();
    try {
      const r = await runPanel(projectDir, config, panel, compiled, { denyLakeRead: opts.denyLakeRead });
      store.putPanelCache(appId, cacheKey, {
        columns: r.columns,
        rows: r.rows,
        rowCount: r.rowCount,
        error: null,
        durationMs: Math.round(performance.now() - t0),
      });
    } catch {
      /* keep last-good — see above */
    }
  })().finally(() => bgRefreshes.delete(key));
  bgRefreshes.set(key, p);
  return true;
}

/**
 * Render every panel of an app, serving cached rows within the refresh TTL
 * and re-running stale ones. `force` bypasses the cache (manual refresh). A run
 * error keeps the last good rows when there are any (flagged via refreshError),
 * otherwise it surfaces as a hard panel error. Panels run concurrently, and
 * concurrent renders of the same app are coalesced.
 */
export function renderApp(
  store: KnowledgeStore,
  projectDir: string,
  dash: RenderInput,
  opts: {
    force?: boolean;
    denyLakeRead?: boolean;
    now?: number;
    rawParams?: Record<string, unknown>;
    /** Gate on EACH would-be fresh (cache-miss) panel execution: called right
     *  before a panel runs its query; returning false skips the run and serves
     *  cache-only (last good rows, else a soft "try later" error). The
     *  credential-free surface passes a per-app token bucket here so viewer-
     *  supplied params can't amplify load against prod without bound — and,
     *  because it's charged per ACTUAL execution, cached hits never spend budget. */
    tryFreshRun?: () => boolean;
  } = {},
): Promise<RenderedPanel[]> {
  if (!(dash.panels ?? []).length) return Promise.resolve([]);
  // Resolve declared inputs once (viewer value when coercible, else default).
  const declared = dash.params ?? [];
  const resolved = resolveParams(declared, opts.rawParams ?? {});
  // Key includes denyLakeRead, the fresh-run mode, AND a hash of the resolved
  // params so two callers in different membrane modes / budgets / with different
  // inputs never share one execution.
  const pv = paramsVariant(declared.map((p) => p.name), resolved);
  // The budget flag is part of the key so a budgeted (public) render never shares
  // an execution with a non-budgeted (admin/dry-run) one.
  const key = `${dash.id}:${opts.force ? 1 : 0}:${opts.denyLakeRead ? 1 : 0}:${opts.tryFreshRun ? 1 : 0}:${pv}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = renderUncoalesced(store, projectDir, dash, resolved, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function renderUncoalesced(
  store: KnowledgeStore,
  projectDir: string,
  dash: RenderInput,
  resolved: Map<string, ParamValue>,
  opts: { force?: boolean; denyLakeRead?: boolean; now?: number; tryFreshRun?: () => boolean },
): Promise<RenderedPanel[]> {
  const panels = dash.panels ?? [];
  const declared = dash.params ?? [];
  const cfg = loadConfig(projectDir);
  const config = cfg.ok ? cfg.config : null;
  const now = opts.now ?? Date.now();
  const limit = ttlMs(dash);
  // How long we'll keep serving last-good rows while refreshes fail before we
  // stop masking it and surface a hard error — a permanently-broken query (a
  // dropped column) must not show trustworthy-looking numbers forever.
  const staleCeiling = Math.max(limit * 4, 30 * 60_000);

  // Independent panels run concurrently — total latency is the slowest query,
  // not the sum (Promise.all preserves order). Every branch is wrapped so a
  // panel (incl. a cache-I/O hiccup) can NEVER reject the shared coalesced
  // promise and fan a 500 out to every concurrent viewer of this app.
  const rendered = await Promise.all(
    panels.map(async (panel): Promise<RenderedPanel> => {
      const base = { key: panel.key, title: panel.title, dialect: panel.dialect, metricId: panel.metricId ?? null };
      try {
        // Compile + bind first (throws on an undeclared :param → caught below as a
        // panel error). The cache key folds in the param VARIANT so different
        // inputs cache separately; a param-less panel keeps its bare key.
        const compiled = compilePanel(panel, declared, resolved);
        const variant = paramsVariant(compiled.referenced, resolved);
        const cacheKey = variant ? `${panel.key}::${variant}` : panel.key;
        const cached = store.getPanelCache(dash.id, cacheKey);
        // An errored cache row is retried sooner than the full refresh TTL.
        const cacheLimit = cached?.error ? Math.min(ERROR_TTL_MS, limit) : limit;
        const fresh = !opts.force && cached != null && now - Date.parse(cached.computedAt) < cacheLimit;
        if (fresh && cached) {
          return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, computedAt: cached.computedAt, error: cached.error, durationMs: cached.durationMs };
        }
        // Stale-while-revalidate: past the TTL but holding last-good rows within
        // the stale ceiling, serve them IMMEDIATELY (their real computedAt keeps
        // the "updated N ago" stamp honest) and refresh in the background — the
        // viewer never waits out a cold query they didn't ask for. `force` skips
        // this (a manual refresh is the one place the user asked to wait), an
        // errored cache row has no good rows to serve, and past the ceiling we
        // fall through to the blocking path so a permanently-broken query can't
        // hide behind ever-older rows.
        if (!opts.force && cached != null && !cached.error && config != null && now - Date.parse(cached.computedAt) < staleCeiling) {
          const running = startBackgroundRefresh(store, projectDir, config, dash.id, panel, compiled, cacheKey, opts);
          return running
            ? { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, computedAt: cached.computedAt, error: null, refreshing: true, durationMs: cached.durationMs }
            : { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, computedAt: cached.computedAt, error: null, refreshError: "refresh rate-limited — showing the last cached result", durationMs: cached.durationMs };
        }
        // About to run a fresh query — but the caller may cap fresh executions
        // (the public per-app budget). Charge ONLY here, on a real cache miss, so
        // cached hits are free. Over budget → serve the last good rows if we have
        // them (flagged stale), else a soft error, so a hammered public link with
        // open-domain params can't keep missing the cache and re-hitting prod.
        if (opts.tryFreshRun && !opts.tryFreshRun()) {
          if (cached && !cached.error)
            return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, computedAt: cached.computedAt, error: null, refreshError: "refresh rate-limited — showing the last cached result" };
          return { ...base, columns: [], rows: [], rowCount: 0, computedAt: new Date(now).toISOString(), error: "Too many distinct queries on this link right now — try again shortly." };
        }
        // Keep last-good rows on a failed refresh ONLY while they're within the
        // stale ceiling; past that, the masked failure becomes a hard error.
        const keepLastGood = cached != null && !cached.error && now - Date.parse(cached.computedAt) < staleCeiling;
        if (!config) {
          const msg = cfg.ok ? "no config" : cfg.error;
          if (keepLastGood && cached)
            return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, computedAt: cached.computedAt, error: null, refreshError: msg };
          return { ...base, columns: [], rows: [], rowCount: 0, computedAt: new Date(now).toISOString(), error: msg };
        }
        const t0 = performance.now();
        try {
          const r = await runPanel(projectDir, config, panel, compiled, { denyLakeRead: opts.denyLakeRead });
          const durationMs = Math.round(performance.now() - t0);
          const computedAt = store.putPanelCache(dash.id, cacheKey, { columns: r.columns, rows: r.rows, rowCount: r.rowCount, error: null, durationMs });
          return { ...base, columns: r.columns, rows: r.rows, rowCount: r.rowCount, computedAt, error: null, durationMs };
        } catch (e) {
          const msg = (e as Error).message;
          const durationMs = Math.round(performance.now() - t0);
          if (keepLastGood && cached)
            return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, computedAt: cached.computedAt, error: null, refreshError: msg, durationMs: cached.durationMs };
          const computedAt = store.putPanelCache(dash.id, cacheKey, { columns: [], rows: [], rowCount: 0, error: msg, durationMs });
          return { ...base, columns: [], rows: [], rowCount: 0, computedAt, error: msg, durationMs };
        }
      } catch (e) {
        // Last resort (e.g. cache read/write threw) — isolate to this panel.
        return { ...base, columns: [], rows: [], rowCount: 0, computedAt: new Date(now).toISOString(), error: (e as Error).message };
      }
    }),
  );
  capRenderBytes(rendered);
  return rendered;
}

/**
 * Bound the serialized panel-rows payload so the injected frame and the cached
 * JSON can't balloon past MAX_RENDER_ROW_BYTES (rowCap × MAX_PANELS could). Drop
 * the heaviest panels' rows first and mark them errored — applied to the shared
 * RenderedPanel[] so the frame AND the provenance drawer agree. Sizes are
 * computed once (no re-serialization per comparison).
 */
function capRenderBytes(panels: RenderedPanel[]): void {
  const sizes = panels.map((p) => JSON.stringify(p.rows).length);
  let total = sizes.reduce((a, b) => a + b, 0);
  if (total <= MAX_RENDER_ROW_BYTES) return;
  for (const i of panels.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a])) {
    if (total <= MAX_RENDER_ROW_BYTES) break;
    total -= sizes[i];
    panels[i].error = panels[i].error ?? `result too large to render (${panels[i].rowCount} rows) — aggregate in the panel query`;
    panels[i].rows = [];
    panels[i].columns = [];
  }
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
