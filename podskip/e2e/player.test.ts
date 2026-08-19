// SPDX-License-Identifier: Apache-2.0
// End-to-end: real Chromium against the fixture server. Proves the player
// actually jumps over ad ranges during playback, and that /audio serves
// byte ranges correctly (what <audio> seeking depends on).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { FIXTURE_ADS } from "../lib/fixtures.ts";

const PORT = 4519;
const BASE = `http://localhost:${PORT}`;

let proc: ReturnType<typeof Bun.spawn>;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
    env: { ...process.env, PODSKIP_FIXTURES: "1", PODSKIP_PORT: String(PORT) },
    stdout: "ignore",
    stderr: "inherit",
  });
  // wait for the server
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/shows`);
      if (r.ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"],
  });
  page = await browser.newPage();
}, 30000);

afterAll(async () => {
  await browser?.close();
  proc?.kill();
});

describe("audio range serving", () => {
  test("full, partial, suffix and unsatisfiable ranges", async () => {
    const url = `${BASE}/audio?show=fixture-show&guid=fixture-ep-1`;
    const full = await fetch(url);
    expect(full.status).toBe(200);
    const size = Number(full.headers.get("content-length"));
    expect(size).toBeGreaterThan(100_000);

    const part = await fetch(url, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const openEnd = await fetch(url, { headers: { range: `bytes=${size - 50}-` } });
    expect(openEnd.status).toBe(206);
    expect((await openEnd.arrayBuffer()).byteLength).toBe(50);

    const suffix = await fetch(url, { headers: { range: "bytes=-64" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes ${size - 64}-${size - 1}/${size}`);

    const bad = await fetch(url, { headers: { range: `bytes=${size + 10}-` } });
    expect(bad.status).toBe(416);
  });
});

describe("player", () => {
  test("loads shows, plays, and skips both ad ranges", async () => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".ep");
    expect(await page.textContent(".show-head h2")).toBe("Fixture Podcast");
    expect(await page.textContent(".chip")).toContain("2 ads mapped");

    await page.click(".ep");
    await page.waitForFunction(() => {
      const a = document.getElementById("audio") as HTMLAudioElement;
      return a && a.readyState >= 2 && !a.paused;
    }, undefined, { timeout: 10000 });

    // ad ranges are painted on the seek bar
    expect(await page.locator(".ad-mark").count()).toBe(FIXTURE_ADS.length);

    // record the playhead over time, fast-forwarded 4x, starting just before ad 1
    const samples: number[] = await page.evaluate(async () => {
      const a = document.getElementById("audio") as HTMLAudioElement;
      a.currentTime = 8;
      a.playbackRate = 4;
      const seen: number[] = [];
      await new Promise<void>((resolve) => {
        const h = () => {
          seen.push(a.currentTime);
          if (a.currentTime >= 24) { a.removeEventListener("timeupdate", h); resolve(); }
        };
        a.addEventListener("timeupdate", h);
        setTimeout(() => resolve(), 15000); // safety
      });
      return seen;
    });

    expect(samples.some((t) => t < 10)).toBe(true); // saw pre-ad content
    expect(samples.some((t) => t >= 20)).toBe(true); // landed after the ad
    // never played inside the ad body (skip fires within one timeupdate tick,
    // so allow the sub-second boundary but nothing deeper)
    expect(samples.filter((t) => t > 11 && t < 19.5)).toEqual([]);

    // second ad: seek just before it and confirm the same jump
    const samples2: number[] = await page.evaluate(async () => {
      const a = document.getElementById("audio") as HTMLAudioElement;
      a.currentTime = 38;
      const seen: number[] = [];
      await new Promise<void>((resolve) => {
        const h = () => {
          seen.push(a.currentTime);
          if (a.currentTime >= 54) { a.removeEventListener("timeupdate", h); resolve(); }
        };
        a.addEventListener("timeupdate", h);
        setTimeout(() => resolve(), 15000);
      });
      return seen;
    });
    expect(samples2.some((t) => t >= 50)).toBe(true);
    expect(samples2.filter((t) => t > 41 && t < 49.5)).toEqual([]);

    // the toast told the user what happened
    const toast = await page.textContent("#toast");
    expect(toast).toContain("Skipped");
  }, 45000);

  test("seeking into an ad jumps out of it", async () => {
    const t = await page.evaluate(async () => {
      const a = document.getElementById("audio") as HTMLAudioElement;
      a.currentTime = 14; // middle of ad 1
      await new Promise((r) => setTimeout(r, 800));
      return a.currentTime;
    });
    expect(t).toBeGreaterThanOrEqual(20);
  }, 15000);
});
