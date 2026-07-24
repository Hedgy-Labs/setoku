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

/**
 * Published demo apps we link to from setoku.com. These rot exactly like the
 * token did, but through a different mechanism: an admin flipping an app from
 * `public` back to `team` turns an advertised `/p/<id>` into a 404 with nothing
 * in this repo changing. That already happened once — the "Fan LTV" app was
 * advertised on the homepage, in the README, and in llms.txt while returning 404,
 * because its visibility had been flipped to team.
 *
 * Only genuinely public apps belong here; `/apps/<id>` (team) links are
 * login-gated and are NOT public URLs. deploy:site probes each of these.
 */
export const DEMO_PUBLIC_APPS: { id: string; title: string; blurb: string }[] = [
  {
    id: "7e38381ced6517329947b14d",
    title: "Sponsorship pricing table",
    blurb: "inventory and rates for sponsorship placements",
  },
  {
    id: "a7a1240ae0bc202c5eefa1cc",
    title: "Bulldogs attendance forecast",
    blurb: "projected gate for upcoming home games",
  },
];

/** Public URL of a published demo app. */
export const demoAppUrl = (id: string): string => `${DEMO_BASE_URL}/p/${id}`;
