// SPDX-License-Identifier: Apache-2.0
/**
 * Browser e2e for the shared-file grid (web/app/grid/): a CSV published via
 * publish_file renders in the browser on the PUBLIC page and in the admin app,
 * parsed client-side from the raw bytes (no frame). Drives the flows a viewer
 * uses: sort, filter by values, the filtered-CSV download, and range copy.
 *
 * Out of the fast suite like e2e/admin.test.ts (needs Chrome): `bun run test:e2e`.
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
import { startFakeLake } from "../test/lib/fakelake";

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

const PORT = 8796;
const BASE = `http://localhost:${PORT}`;

// Fictional rows (I3): a text, a money, and a status column; one long note.
const CSV =
  "company,fee,status,note\n" +
  "Harbor & Pine,\"$1,200\",Warm,short\n" +
  "Avery Co,300,New,\"a long note, with a comma and a \"\"quote\"\"\"\n" +
  "Copperleaf,$45,Warm,\n" +
  "Bluefield,\"$9,000\",Not a fit,x\n";

let proc: Subprocess | undefined;
let browser: Browser;
let tmp = "";
let id = "";
const lake = startFakeLake(() => ({ rows: [{ n: "1" }] }));

const cellText = (page: Page, r: number, c: number): Promise<string | null> =>
  page.locator(`.fg-gx .fg-r[data-r="${r}"] .fg-c`).nth(c).textContent();
const status = (page: Page): Promise<string | null> => page.locator(".fg-count").textContent();

describe.skipIf(!CHROME)("file grid (browser e2e)", () => {
  beforeAll(async () => {
    await spawn({ cmd: ["bun", "run", "build:admin"], cwd: ROOT, stdout: "ignore", stderr: "ignore" }).exited;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-e2e-grid-"));
    fs.cpSync(path.join(ROOT, "deploy", "project-template", ".setoku"), path.join(tmp, ".setoku"), { recursive: true });
    const dbPath = path.join(tmp, "knowledge.db");
    const store = new KnowledgeStore(dbPath);
    store.createAccount({ username: "boss", pwhash: await hashPassword("s3cret-pass"), role: "admin" });
    store.db.close();
    proc = spawnGateway({
      SETOKU_PROJECT_DIR: tmp,
      SETOKU_DB_PATH: dbPath,
      SETOKU_LAKE_URL: lake.url,
      SETOKU_TOKENS: "tok_ana=ana",
      SETOKU_HTTP_PORT: String(PORT),
      SETOKU_PUBLIC_URL: BASE,
      SETOKU_COOKIE_INSECURE: "1",
    });
    await waitHealthy(BASE);
    const ana = await gwConnect(BASE, "tok_ana", "ana");
    const r = await call(ana, "publish_file", { name: "partners.csv", title: "Partners", content: CSV });
    id = r.text.match(/get_app\("([^"]+)"\)/)?.[1] ?? "";
    await ana.close();
    // make it public (an admin action)
    const login = await fetch(`${BASE}/admin/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "boss", password: "s3cret-pass" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const { csrf } = (await login.json()) as { csrf: string };
    await fetch(`${BASE}/admin/api/set_visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ id, visibility: "public" }),
    });
    browser = await chromium.launch({ executablePath: CHROME });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    proc?.kill();
    lake.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("public page: parses in the browser, sorts, filters, downloads the filtered rows, copies a range", async () => {
    const ctx = await browser.newContext({ acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/p/${id}`);
    await page.locator(".fg-gx .fg-r").first().waitFor();
    expect(await page.locator("iframe").count()).toBe(0);
    expect(await status(page)).toBe("4 rows · 4 columns");
    // the quoted note parsed whole, and shows in full in the formula bar
    await page.locator('.fg-gx .fg-r[data-r="1"] .fg-c').nth(3).click();
    expect(await page.locator(".fg-val").textContent()).toBe('a long note, with a comma and a "quote"');

    // sort fee 9 → 1: numeric, not text
    await page.locator(".fg-h .fg-c").nth(1).hover();
    await page.locator('.fg-fb[data-c="1"]').click();
    await page.locator(".fg-menu .mi", { hasText: "9 → 1" }).click();
    expect([await cellText(page, 0, 1), await cellText(page, 1, 1), await cellText(page, 3, 1)]).toEqual(["$9,000", "$1,200", "$45"]);
    // row numbers stay the file's own under a sort
    expect(await page.locator('.fg-gx .fg-r[data-r="0"] .fg-n').textContent()).toBe("4");

    // filter status to Warm only
    await page.locator(".fg-h .fg-c").nth(2).hover();
    await page.locator('.fg-fb[data-c="2"]').click();
    await page.locator(".fg-menu .mb button", { hasText: "Clear" }).click();
    await page.locator(".fg-menu label", { hasText: "Warm" }).locator("input").check();
    await page.locator(".fg-menu .ok").click();
    expect(await status(page)).toBe("2 of 4 rows · 4 columns");

    // the filtered (and sorted) rows download as CSV
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".fg-btn", { hasText: "Download 2 rows" }).click()]);
    expect(dl.suggestedFilename()).toBe("partners (filtered).csv");
    expect(fs.readFileSync((await dl.path())!, "utf8")).toBe('company,fee,status,note\r\nHarbor & Pine,"$1,200",Warm,short\r\nCopperleaf,$45,Warm,\r\n');

    // select a 2×2 range, see its stats, copy it as TSV
    await page.locator('.fg-gx .fg-r[data-r="0"] .fg-c').nth(0).click();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    expect(await status(page)).toBe("Sum 1,245 · Avg 622.5 · Count 4");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Harbor & Pine\t$1,200\nCopperleaf\t$45");
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it("admin app: the same grid, fetched with the session", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await page.fill('input[type="text"], input[name="username"]', "boss");
    await page.fill('input[type="password"]', "s3cret-pass");
    await page.keyboard.press("Enter");
    await page.waitForLoadState("networkidle");
    await page.goto(`${BASE}/apps/${id}`);
    await page.locator(".fg-gx .fg-r").first().waitFor();
    expect(await page.locator("iframe").count()).toBe(0);
    expect(await cellText(page, 0, 0)).toBe("Harbor & Pine");
    // the header's Download is the ORIGINAL file
    expect(await page.getByRole("button", { name: "Download" }).first().isVisible()).toBe(true);
    await ctx.close();
  }, 60_000);
});
