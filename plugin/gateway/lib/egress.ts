// SPDX-License-Identifier: Apache-2.0
/**
 * The box's own source-egress ledger + daily alert (follow-up to the
 * pg-mirror skip-unchanged work — the 2026-07 Supabase overage went unnoticed
 * for five days because nothing on the box watched what the mirror pulled).
 *
 * pg-mirror records the NDJSON bytes each reload streamed out of the business
 * DB in `setoku.pg_mirror_runs.bytes` — a close proxy for what hosted-Postgres
 * vendors meter as (billable) egress, and available on ANY vendor, no usage
 * API needed. This module reads that ledger for the /admin Sources page and
 * fires an `egress_alert` notification (lib/notify.ts, same webhook as every
 * activity notice) when today's total crosses the operator's threshold.
 *
 * The threshold lives in the store's kv table so the admin UI can change it at
 * runtime — it is a nudge knob, not authority (no data access changes, I9
 * untouched). Alerts dedup to at most one per UTC day, same kv pattern as the
 * deploy notice's `last_deployed_version`.
 */
import { loadConfig, resolveLakeUrl } from "./config";
import { runLakeQuery } from "./lake";
import { notifyActivity } from "./notify";
import { mintShareId, type KnowledgeStore } from "./store";

export interface EgressDay {
  day: string; // YYYY-MM-DD (UTC)
  bytes: number;
}

export interface EgressData {
  /** Present days in the last 30 (the ledger's TTL horizon is 90). */
  days: EgressDay[];
  todayBytes: number;
  /** null = alerts disabled. */
  thresholdBytes: number | null;
  /** True only when the ledger has actual entries. The runs table exists on
   *  EVERY lake box (initdb ships the schema), so "query succeeded" is not the
   *  test — an empty ledger on a mirror-less box must read "n/a", not a zero
   *  that looks like "no egress". */
  configured: boolean;
  /** The built-in "Mirror egress" app, when seeded and still live. */
  appId: string | null;
}

/** Default alert threshold. Generous on purpose: loud only when a box is on
 *  track to blow through a typical hosted-Postgres egress allowance (Supabase
 *  Pro includes 250 GB/mo ≈ 8 GB/day as of 2026-07 — re-verify before leaning
 *  on the number, I7). Operators tune or disable it on /admin/sources. */
export const DEFAULT_EGRESS_ALERT_BYTES = 10e9;

const KV_THRESHOLD = "egress_alert_bytes";
const KV_NOTIFIED = "egress_alert_notified_day";
const KV_APP_SEEDED = "egress_app_seeded";
const KV_APP_ID = "egress_app_id";

/** Current threshold in bytes, or null when alerts are disabled ("0"). An
 *  absent key means the operator never touched it → the default applies. */
export function egressThreshold(store: KnowledgeStore): number | null {
  const raw = store.getKv(KV_THRESHOLD);
  if (raw === null) return DEFAULT_EGRESS_ALERT_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Set (bytes > 0) or disable (null/0) the daily alert threshold. */
export function setEgressThreshold(store: KnowledgeStore, bytes: number | null): void {
  store.setKv(KV_THRESHOLD, bytes && bytes > 0 ? String(Math.round(bytes)) : "0");
}

const todayUTC = (): string => new Date().toISOString().slice(0, 10);

/** The built-in app's id, if it was seeded and hasn't been archived. Archiving
 *  is respected (returns null, and the seed guard never re-creates it) — the
 *  operator's delete is a decision, not a bug to heal. */
function liveEgressAppId(store: KnowledgeStore): string | null {
  const id = store.getKv(KV_APP_ID);
  if (!id) return null;
  const meta = store.getPublishedMeta(id);
  return meta && !meta.archivedAt ? id : null;
}

/** Daily egress totals from the ledger. Lake trouble or an absent/pre-bytes
 *  runs table degrades to configured:false — never throws. */
export async function gatherEgress(projectDir: string, store: KnowledgeStore): Promise<EgressData> {
  const out: EgressData = {
    days: [],
    todayBytes: 0,
    thresholdBytes: egressThreshold(store),
    configured: false,
    appId: liveEgressAppId(store),
  };
  const cfg = loadConfig(projectDir);
  if (!cfg.ok) return out;
  const lakeUrl = resolveLakeUrl(projectDir, cfg.config);
  if (!lakeUrl.ok) return out;
  try {
    const res = await runLakeQuery(
      lakeUrl.url,
      `SELECT toString(toDate(finished_at)) AS day, sum(bytes) AS bytes
       FROM setoku.pg_mirror_runs
       WHERE finished_at >= now() - INTERVAL 30 DAY
       GROUP BY day ORDER BY day`,
      { rowCap: 40, statementTimeoutMs: 8_000 },
    );
    out.days = (res.rows as Array<Record<string, unknown>>).map((r) => ({
      day: String(r.day),
      bytes: Number(r.bytes ?? 0),
    }));
    out.todayBytes = out.days.find((d) => d.day === todayUTC())?.bytes ?? 0;
    out.configured = out.days.length > 0;
  } catch {
    /* lake down, table absent, or bytes column not yet migrated — no ledger */
  }
  return out;
}

/**
 * Compare today's ledger total to the threshold and send at most one
 * egress_alert per UTC day. Every failure path degrades to "no alert" (the
 * ledger stays visible on /admin/sources regardless).
 */
async function maybeAlert(projectDir: string, store: KnowledgeStore, data: EgressData): Promise<void> {
  const threshold = data.thresholdBytes; // gatherEgress already read the knob
  if (threshold === null || !data.configured || data.todayBytes < threshold) return;
  const today = todayUTC();
  if (store.getKv(KV_NOTIFIED) === today) return;
  // Mark BEFORE sending (at-most-once): a repeating alert for the same day is
  // noise that trains the operator to ignore the channel; a lost one is
  // re-raised tomorrow if the egress persists. Same trade as the deploy notice.
  store.setKv(KV_NOTIFIED, today);
  const cfg = loadConfig(projectDir);
  await notifyActivity(projectDir, {
    kind: "egress_alert",
    day: today,
    bytes: data.todayBytes,
    thresholdBytes: threshold,
    box: cfg.ok ? (cfg.config.name ?? null) : null,
  });
}

/* ------------------------ the built-in app ------------------------ */

/** Panels of the built-in "Mirror egress" app. All clickhouse dialect against
 *  setoku.pg_mirror_runs — Setoku's OWN metadata, so the same app works on
 *  every mirrored box with zero tenant coupling. SQL returns decimal GB (the
 *  vendors' billing unit) so the template never does unit math. */
export const EGRESS_APP_PANELS = [
  {
    key: "today",
    title: "Pulled today",
    description: "Bytes the mirror streamed out of the business DB today (UTC)",
    sql: "SELECT round(sum(bytes)/1e9, 2) AS gb FROM setoku.pg_mirror_runs WHERE toDate(finished_at) = today()",
    dialect: "clickhouse" as const,
    metricId: null,
  },
  {
    key: "week",
    title: "Past 7 days",
    description: "Total mirror egress over the last 7 days",
    sql: "SELECT round(sum(bytes)/1e9, 2) AS gb FROM setoku.pg_mirror_runs WHERE finished_at >= now() - INTERVAL 7 DAY",
    dialect: "clickhouse" as const,
    metricId: null,
  },
  {
    key: "skip_rate",
    title: "Reloads skipped",
    description: "Share of mirror passes that verified a table unchanged and streamed nothing (7 days)",
    sql: "SELECT round(100 * countIf(status = 'unchanged') / greatest(countIf(status IN ('ok','unchanged')), 1), 1) AS pct FROM setoku.pg_mirror_runs WHERE finished_at >= now() - INTERVAL 7 DAY",
    dialect: "clickhouse" as const,
    metricId: null,
  },
  {
    key: "daily",
    title: "Daily egress",
    description: "GB pulled per day, last 30 days",
    sql: "SELECT toString(toDate(finished_at)) AS day, round(sum(bytes)/1e9, 3) AS gb FROM setoku.pg_mirror_runs WHERE finished_at >= now() - INTERVAL 30 DAY GROUP BY day ORDER BY day",
    dialect: "clickhouse" as const,
    metricId: null,
  },
  {
    key: "by_table",
    title: "By table",
    description: "Which tables cost the most egress over the last 7 days",
    sql: "SELECT source_table AS source, round(sum(bytes)/1e9, 2) AS gb, countIf(status = 'ok') AS reloads, countIf(status = 'unchanged') AS skips FROM setoku.pg_mirror_runs WHERE finished_at >= now() - INTERVAL 7 DAY GROUP BY source ORDER BY sum(bytes) DESC LIMIT 15",
    dialect: "clickhouse" as const,
    metricId: null,
  },
];

/** The app template — an HTML fragment (the frame supplies the skeleton) built
 *  entirely on the tested Setoku.* runtime. Single-series charts, neutral ink,
 *  the runtime's own default mark color: this ships with the product, so it
 *  stays out of arguments with whatever the user's real apps look like. */
export const EGRESS_APP_TEMPLATE = `<div style="font:13px system-ui;color:#5b6b7a;max-width:60em;margin-bottom:16px">What the Postgres mirror pulled out of the source database — the traffic hosted-Postgres vendors meter and bill as egress. Unchanged tables are verified and skipped, so a quiet day costs almost nothing.</div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-bottom:22px">
  <div id="today"></div>
  <div id="week"></div>
  <div id="skip_rate"></div>
</div>
<h3 style="font:600 13px system-ui;color:#5b6b7a;margin:0 0 6px">Daily egress · last 30 days</h3>
<div id="daily" style="margin-bottom:22px"></div>
<h3 style="font:600 13px system-ui;color:#5b6b7a;margin:0 0 6px">By table · last 7 days</h3>
<div id="by_table"></div>
<script>
var gbf = function (v) {
  v = Setoku.num(v); // GB in, per the panel SQL (3-decimal resolution = 1 MB)
  if (v === 0) return "0";
  if (v >= 10) return v.toFixed(0) + " GB";
  if (v >= 0.1) return v.toFixed(1) + " GB";
  return Math.max(1, Math.round(v * 1000)) + " MB";
};
Setoku.stat('today', 'today', { label: 'pulled today', value: 'gb', format: gbf });
Setoku.stat('week', 'week', { label: 'past 7 days', value: 'gb', format: gbf });
Setoku.stat('skip_rate', 'skip_rate', { label: 'reloads skipped · 7d', value: 'pct', format: 'pct' });
Setoku.line('daily', 'daily', { x: 'day', value: 'gb', format: gbf });
Setoku.table('by_table', 'by_table', {
  columns: ['source', 'gb', 'reloads', 'skips'],
  labels: { source: 'table', gb: 'egress', reloads: 'reloads', skips: 'skipped (unchanged)' },
  format: { gb: gbf, reloads: 'int', skips: 'int' }
});
</script>`;

/**
 * Seed the built-in "Mirror egress" app once, the first time the box actually
 * has a ledger (mirror running, at least one day recorded) — a non-mirror box
 * never grows the app. Ordinary team-visibility app from there on: it shows on
 * /admin like any other, and archiving it is respected (the kv guard never
 * re-seeds). Direct store write, not the MCP tool — this is the PRODUCT
 * shipping a default, not an agent publishing (I9 untouched: team-only, and
 * promotion to public stays a human admin action).
 */
export function ensureEgressApp(store: KnowledgeStore, data: EgressData): string | null {
  if (store.getKv(KV_APP_SEEDED) !== null) return liveEgressAppId(store);
  if (!data.configured || !data.days.length) return null;
  const id = mintShareId();
  // The app row FIRST, the one-shot guard after: a transient store failure
  // (SQLITE_BUSY, full disk) must throw out to the tick's catch and retry next
  // tick — stamping the guard first would burn the seed forever on a fluke.
  store.createPublished({
    id,
    title: "Mirror egress",
    body: EGRESS_APP_TEMPLATE,
    panels: EGRESS_APP_PANELS,
    refreshSeconds: 3600,
    createdBy: "setoku",
  });
  store.setKv(KV_APP_SEEDED, new Date().toISOString());
  store.setKv(KV_APP_ID, id);
  store.audit("setoku", "publish_app", { id, builtin: "egress" });
  return id;
}

/**
 * One watchdog beat: read the ledger once, seed the built-in app if it's time,
 * alert if today crossed the threshold. Wired to a coarse interval in http.ts;
 * a failure must never take anything else down with it.
 */
export async function egressTick(projectDir: string, store: KnowledgeStore): Promise<void> {
  try {
    // Nothing this tick could possibly do → skip the lake round-trip. (The
    // admin GET gathers its own data; this early-out only gates the watchdog.)
    if (egressThreshold(store) === null && store.getKv(KV_APP_SEEDED) !== null) return;
    const data = await gatherEgress(projectDir, store);
    ensureEgressApp(store, data);
    await maybeAlert(projectDir, store, data);
  } catch {
    /* best-effort watchdog */
  }
}
