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
import type { KnowledgeStore } from "./store";

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
  /** False when the lake is unreachable or the mirror never ran — the UI
   *  shows "no ledger" instead of a zero that reads as "no egress". */
  configured: boolean;
}

/** Default alert threshold. Generous on purpose: loud only when a box is on
 *  track to blow through a typical hosted-Postgres egress allowance (Supabase
 *  Pro includes 250 GB/mo ≈ 8 GB/day as of 2026-07 — re-verify before leaning
 *  on the number, I7). Operators tune or disable it on /admin/sources. */
export const DEFAULT_EGRESS_ALERT_BYTES = 10e9;

const KV_THRESHOLD = "egress_alert_bytes";
const KV_NOTIFIED = "egress_alert_notified_day";

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

/** Daily egress totals from the ledger. Lake trouble or an absent/pre-bytes
 *  runs table degrades to configured:false — never throws. */
export async function gatherEgress(projectDir: string, store: KnowledgeStore): Promise<EgressData> {
  const out: EgressData = { days: [], todayBytes: 0, thresholdBytes: egressThreshold(store), configured: false };
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
    out.configured = true;
  } catch {
    /* lake down, table absent, or bytes column not yet migrated — no ledger */
  }
  return out;
}

/**
 * Compare today's ledger total to the threshold and send at most one
 * egress_alert per UTC day. Wired to a coarse interval in http.ts — the whole
 * check is one small lake aggregate, and every failure path degrades to "no
 * alert" (the ledger stays visible on /admin/sources regardless).
 */
export async function checkEgressAlert(projectDir: string, store: KnowledgeStore): Promise<void> {
  try {
    const threshold = egressThreshold(store);
    if (threshold === null) return;
    const data = await gatherEgress(projectDir, store);
    if (!data.configured || data.todayBytes < threshold) return;
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
  } catch {
    /* an alert must never take anything else down with it */
  }
}
