// SPDX-License-Identifier: Apache-2.0
// The in-process app-change pub/sub behind the SSE live-refresh: per-app
// isolation, unsubscribe bookkeeping (idempotent, no count skew), a throwing
// subscriber never breaking the emit, and the global subscriber cap backstop.
import { describe, it, expect, afterEach } from "bun:test";
import {
  subscribeAppEvents,
  emitAppChanged,
  MAX_APP_EVENT_SUBSCRIBERS,
  MAX_VIEWER_EVENT_SUBSCRIBERS,
  type AppEventKind,
} from "../plugin/gateway/lib/app-events";

// Module state is process-global — every test must release what it subscribed
// so a leak here can't skew another test (or a later cap check) in this run.
const cleanups: (() => void)[] = [];
const sub = (
  id: string,
  fn: (k: AppEventKind) => void,
  opts?: { session: boolean },
): (() => void) | null => {
  const un = subscribeAppEvents(id, fn, opts);
  if (un) cleanups.push(un);
  return un;
};
afterEach(() => {
  for (const un of cleanups.splice(0)) un();
});

describe("app-events pub/sub", () => {
  it("delivers to every subscriber of THAT app only", () => {
    const got: string[] = [];
    sub("a", (k) => got.push(`a1:${k}`));
    sub("a", (k) => got.push(`a2:${k}`));
    sub("b", (k) => got.push(`b:${k}`));
    emitAppChanged("a", "updated");
    expect(got.sort()).toEqual(["a1:updated", "a2:updated"]);
    emitAppChanged("b", "renamed");
    expect(got).toContain("b:renamed");
    emitAppChanged("nobody-listening", "restored"); // no throw, no delivery
    expect(got.length).toBe(3);
  });

  it("unsubscribe stops delivery and is idempotent (no count skew)", () => {
    let n = 0;
    const un = subscribeAppEvents("c", () => n++)!;
    emitAppChanged("c", "updated");
    un();
    un(); // double-unsubscribe must be a no-op, not a negative-count bug
    emitAppChanged("c", "updated");
    expect(n).toBe(1);
  });

  it("a throwing subscriber doesn't break the emit or its peers", () => {
    let delivered = 0;
    sub("d", () => {
      throw new Error("torn-down socket");
    });
    sub("d", () => delivered++);
    expect(() => emitAppChanged("d", "updated")).not.toThrow();
    expect(delivered).toBe(1);
  });

  it("enforces the global cap, and freed slots become available again", () => {
    const held: (() => void)[] = [];
    for (let i = 0; i < MAX_APP_EVENT_SUBSCRIBERS; i++) {
      const un = sub(`cap-${i % 7}`, () => {}); // via `sub` → afterEach releases even on a failed expect
      expect(un).not.toBeNull();
      held.push(un!);
    }
    // At the cap: the next subscribe is denied (caller degrades to non-live).
    expect(subscribeAppEvents("cap-over", () => {})).toBeNull();
    // Freeing one slot re-admits exactly one subscriber.
    held.pop()!();
    const again = sub("cap-again", () => {});
    expect(again).not.toBeNull();
    for (const un of held) un(); // early release; afterEach's re-run is a no-op (idempotent)
    // Everything but `again` released — well under the cap again (no leaked count).
    expect(sub("cap-last", () => {})).not.toBeNull();
  });

  it("anonymous (viewer) subscriptions draw from their own smaller pool", () => {
    // Fill the viewer pool: the next VIEWER is denied, but a signed-in session
    // still subscribes — an unauthenticated script on a demo box can't starve
    // the team's live refresh.
    for (let i = 0; i < MAX_VIEWER_EVENT_SUBSCRIBERS; i++)
      expect(sub(`vcap-${i % 5}`, () => {}, { session: false })).not.toBeNull();
    expect(subscribeAppEvents("vcap-over", () => {}, { session: false })).toBeNull();
    expect(sub("vcap-session", () => {})).not.toBeNull();
    // Releasing a viewer slot re-admits a viewer.
    const un = subscribeAppEvents("vcap-a", () => {}, { session: false });
    expect(un).toBeNull(); // still full
    cleanups.shift()!(); // free one of the viewer subs (afterEach re-run is a no-op)
    expect(sub("vcap-b", () => {}, { session: false })).not.toBeNull();
  });
});
