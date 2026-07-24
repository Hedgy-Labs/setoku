// SPDX-License-Identifier: Apache-2.0
//
// The public demo connector — ONE definition, imported by everything that needs it.
//
// This exists because the previous token was copy-pasted into ten places (the
// homepage, the README, demo/README, three e2e scripts, the site generator…),
// then rotated on the box. Every copy silently went stale, so the "try it live"
// link on setoku.com handed visitors `invalid or missing bearer token` and the
// demo e2e scripts had been failing against a dead credential.
//
// This token is PUBLIC on purpose: it is an analyst credential on a box holding
// nothing but a synthetic dataset (the fictional Bonita Bulldogs), it is
// read-only, and it can only ever *propose* knowledge (a human accepts, outside
// the agent loop). It is not a secret and does not belong in .env.
//
// If it is rotated again:
//   1. update DEMO_TOKEN here,
//   2. `bun run build:site` (regenerates site/api/index.json),
//   3. `bun test test/demo-connector.test.ts` — fails if any prose copy drifted,
//   4. `bun run deploy:site` — probes the live endpoint and fails on a bad token.

/** Host of the public demo box. */
export const DEMO_HOST = "demo.setoku.com";

/** Analyst token for the demo box. Public by design — see the note above. */
export const DEMO_TOKEN = "85315b4240ff6ded111072f950ac6f14167d920fdb765144";

/** The identity the demo token authenticates as (shown in the box's audit log). */
export const DEMO_IDENTITY = "demo@bonita-bulldogs.example";

/** The connector URL people paste into an MCP client. The token rides in the
 *  path because claude.ai's connector dialog has no header field. */
export const DEMO_MCP_URL = `https://${DEMO_HOST}/mcp/${DEMO_TOKEN}`;

/** Base URL of the demo box (published apps, /healthz). */
export const DEMO_BASE_URL = `https://${DEMO_HOST}`;
