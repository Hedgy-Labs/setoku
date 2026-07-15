// SPDX-License-Identifier: Apache-2.0
// Runtime flags the gateway injects into the SPA shell as window globals (see
// http.ts ADMIN_SHELL). Read once at module load — they never change at runtime.

/** True on a public demo box (SETOKU_DEMO=1): the console is viewable read-only
 *  without login, and the demo banner is shown. */
export const IS_DEMO =
  typeof window !== "undefined" &&
  (window as { __SETOKU_DEMO__?: boolean }).__SETOKU_DEMO__ === true;
