// SPDX-License-Identifier: Apache-2.0
/**
 * Outbound activity notifications (issue #63).
 *
 * A best-effort, fire-and-forget side channel that announces box activity —
 * an app published or updated, a new Setoku version deployed — to a Slack
 * channel. Two hard rules:
 *
 *  1. A notification NEVER blocks or breaks the action it reports. A publish
 *     must succeed even if Slack is down or slow, so the send is detached
 *     (`void notifyActivity(...)`) and every failure is swallowed.
 *  2. The webhook URL is a secret resolved from an env-var NAME (see
 *     resolveNotifyWebhook), never a literal in config, so it never reaches the
 *     model — same discipline as the DB/lake URLs.
 *
 * Transport today is a single Slack-compatible incoming webhook (`POST {text}`,
 * the shape deploy/monitor/alert.sh already speaks). The event is modeled as a
 * transport-agnostic union so a future channel/connector (a different Slack
 * workspace, email, a webhook per event kind) can render the same events
 * differently without touching the call sites.
 */
import { loadConfig, resolveNotifyWebhook } from "./config";

/** An app was published for the first time. */
export interface AppPublishedEvent {
  kind: "app_published";
  title: string;
  /** Shareable link (may be a bare path when SETOKU_PUBLIC_URL is unset). */
  url: string;
  /** Identity that published it. */
  by: string;
  /** Live panel count (0 for a static report / state-only app). */
  panels: number;
}

/** An existing app was edited in place. */
export interface AppUpdatedEvent {
  kind: "app_updated";
  title: string;
  url: string;
  by: string;
  /** Which facets changed (title / content / data / inputs / refresh). */
  changed: string[];
  /** The author's human note on WHAT changed (update_app `message`), if given. */
  message?: string | null;
}

/** A new gateway version is now serving (fired once per version, on startup). */
export interface DeployEvent {
  kind: "deploy";
  version: string;
  /** The version this replaced (null on a box's very first boot — not sent). */
  previous: string | null;
  /** Human box name (config.name), for a multi-box channel. */
  box?: string | null;
}

/** The mirror pulled more from the business DB today than the operator's daily
 *  alert threshold — hosted-Postgres vendors meter this as (billable) egress.
 *  Fired at most once per UTC day (lib/egress.ts dedups via the kv store). */
export interface EgressAlertEvent {
  kind: "egress_alert";
  /** UTC day being reported (YYYY-MM-DD). */
  day: string;
  /** Bytes the mirror streamed out of the source DB so far today. */
  bytes: number;
  thresholdBytes: number;
  box?: string | null;
}

export type ActivityEvent = AppPublishedEvent | AppUpdatedEvent | DeployEvent | EgressAlertEvent;

/** How long we'll wait on the webhook before giving up — a notification must
 *  never keep a request (or shutdown) hanging on a slow Slack. */
const NOTIFY_TIMEOUT_MS = 5_000;

/** Human-readable list of what changed, for the update message. */
function changeSummary(changed: string[]): string {
  const clean = changed.filter(Boolean);
  return clean.length ? clean.join(", ") : "no visible fields";
}

/** Render an event as the Slack message text. Exported for tests and so a future
 *  transport can reuse the same phrasing. Kept plain-text (no Slack blocks) so it
 *  degrades cleanly to any `{text}` webhook. */
export function formatEvent(event: ActivityEvent): string {
  switch (event.kind) {
    case "app_published":
      return (
        `📊 *App published:* “${event.title}” by ${event.by}` +
        (event.panels ? ` — ${event.panels} live panel${event.panels === 1 ? "" : "s"}` : "") +
        `\n${event.url}`
      );
    case "app_updated": {
      const note = event.message?.trim();
      return (
        `✏️ *App updated:* “${event.title}” by ${event.by}` +
        (note ? `\n> ${note}` : "") +
        `\n_changed: ${changeSummary(event.changed)}_` +
        `\n${event.url}`
      );
    }
    case "deploy":
      return (
        `🚀 *Setoku ${event.box ? `(${event.box}) ` : ""}updated* to v${event.version}` +
        (event.previous ? ` (was v${event.previous})` : "")
      );
    case "egress_alert":
      return (
        `⚠️ *Setoku ${event.box ? `(${event.box}) ` : ""}mirror egress:* ` +
        `${formatGB(event.bytes)} pulled from the business database today (${event.day}) — ` +
        `over the ${formatGB(event.thresholdBytes)}/day alert threshold.` +
        `\n_Tune the mirror (interval, denyColumns) or the threshold on the admin Sources page._`
      );
  }
}

/** Decimal GB, the unit hosted-Postgres vendors bill egress in. */
export function formatGB(bytes: number): string {
  const gb = bytes / 1e9;
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

/**
 * Send an activity notification. Best-effort and detached: resolves the webhook
 * from config, and if none is configured returns immediately (notifications are
 * opt-in). Any transport error — no webhook, network failure, non-2xx, timeout —
 * is swallowed so the caller's real work is never affected. Callers `void` this;
 * it is not awaited on the hot path.
 */
export async function notifyActivity(projectDir: string, event: ActivityEvent): Promise<void> {
  try {
    const cfg = loadConfig(projectDir);
    if (!cfg.ok) return;
    const webhook = resolveNotifyWebhook(projectDir, cfg.config);
    if (!webhook) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), NOTIFY_TIMEOUT_MS);
    try {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: formatEvent(event) }),
        signal: ctl.signal,
      });
      // A misconfigured webhook (wrong URL, revoked hook) fails silently
      // otherwise — `fetch` resolves for a non-2xx. Give the operator a signal
      // WITHOUT the webhook URL (a secret) or the response body.
      if (!res.ok) console.error(`notify: webhook returned HTTP ${res.status} for a ${event.kind} event`);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // A notification must never break the action it reports (issue #63). The
    // error is NOT logged — a fetch failure message can echo the (secret)
    // webhook URL — so we surface only the event kind, not the transport error.
    console.error(`notify: could not deliver a ${event.kind} event (webhook unreachable or timed out)`);
  }
}
