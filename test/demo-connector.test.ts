// SPDX-License-Identifier: Apache-2.0
//
// The public demo connector is advertised in prose we can't import from — the
// homepage, the README, demo/README, llms.txt. Those copies rotted once already:
// the token was rotated on the box and every published copy kept pointing at a
// dead credential, so "try it live" on setoku.com returned
// `invalid or missing bearer token` and the demo e2e scripts ran against nothing.
//
// Code copies are now imports of demo/connector.ts. These tests cover what an
// import can't reach: that every hand-written copy still equals that constant.
// This is offline drift detection. Whether the token is *live* is a question for
// the network, and deploy:site probes it there.
import { describe, expect, test } from "bun:test";

import {
  DEMO_HOST,
  DEMO_MCP_URL,
  DEMO_PUBLIC_APPS,
  DEMO_TOKEN,
  demoAppUrl,
} from "../demo/connector";

const ROOT = new URL("..", import.meta.url).pathname;

/** Files that publish the connector URL as prose a reader will copy-paste. */
const PROSE = [
  "README.md",
  "demo/README.md",
  "site/index.html",
  "site/developers/index.html",
  "site/llms.txt",
  "site/api/index.json",
];

describe("the advertised demo connector is defined once", () => {
  test("the token looks like a real connector token", () => {
    expect(DEMO_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(DEMO_MCP_URL).toBe(`https://${DEMO_HOST}/mcp/${DEMO_TOKEN}`);
  });

  test("every published copy points at the same token", async () => {
    const wrong: string[] = [];
    for (const p of PROSE) {
      const text = await Bun.file(ROOT + p).text();
      // any demo MCP URL in this file must carry the current token
      for (const [, tok] of text.matchAll(
        new RegExp(`${DEMO_HOST.replace(/\./g, "\\.")}/mcp/([0-9a-f]{8,})`, "g"),
      )) {
        if (tok !== DEMO_TOKEN) wrong.push(`${p}: ${tok.slice(0, 8)}…`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("each published copy actually mentions the connector at all", async () => {
    // Guards the other direction: a copy silently dropped during an edit means
    // the page stops telling people how to try it.
    const missing: string[] = [];
    for (const p of PROSE) {
      const text = await Bun.file(ROOT + p).text();
      if (!text.includes(DEMO_TOKEN)) missing.push(p);
    }
    expect(missing).toEqual([]);
  });

  // Bun.Glob does NOT support `/` inside brace alternatives — a combined pattern
  // like `{README.md,demo/**/*.ts}` silently matches ZERO files. The first version
  // of the sweep below used exactly that, so it passed vacuously and would not
  // have caught the rotation it was written for. Scan one pattern at a time.
  const SWEEP = [
    "README.md",
    "SPEC.md",
    "demo/**/*.ts",
    "demo/**/*.md",
    "site/**/*.html",
    "site/**/*.txt",
    "site/**/*.json",
    "scripts/**/*.ts",
    "test/**/*.ts",
    "e2e/**/*.ts",
    "plugin/**/*.ts",
    "plugin/**/*.md",
    "docs/**/*.md",
  ];

  async function sweepFiles(): Promise<string[]> {
    const seen = new Set<string>();
    for (const pattern of SWEEP) {
      for await (const rel of new Bun.Glob(pattern).scan({ cwd: ROOT })) seen.add(rel);
    }
    return [...seen];
  }

  test("the sweep actually scans files (guards against a vacuous glob)", async () => {
    // Without this, a malformed pattern makes every assertion below trivially
    // true — which is precisely how the first version of this test shipped.
    const files = await sweepFiles();
    expect(files.length).toBeGreaterThan(50);
    for (const p of PROSE) expect(files).toContain(p);
  });

  test("no stale token literals survive anywhere in the tree", async () => {
    // Catches a rotation that updated the constant but missed a copy in a file
    // nobody thought to grep — the exact failure this suite exists for.
    const stale: string[] = [];
    for (const rel of await sweepFiles()) {
      const text = await Bun.file(ROOT + rel).text();
      for (const [, tok] of text.matchAll(
        new RegExp(`${DEMO_HOST.replace(/\./g, "\\.")}/mcp/([0-9a-f]{8,})`, "g"),
      )) {
        if (tok !== DEMO_TOKEN) stale.push(`${rel}: ${tok.slice(0, 8)}…`);
      }
    }
    expect(stale).toEqual([]);
  });

  test("no stale published-app links survive either", async () => {
    // Same rot, different mechanism: an app flipped from public back to team
    // turns an advertised /p/<id> into a 404 with nothing in git changing. That
    // happened to the "Fan LTV" app, which was linked from the homepage, the
    // README and llms.txt while returning 404.
    const known = new Set(DEMO_PUBLIC_APPS.map((a) => a.id));
    const unknown: string[] = [];
    for (const rel of await sweepFiles()) {
      const text = await Bun.file(ROOT + rel).text();
      for (const [, id] of text.matchAll(
        new RegExp(`${DEMO_HOST.replace(/\./g, "\\.")}/p/([0-9a-f]{8,})`, "g"),
      )) {
        if (!known.has(id)) unknown.push(`${rel}: /p/${id.slice(0, 12)}…`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test("the public-app list is well formed", () => {
    expect(DEMO_PUBLIC_APPS.length).toBeGreaterThan(0);
    for (const a of DEMO_PUBLIC_APPS) {
      expect(a.id).toMatch(/^[0-9a-f]{16,}$/);
      expect(a.title.length).toBeGreaterThan(0);
      expect(demoAppUrl(a.id)).toBe(`https://${DEMO_HOST}/p/${a.id}`);
    }
  });
});
