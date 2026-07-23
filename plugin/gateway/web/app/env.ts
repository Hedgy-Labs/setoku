// SPDX-License-Identifier: Apache-2.0
// Runtime flags the gateway injects into the SPA shell as window globals (see
// http.ts ADMIN_SHELL). Read once at module load — they never change at runtime.

/** True on a public demo box (SETOKU_DEMO=1): the console is viewable read-only
 *  without login, and the demo banner is shown. */
export const IS_DEMO =
  typeof window !== "undefined" &&
  (window as { __SETOKU_DEMO__?: boolean }).__SETOKU_DEMO__ === true;

/** On a demo box, the path-authed MCP endpoint (`/mcp/<demo token>`) and the
 *  connector name, injected by the gateway so the banner can show connect
 *  instructions. Null off a demo box (or if no demo token is provisioned). */
export const DEMO_MCP: { path: string; connector: string } | null =
  typeof window !== "undefined"
    ? ((window as { __SETOKU_DEMO_MCP__?: { path: string; connector: string } })
        .__SETOKU_DEMO_MCP__ ?? null)
    : null;
