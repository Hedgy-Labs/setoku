// SPDX-License-Identifier: Apache-2.0
/**
 * preview_app's renderer (lib/preview.ts) against a REAL headless Chrome over
 * CDP — the stand-in for the box's `preview` container. Covers what the agent
 * gets back (JS errors, CSP-blocked fetches, overflow) and the load guards
 * (result cache, per-user + box buckets, the one-at-a-time queue).
 * Out of the fast suite (needs Chrome): `bun run test:e2e`.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Previewer, PreviewLimitError } from "../plugin/gateway/lib/preview";

const CHROME = (
  process.env.SETOKU_E2E_CHROME
    ? [process.env.SETOKU_E2E_CHROME]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ]
).find((p) => fs.existsSync(p));

const CDP_PORT = 9341;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; sandbox allow-scripts allow-forms";
const doc = (body: string) => `<!doctype html><html><head><meta charset=utf-8></head><body>${body}</body></html>`;

describe.skipIf(!CHROME)("preview renderer (browser e2e)", () => {
  let chrome: Subprocess;
  let dir = "";
  const cdpUrl = `http://localhost:${CDP_PORT}`;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-preview-e2e-"));
    chrome = spawn({
      cmd: [CHROME!, "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "about:blank"],
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${cdpUrl}/json/version`)).ok) return;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("chrome did not expose CDP");
  });
  afterAll(() => {
    chrome?.kill();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports JS errors, CSP-blocked fetches, and overflow; the screenshot is a JPEG", async () => {
    const p = new Previewer({ cdpUrl });
    expect(await p.probe()).toBe(true);
    const shot = await p.render(
      doc(
        '<link rel="stylesheet" href="https://fonts.example.com/inter.css"><img src="https://cdn.example.com/x.png">' +
          '<div style="width:2000px">wide</div><script>window.nope()</script>',
      ),
      CSP,
      "desktop",
      "ana",
    );
    expect(shot.jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
    const d = shot.diagnostics;
    expect(d.errors.join(" ")).toContain("nope");
    expect(d.blocked.some((b) => b.includes("fonts.example.com"))).toBe(true);
    expect(d.blocked.some((b) => b.includes("cdn.example.com"))).toBe(true);
    expect(d.overflowPx).toBeGreaterThan(600);
    expect(d.blank).toBe(false);
  });

  it("answers the Setoku.state bridge locally (no 8s stall) and flags a blank page", async () => {
    const p = new Previewer({ cdpUrl });
    const t0 = Date.now();
    const shot = await p.render(
      doc(`<script>parent.postMessage({__setoku_state_req:true,id:1,op:"list"},"*");addEventListener("message",e=>{if(e.data&&e.data.__setoku_state_res)document.title="ok"})</script>`),
      CSP,
      "mobile",
      "ana",
    );
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(shot.diagnostics.blank).toBe(true);
  });

  it("guards: identical renders are cached (free), per-user and box buckets refuse, the queue caps", async () => {
    const p = new Previewer({ cdpUrl, perUser: { burst: 2, perMinute: 0.001 }, perBox: { burst: 3, perMinute: 0.001 } });
    const a = await p.render(doc("<p>a</p>"), CSP, "desktop", "u1");
    expect(a.cached).toBe(false);
    expect((await p.render(doc("<p>a</p>"), CSP, "desktop", "u1")).cached).toBe(true); // free
    await p.render(doc("<p>b</p>"), CSP, "desktop", "u1");
    await expect(p.render(doc("<p>c</p>"), CSP, "desktop", "u1")).rejects.toBeInstanceOf(PreviewLimitError); // u1 spent
    await p.render(doc("<p>c</p>"), CSP, "desktop", "u2"); // box token 3 of 3
    await expect(p.render(doc("<p>d</p>"), CSP, "desktop", "u3")).rejects.toThrow(/rendering a lot of previews/);

    // one at a time + a queue of 2: five distinct concurrent renders → two turned away
    const q = new Previewer({ cdpUrl, perUser: { burst: 100, perMinute: 100 }, perBox: { burst: 100, perMinute: 100 } });
    const settled = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => q.render(doc(`<p>${i}</p>`), CSP, "desktop", `q${i}`)));
    const busy = settled.filter((s) => s.status === "rejected" && /busy/.test(String((s as PromiseRejectedResult).reason)));
    expect(busy.length).toBe(2);
    expect(settled.filter((s) => s.status === "fulfilled").length).toBe(3);
  });
});
