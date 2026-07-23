// SPDX-License-Identifier: Apache-2.0
/**
 * In-process pub/sub for "this app's content changed" — the push behind the
 * viewer's live edit-refresh (SSE). An agent iterating on an app (update_app)
 * while a human watches it in the browser shouldn't need a hand-reload: the
 * mutation paths emit here, and every open /admin/api/app_events stream for
 * that app forwards the nudge to its browser, which re-fetches through the
 * normal (session-gated, cache-bounded) render path.
 *
 * The event itself carries NO app content — it's a wake-up, not a data channel,
 * so it can't leak anything the subscriber couldn't already fetch. In-process
 * only (module state), which is exactly right for the single-gateway box (I6):
 * every mutation and every subscriber lives in this one process.
 */

/** Change kinds a subscriber may want to distinguish (all trigger a refetch). */
export type AppEventKind = "updated" | "restored" | "renamed";

type Subscriber = (kind: AppEventKind) => void;

const subscribers = new Map<string, Set<Subscriber>>();

/** Total concurrent subscriptions across all apps — a backstop so an SSE-holding
 *  client bug (or a reconnect storm) can't grow unbounded per-connection state.
 *  Team boxes see a handful of open app tabs; hitting this means something is
 *  wrong, and the denied client just falls back to non-live viewing. */
export const MAX_APP_EVENT_SUBSCRIBERS = 200;
/** Sub-cap for ANONYMOUS (demo-viewer) subscriptions. The demo box grants the
 *  stream without a login, so without this an unauthenticated script holding
 *  MAX sockets (the heartbeat keeps them alive) would permanently 503 every
 *  signed-in session's live refresh box-wide. Viewers exhaust only their own
 *  pool; sessions always have the remainder reserved. */
export const MAX_VIEWER_EVENT_SUBSCRIBERS = 100;

let total = 0;
let viewerTotal = 0;

/** Subscribe to change events for one app. `session` is whether the caller
 *  holds a real signed-in session (an anonymous demo viewer does not — it draws
 *  from the smaller viewer pool). Returns an unsubscribe function, or null when
 *  the applicable cap is reached (caller degrades gracefully to non-live). */
export function subscribeAppEvents(
  appId: string,
  fn: Subscriber,
  opts: { session: boolean } = { session: true },
): (() => void) | null {
  if (total >= MAX_APP_EVENT_SUBSCRIBERS) return null;
  if (!opts.session && viewerTotal >= MAX_VIEWER_EVENT_SUBSCRIBERS) return null;
  let set = subscribers.get(appId);
  if (!set) {
    set = new Set();
    subscribers.set(appId, set);
  }
  set.add(fn);
  total++;
  if (!opts.session) viewerTotal++;
  return () => {
    if (!set.delete(fn)) return; // idempotent — double-unsubscribe must not skew the counts
    total--;
    if (!opts.session) viewerTotal--;
    if (set.size === 0) subscribers.delete(appId);
  };
}

/** Notify every open stream for this app. Fire-and-forget: a subscriber that
 *  throws (a torn-down socket) must not break the mutation that emitted. */
export function emitAppChanged(appId: string, kind: AppEventKind): void {
  const set = subscribers.get(appId);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(kind);
    } catch {
      /* a dead subscriber cleans up via its own close handler */
    }
  }
}
