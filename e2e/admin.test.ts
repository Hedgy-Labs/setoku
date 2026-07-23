// SPDX-License-Identifier: Apache-2.0
/**
 * Browser e2e for the /admin React SPA. Boots the REAL gateway (http.ts) against
 * a seeded throwaway store and drives Chrome through the security-critical flows:
 * the approval membrane, member view-only, invite, the row menu, responsive nav.
 *
 * Kept OUT of the fast `bun test test/ ingest/` suite (it needs a browser and is
 * slower). Run it with `bun run test:e2e`. Uses the SYSTEM Chrome via
 * playwright-core (no 150 MB browser download) and skips cleanly when none is
 * found — set SETOKU_E2E_CHROME to point at a specific binary.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { KnowledgeStore } from "../plugin/gateway/lib/store";
import { hashPassword } from "../plugin/gateway/lib/accounts";
import { spawnGateway, waitHealthy, connect as gwConnect, call, ROOT } from "../test/lib/gateway";

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

if (!CHROME) {
  console.warn("admin e2e: no Chrome found — skipping. Set SETOKU_E2E_CHROME to a browser binary to run it.");
}

const PORT = 8795;
const BASE = `http://localhost:${PORT}`;

let proc: Subprocess | undefined;
let browser: Browser;
let tmp = "";
// Kept at module scope so the SSE-reconnect test can restart the gateway with
// the identical environment (same store, same port — a simulated deploy).
let gwEnv: Record<string, string> = {};

describe.skipIf(!CHROME)("admin SPA (browser e2e)", () => {
  beforeAll(async () => {
    // 1. build the served assets — the shell reads web/app.css + web/dist/app.js
    await spawn({ cmd: ["bun", "run", "build:admin"], cwd: ROOT, stdout: "ignore", stderr: "ignore" }).exited;

    // 2. seed a throwaway store: an admin, a member, a pending gotcha, a doc
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-e2e-admin-"));
    fs.cpSync(path.join(ROOT, "deploy", "project-template", ".setoku"), path.join(tmp, ".setoku"), {
      recursive: true,
    });
    const dbPath = path.join(tmp, "knowledge.db");
    const tokensFile = path.join(tmp, "teammates.json");
    const store = new KnowledgeStore(dbPath);
    store.createAccount({ username: "boss", pwhash: await hashPassword("s3cret-pass"), role: "admin" });
    store.createAccount({ username: "viewer", pwhash: await hashPassword("viewer-pass"), role: "member" });
    store.audit("boss", "find_context", { question: "seed" });
    store.upsertDoc({ type: "overview", name: "business", body: "Seeded overview for e2e.", meta: {} }, "boss");
    store.addCorrection({
      user: "alice@co.test",
      kind: "gotcha",
      content: "E2E: contractor placements are excluded from net revenue.",
    });
    store.db.close();
    fs.writeFileSync(tokensFile, JSON.stringify({ tok_alice: "alice@co.test" }));

    // 3. boot the real gateway against it
    gwEnv = {
      SETOKU_PROJECT_DIR: tmp,
      SETOKU_DB_PATH: dbPath,
      SETOKU_TOKENS: "tok_boss=boss",
      SETOKU_TOKENS_FILE: tokensFile,
      SETOKU_HTTP_PORT: String(PORT),
      SETOKU_PUBLIC_URL: BASE,
      SETOKU_COOKIE_INSECURE: "1", // http://localhost — browsers drop Secure cookies
    };
    proc = spawnGateway(gwEnv);
    await waitHealthy(BASE);

    // 4. launch the system Chrome
    browser = await chromium.launch({ executablePath: CHROME!, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    proc?.kill();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A fresh isolated page (its own cookie jar), optionally signed in. */
  async function open(
    login?: { user: string; pass: string },
    viewport = { width: 1100, height: 900 },
  ): Promise<{ page: Page; errors: string[] }> {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    if (login) {
      await page.fill('input[name="username"]', login.user);
      await page.fill('input[name="password"]', login.pass);
      await page.click('button[type="submit"]');
      await page.waitForSelector("header"); // signed-in chrome rendered
    }
    return { page, errors };
  }

  it("serves the SPA shell with a login form and no secrets", async () => {
    const { page, errors } = await open();
    expect(await page.locator('input[name="password"]').isVisible()).toBe(true);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it("an admin signs in and approves a pending gotcha (the membrane)", async () => {
    const { page, errors } = await open({ user: "boss", pass: "s3cret-pass" });
    // landing is Apps; the review queue lives under the Knowledge tab
    await page.waitForSelector('h1:has-text("Apps")');
    await page.click('nav a:has-text("Knowledge")');
    await page.click('a:has-text("Review")');
    await page.waitForSelector("text=Pending (");
    expect(await page.locator('button:has-text("Approve")').first().isVisible()).toBe(true);
    await page.locator('button:has-text("Approve")').first().click();
    await page.waitForSelector("text=approved"); // flash from the resolve response
    expect(errors).toEqual([]);
    await page.context().close();
  }, 20_000);

  it("a member is view-only — cannot approve, no invite form", async () => {
    const { page, errors } = await open({ user: "viewer", pass: "viewer-pass" });
    await page.click('nav a:has-text("Knowledge")');
    await page.click('a:has-text("Review")');
    await page.waitForSelector("text=Pending (");
    expect(await page.locator("text=viewing only").first().isVisible()).toBe(true);
    expect(await page.locator('button:has-text("Approve")').count()).toBe(0);
    await page.click('a:has-text("Team")');
    await page.waitForSelector("text=People (");
    expect(await page.locator('button:has-text("Invite")').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.context().close();
  }, 20_000);

  it("an admin invites a teammate and sees the once-only connector", async () => {
    const { page, errors } = await open({ user: "boss", pass: "s3cret-pass" });
    await page.click('a:has-text("Team")');
    await page.waitForSelector("text=People (");
    await page.fill('input[type="email"]', "e2e-newhire@co.test");
    await page.click('button:has-text("Invite")');
    // the shown-once dialog: ONE ready-to-send message with connector + login
    await page.waitForSelector("text=e2e-newhire@co.test — send them this");
    const message = await page.locator("pre").innerText();
    expect(message).toContain("/mcp/"); // connector URL
    expect(message).toContain("Username: e2e-newhire@co.test");
    expect(message).toContain("Temp password: ");
    expect(await page.locator('button:has-text("Copy message")').isVisible()).toBe(true);
    await page.click('button:has-text("Done")');
    expect(errors).toEqual([]);
    await page.context().close();
  }, 20_000);

  it("the row menu opens, shows the actions, and Escape closes it (a11y)", async () => {
    const { page } = await open({ user: "boss", pass: "s3cret-pass" });
    await page.click('a:has-text("Team")');
    await page.waitForSelector("text=People (");
    await page.locator('button[aria-label^="Actions for"]').first().click();
    await page.waitForSelector('[role="menu"]');
    expect(await page.locator('[role="menuitem"]:has-text("Reset agent connector")').isVisible()).toBe(true);
    // Remove is present on EVERY row — even the last admin's (the server 409s with the reason)
    expect(await page.locator('[role="menuitem"]:has-text("Remove")').isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    expect(await page.locator('[role="menu"]').count()).toBe(0);
    await page.context().close();
  }, 20_000);

  it("the nav collapses to a hamburger on small widths and is inline on wide", async () => {
    // narrow: hamburger shown, inline tabs hidden
    const { page } = await open({ user: "boss", pass: "s3cret-pass" }, { width: 420, height: 760 });
    expect(await page.locator('button[aria-label="Menu"]').isVisible()).toBe(true);
    expect(await page.locator('nav a:has-text("Knowledge")').isVisible()).toBe(false);
    // the hamburger navigates
    await page.click('button[aria-label="Menu"]');
    await page.waitForSelector('[role="menu"]');
    await page.click('[role="menuitem"]:has-text("Sources")');
    await page.waitForSelector('h1:has-text("Sources")');
    // wide: inline tabs back, hamburger gone
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.waitForTimeout(150);
    expect(await page.locator('nav a:has-text("Knowledge")').isVisible()).toBe(true);
    expect(await page.locator('button[aria-label="Menu"]').isVisible()).toBe(false);
    await page.context().close();
  }, 20_000);

  it("an open app view live-refreshes when the agent updates it (SSE), and history shows the model", async () => {
    // The agent publishes a STATIC app (no panels — the e2e box has no lake),
    // self-reporting its model.
    const c = await gwConnect(BASE, "tok_boss", "e2e-live");
    const pub = await call(c, "publish_app", { title: "Live e2e", html: '<div id="marker">LIVE-V1</div>', model: "claude-fable-5" });
    expect(pub.isError).toBeFalsy();
    const id = pub.text.match(/update_app\("([^"]+)"/)?.[1] ?? "";
    expect(id).not.toBe("");

    // A human watches it in the browser — initial content rendered in the frame.
    // NOT networkidle: the app view holds the SSE stream open by design, so the
    // network never idles on this page.
    const { page, errors } = await open({ user: "boss", pass: "s3cret-pass" });
    await page.goto(`${BASE}/apps/${id}`, { waitUntil: "load" });
    const marker = page.frameLocator("iframe").locator("#marker");
    await marker.waitFor({ timeout: 10_000 });
    expect(await marker.innerText()).toBe("LIVE-V1");

    // The agent edits it. NO reload/navigation in the browser — the SSE nudge
    // must remount the frame with the new content and toast.
    const upd = await call(c, "update_app", { id, html: '<div id="marker">LIVE-V2</div>', message: "Swapped the marker", model: "claude-fable-5" });
    expect(upd.isError).toBeFalsy();
    await page.waitForSelector("text=Updated to the latest version.", { timeout: 10_000 });
    await page
      .frameLocator("iframe")
      .locator('#marker:has-text("LIVE-V2")')
      .waitFor({ timeout: 10_000 });

    // The version drawer (⋮ → Version history) attributes both versions to the model.
    await page.getByRole("button", { name: "App actions" }).click();
    await page.click('[role="menuitem"]:has-text("Version history")');
    await page.waitForSelector("text=Version 2");
    const drawer = page.locator('[role="dialog"][aria-label="Version history"]');
    expect(await drawer.locator("text=claude-fable-5").count()).toBe(2); // v1 publish + v2 edit
    expect(await drawer.locator("text=Swapped the marker").isVisible()).toBe(true);
    expect(errors).toEqual([]);
    await page.context().close();
  }, 30_000);

  it("catches up after a box restart — an edit during the disconnect still lands", async () => {
    const c = await gwConnect(BASE, "tok_boss", "e2e-reconnect");
    const pub = await call(c, "publish_app", { title: "Reconnect e2e", html: '<div id="marker">RC-V1</div>', model: "claude-fable-5" });
    expect(pub.isError).toBeFalsy();
    const id = pub.text.match(/update_app\("([^"]+)"/)?.[1] ?? "";

    const { page, errors } = await open({ user: "boss", pass: "s3cret-pass" });
    await page.goto(`${BASE}/apps/${id}`, { waitUntil: "load" });
    await page.frameLocator("iframe").locator('#marker:has-text("RC-V1")').waitFor({ timeout: 10_000 });

    // Simulate a deploy: kill the gateway (the open SSE stream drops)…
    proc!.kill();
    await proc!.exited;
    // …boot it again on the same store (sessions persist, so no re-login)…
    proc = spawnGateway(gwEnv);
    await waitHealthy(BASE);
    // …and edit IMMEDIATELY, racing the browser's ~3s reconnect — so this edit
    // often lands while the stream is still down. The reconnect catch-up (the
    // onopen refetch + version watcher) must surface it whichever side wins.
    const c2 = await gwConnect(BASE, "tok_boss", "e2e-reconnect2");
    const upd = await call(c2, "update_app", { id, html: '<div id="marker">RC-V2</div>', model: "claude-fable-5" });
    expect(upd.isError).toBeFalsy();

    await page.frameLocator("iframe").locator('#marker:has-text("RC-V2")').waitFor({ timeout: 20_000 });
    expect(errors).toEqual([]);
    await page.context().close();
  }, 45_000);
});
