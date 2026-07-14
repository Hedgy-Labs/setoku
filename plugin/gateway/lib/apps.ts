// SPDX-License-Identifier: Apache-2.0
/**
 * Live-app rendering. A app's panels are saved read-only queries the
 * box re-runs through the SAME governed path as run_query (the gateway's own
 * read-only lake role, caps, audit) — never a stored user token. Results are
 * cached per panel for the app's refresh TTL so a hammered public link
 * doesn't re-run every query on every hit, and the view carries an honest
 * "updated N ago" stamp.
 *
 * Shared by the publish dry-run (app.ts) and the HTTP render path (http.ts) so
 * there is one execution and one cache, not two.
 */
import { loadConfig, resolveLakeUrl, type SetokuConfig } from "./config";
import type { QueryOutcome } from "./db";
import { runLakeQuery } from "./lake";
import { lakeRolesFor } from "./sources";
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
/** Ceiling on the serialized panel-rows payload. The SOLE product bound on how many
 *  rows a panel renders: a panel keeps its full result set until its JSON hits this,
 *  then it's trimmed. Enforced in TWO places off this one number — per panel before
 *  it's cached (so the durable knowledge.db entry stays bounded, I4) and across all
 *  panels on the served copy (capRenderBytes) — so neither the injected frame nor the
 *  cached JSON can balloon regardless of the fetch ceiling × panel count. */
export const MAX_RENDER_ROW_BYTES = 3_500_000;
/** Memory backstop on rows pulled into the gateway for ONE panel render before we
 *  trim to MAX_RENDER_ROW_BYTES. NOT a product cap — the byte budget above is the
 *  real bound; this only stops a runaway panel (a wide `SELECT *` over a huge table)
 *  from materializing hundreds of MB and OOM-killing the gateway on a small box,
 *  since the trim happens post-fetch and SQL can't LIMIT by bytes. Held low enough
 *  that even KB-wide rows stay well under the box's memory, yet ~100× run_query's
 *  200-row model-context cap — no real dashboard panel renders 25k rows to a human,
 *  and for normal-width rows the 3.5MB byte budget bites first anyway. */
export const RENDER_FETCH_CEILING = 25_000;

/**
 * Whether a published body is a FULL HTML document vs a fragment the app runtime
 * wraps. Published apps are ALWAYS fragments — the runtime nests the body inside
 * its own `<!doctype>…<body>…</body></html>` skeleton, so a whole document nested
 * there renders wrong. publish_app / update_app use this to REJECT a full-doc body
 * up front (the one supported model is a fragment; the legacy raw-served "html"
 * format is gone). A real document OPENS with the doctype/`<html>` tag — possibly
 * behind a leading banner comment or `<?xml ?>` prolog. We skip that leading
 * whitespace/comment/prolog and then require the tag AT that position, so:
 *   - a fragment that merely CONTAINS `<html` elsewhere (a code snippet, a template
 *     string) is NOT misclassified as a document, and
 *   - a document that opens with `<!-- generated -->` or `<?xml ?>` before the
 *     doctype still IS one.
 * One definition shared by publish and update so they always agree.
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

// The gateway holds no business-Postgres credential: business tables are read
// via the biz.* ClickHouse mirror (pg-mirror is the only container that talks
// to the source DB). The postgres dialect survives on the wire for stored
// legacy panels, which surface this error until re-authored.
export const PG_RETIRED_ERROR =
  'The direct business-Postgres path is retired — business tables are read via the biz.* ClickHouse ' +
  'mirror (dialect:"clickhouse", e.g. biz.<table>). list_sources shows the mirrored tables and their ' +
  '"data as of"; get_schema describes their columns.';

/** Errored cache is retried sooner than a successful one — a transient DB blip
 *  shouldn't pin an error on screen for the whole refresh TTL. */
const ERROR_TTL_MS = 30_000;

/** Execute one panel's saved query through the governed read path — ClickHouse
 *  only (the lake + the biz.* mirror). Throws on a curator session reading the
 *  lake, a legacy postgres-dialect panel (retired path), an unconfigured lake,
 *  or a query error. */
export async function runPanel(
  projectDir: string,
  config: SetokuConfig,
  panel: AppPanel,
  compiled: CompiledPanel,
  opts: { denyLakeRead?: boolean; rowCap?: number; lakeRoles?: string[] | null } = {},
): Promise<QueryOutcome> {
  // The render path passes RENDER_FETCH_CEILING here so panels aren't held to
  // run_query's small model-context rowCap — rows go into a human-viewed iframe
  // bounded by MAX_RENDER_ROW_BYTES, not into the model. Absent (run_query, the
  // publish dry-run), it falls back to config.rowCap (the 200-row context cap).
  const caps = { rowCap: opts.rowCap ?? config.rowCap, statementTimeoutMs: config.statementTimeoutMs };
  if (panel.dialect !== "clickhouse") throw new Error(PG_RETIRED_ERROR);
  if (opts.denyLakeRead) throw new Error(LAKE_MEMBRANE_ERROR);
  const lake = resolveLakeUrl(projectDir, config);
  if (!lake.ok) throw new Error(lake.error);
  return runLakeQuery(lake.url, compiled.text, caps, compiled.chParams ?? {}, opts.lakeRoles ?? null);
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
  /** The served rows are a PREFIX of a larger result — either the render fetch
   *  ceiling was hit (rare) or capRenderBytes trimmed the panel to fit the
   *  payload budget. Drives the "showing first N rows" affordance; never silent. */
  truncated: boolean;
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
  opts: { denyLakeRead?: boolean; lakeRoles?: string[] | null; tryFreshRun?: () => boolean },
): boolean {
  const key = `${appId}:${cacheKey}:${opts.denyLakeRead ? 1 : 0}`;
  if (bgRefreshes.has(key)) return true;
  if (opts.tryFreshRun && !opts.tryFreshRun()) return false;
  const p = (async () => {
    const t0 = performance.now();
    try {
      const r = await runPanel(projectDir, config, panel, compiled, { denyLakeRead: opts.denyLakeRead, lakeRoles: opts.lakeRoles, rowCap: RENDER_FETCH_CEILING });
      // Trim to the payload budget before caching — keep the durable cache bounded
      // (see the blocking path in renderUncoalesced for why).
      const fit = trimRowsToBytes(r.rows, MAX_RENDER_ROW_BYTES);
      store.putPanelCache(appId, cacheKey, {
        columns: r.columns,
        rows: fit.rows,
        rowCount: fit.rows.length,
        truncated: r.truncated || fit.truncated,
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
  // Published panels run under the CREATOR's source access, never the viewer's:
  // the panel cache is shared per (app, panel, variant), so viewer-scoped
  // enforcement would either poison the cache or fork it per person — and,
  // decisive, creator-scoping is what closes the bypass where a source-denied
  // user publishes `SELECT * FROM setoku.slack_messages` and reads the render
  // (their publish/update dry-run runs under their own roles, so a denied panel
  // never reaches the store in the first place). The anchor is the CREATOR, not
  // "last editor": a later cosmetic edit (a title fix) by an unrestricted admin
  // must not silently re-scope a restricted creator's app to full access. A
  // newly-denied creator's panels fail refresh and serve stale-then-error,
  // which is honest and visible (refreshError in the frame chrome).
  const actor = (dash as { createdBy?: string }).createdBy ?? "";
  const lakeRoles = lakeRolesFor(store.sourceDenies(actor));
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
      const base = { key: panel.key, title: panel.title, dialect: panel.dialect, metricId: panel.metricId ?? null, truncated: false };
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
          return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, truncated: cached.truncated, computedAt: cached.computedAt, error: cached.error, durationMs: cached.durationMs };
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
          const running = startBackgroundRefresh(store, projectDir, config, dash.id, panel, compiled, cacheKey, { ...opts, lakeRoles });
          return running
            ? { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, truncated: cached.truncated, computedAt: cached.computedAt, error: null, refreshing: true, durationMs: cached.durationMs }
            : { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, truncated: cached.truncated, computedAt: cached.computedAt, error: null, refreshError: "refresh rate-limited — showing the last cached result", durationMs: cached.durationMs };
        }
        // About to run a fresh query — but the caller may cap fresh executions
        // (the public per-app budget). Charge ONLY here, on a real cache miss, so
        // cached hits are free. Over budget → serve the last good rows if we have
        // them (flagged stale), else a soft error, so a hammered public link with
        // open-domain params can't keep missing the cache and re-hitting prod.
        if (opts.tryFreshRun && !opts.tryFreshRun()) {
          if (cached && !cached.error)
            return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, truncated: cached.truncated, computedAt: cached.computedAt, error: null, refreshError: "refresh rate-limited — showing the last cached result" };
          return { ...base, columns: [], rows: [], rowCount: 0, computedAt: new Date(now).toISOString(), error: "Too many distinct queries on this link right now — try again shortly." };
        }
        // Keep last-good rows on a failed refresh ONLY while they're within the
        // stale ceiling; past that, the masked failure becomes a hard error.
        const keepLastGood = cached != null && !cached.error && now - Date.parse(cached.computedAt) < staleCeiling;
        if (!config) {
          const msg = cfg.ok ? "no config" : cfg.error;
          if (keepLastGood && cached)
            return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, truncated: cached.truncated, computedAt: cached.computedAt, error: null, refreshError: msg };
          return { ...base, columns: [], rows: [], rowCount: 0, computedAt: new Date(now).toISOString(), error: msg };
        }
        const t0 = performance.now();
        try {
          const r = await runPanel(projectDir, config, panel, compiled, { denyLakeRead: opts.denyLakeRead, lakeRoles, rowCap: RENDER_FETCH_CEILING });
          const durationMs = Math.round(performance.now() - t0);
          // Trim to the payload budget BEFORE caching so the durable knowledge.db
          // (I4) never stores more than MAX_RENDER_ROW_BYTES per entry — capRenderBytes
          // trims only the served copy, so without this the cache would keep the full
          // up-to-RENDER_FETCH_CEILING result. A warm hit then serves this bounded copy
          // and capRenderBytes early-returns (no re-serialization) unless co-panels overflow.
          const fit = trimRowsToBytes(r.rows, MAX_RENDER_ROW_BYTES);
          const truncated = r.truncated || fit.truncated;
          const computedAt = store.putPanelCache(dash.id, cacheKey, { columns: r.columns, rows: fit.rows, rowCount: fit.rows.length, truncated, error: null, durationMs });
          return { ...base, columns: r.columns, rows: fit.rows, rowCount: fit.rows.length, truncated, computedAt, error: null, durationMs };
        } catch (e) {
          const msg = (e as Error).message;
          const durationMs = Math.round(performance.now() - t0);
          if (keepLastGood && cached)
            return { ...base, columns: cached.columns, rows: cached.rows, rowCount: cached.rowCount, truncated: cached.truncated, computedAt: cached.computedAt, error: null, refreshError: msg, durationMs: cached.durationMs };
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

/** Largest row PREFIX whose serialized JSON fits `budget` bytes, plus whether we
 *  actually dropped any (so a partial result flags itself). Binary-searches the
 *  cut point; only called on an over-budget panel, so the common case never pays
 *  it. `budget <= 0` (a co-panel already filled the payload) yields no rows. */
export function trimRowsToBytes(
  rows: Record<string, unknown>[],
  budget: number,
): { rows: Record<string, unknown>[]; truncated: boolean } {
  if (budget <= 0) return { rows: [], truncated: rows.length > 0 };
  if (JSON.stringify(rows).length <= budget) return { rows, truncated: false };
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(rows.slice(0, mid)).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return { rows: rows.slice(0, lo), truncated: true };
}

/**
 * Bound the SERVED panel-rows payload (the injected frame + provenance) so it can't
 * balloon past MAX_RENDER_ROW_BYTES across all panels. Each panel is already trimmed
 * to the budget individually before caching (see renderUncoalesced), so this only
 * bites when SEVERAL panels together overflow. Allocates the budget MAX-MIN FAIRLY —
 * lightest-first, each panel may take an equal split of what's left, and a panel
 * under its share frees the remainder for the heavier ones — so every over-budget
 * panel is trimmed to a partial prefix rather than the single heaviest one vanishing
 * (a partial table, with its "showing first N" note, beats a dropped one). A panel is
 * dropped with an error only if its fair share can't hold even one row. Mutates the
 * shared RenderedPanel[] so the frame AND the provenance drawer agree.
 */
function capRenderBytes(panels: RenderedPanel[]): void {
  const sizes = panels.map((p) => JSON.stringify(p.rows).length);
  if (sizes.reduce((a, b) => a + b, 0) <= MAX_RENDER_ROW_BYTES) return;
  const order = panels.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  let remaining = MAX_RENDER_ROW_BYTES;
  let left = order.length;
  for (const i of order) {
    const share = Math.floor(remaining / left);
    left--;
    if (sizes[i] <= share) {
      remaining -= sizes[i]; // fits its fair share whole — surplus flows to the rest
      continue;
    }
    const p = panels[i];
    const { rows } = trimRowsToBytes(p.rows, share);
    if (rows.length === 0) {
      // Even one row won't fit this panel's share — nothing partial to show.
      p.error = p.error ?? `result too large to render (${p.rowCount} rows) — aggregate in the panel query`;
      p.rows = [];
      p.columns = [];
    } else {
      p.rows = rows;
      p.rowCount = rows.length;
      p.truncated = true;
    }
    remaining -= JSON.stringify(p.rows).length;
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
