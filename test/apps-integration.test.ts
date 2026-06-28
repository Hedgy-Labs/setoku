// SPDX-License-Identifier: Apache-2.0
/**
 * Integration coverage for the interactive-apps surfaces that unit tests don't
 * reach: publish-time param validation, param BINDING through the real render
 * path (a value changes the result), panel-less (state-only) app rendering, and
 * the per-app state datastore endpoints (scopes, isolation, auth, quota). Boots
 * the real http.ts against a throwaway Postgres + SQLite store.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pgPkg from "pg";
import { KnowledgeStore } from "../plugin/gateway/lib/store";
import { hashPassword } from "../plugin/gateway/lib/accounts";
import { spawnGateway, waitHealthy, connect as gwConnect, call, ROOT } from "./lib/gateway";

const { Client: PgClient } = pgPkg;
const PG_HOST = process.env.SETOKU_E2E_PG_HOST ?? "/tmp";
const DB_NAME = "setoku_apps_int";
const DB_URL = `postgresql:///${DB_NAME}?host=${encodeURIComponent(PG_HOST)}`;
const PORT = 38731;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: Subprocess;
let tmp = "";

/** Pull the minted app id out of a publish_app result (it echoes update_app("<id>", …)). */
const idOf = (text: string): string => text.match(/update_app\("([^"]+)"/)?.[1] ?? "";

/** Parse the injected window.__SETOKU__ from a rendered frame document. */
function setokuOf(html: string): {
  panels: Record<string, { rows: Record<string, unknown>[]; error: string | null }>;
  params: Record<string, string>;
} {
  const json = html.split("window.__SETOKU__=")[1]?.split("</script>")[0]?.replace(/;\s*$/, "") ?? "{}";
  return JSON.parse(json);
}

/** Sign in to /admin (a real session) and return the cookie + CSRF token. */
async function login(): Promise<{ cookie: string; csrf: string }> {
  const r = await fetch(`${BASE}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "boss", password: "s3cret-pass" }),
  });
  return { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0], csrf: (await r.json()).csrf };
}

beforeAll(async () => {
  const admin = new PgClient({ host: PG_HOST, database: process.env.SETOKU_E2E_PG_MAINTENANCE_DB ?? "template1" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const db = new PgClient({ host: PG_HOST, database: DB_NAME });
  await db.connect();
  await db.query("CREATE TABLE metrics (region text, revenue numeric)");
  for (const [region, vals] of [["NA", [100, 200]], ["EMEA", [40, 60]], ["APAC", [10, 20]]] as const)
    for (const v of vals) await db.query("INSERT INTO metrics VALUES ($1,$2)", [region, v]);
  await db.end();

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-apps-int-"));
  fs.cpSync(path.join(ROOT, "deploy", "project-template", ".setoku"), path.join(tmp, ".setoku"), { recursive: true });
  const dbPath = path.join(tmp, "knowledge.db");
  const store = new KnowledgeStore(dbPath);
  store.createAccount({ username: "boss", pwhash: await hashPassword("s3cret-pass"), role: "admin" });
  store.db.close();

  proc = spawnGateway({
    SETOKU_PROJECT_DIR: tmp,
    SETOKU_DB_PATH: dbPath,
    SETOKU_DATABASE_URL: DB_URL,
    SETOKU_TOKENS: "tok_boss=boss",
    SETOKU_HTTP_PORT: String(PORT),
    SETOKU_PUBLIC_URL: BASE,
    SETOKU_COOKIE_INSECURE: "1",
  });
  await waitHealthy(BASE);
}, 30_000);

afterAll(() => {
  proc?.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const REGION_PARAM = { name: "region", type: "enum", default: "NA", options: [{ value: "NA" }, { value: "EMEA" }, { value: "APAC" }] };
const REGION_PANEL = { key: "kpi", title: "Total", sql: "select coalesce(sum(revenue),0) total from metrics where region = :region", dialect: "postgres" };

describe("publish_app — param validation", () => {
  it("publishes an app whose panel binds a declared :param", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const r = await call(c, "publish_app", { title: "By region", html: "<div id=kpi></div>", panels: [REGION_PANEL], params: [REGION_PARAM] });
    expect(r.isError).toBeFalsy();
    expect(idOf(r.text)).toBeTruthy();
  });
  it("rejects a panel that references an UNDECLARED :param", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const r = await call(c, "publish_app", { title: "bad", html: "<div></div>", panels: [{ ...REGION_PANEL, key: "x" }] }); // no params
    expect(r.isError).toBeTruthy();
    expect(r.text.toLowerCase()).toContain("undeclared param");
  });
  it("rejects a param whose default doesn't coerce to its type", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const r = await call(c, "publish_app", {
      title: "bad default",
      html: "<div id=kpi></div>",
      panels: [{ key: "kpi", title: "n", sql: "select :n n", dialect: "postgres" }],
      params: [{ name: "n", type: "int", default: "not-a-number", min: 1, max: 10 }],
    });
    expect(r.isError).toBeTruthy();
  });
});

describe("param binding — a viewer value changes the result", () => {
  it("re-runs the panel bound to ?p.region", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const id = idOf((await call(c, "publish_app", { title: "Region totals", html: "<div id=kpi></div>", panels: [REGION_PANEL], params: [REGION_PARAM] })).text);
    const { cookie } = await login();
    const total = async (region: string): Promise<string> => {
      const html = await (await fetch(`${BASE}/admin/frame/${id}?p.region=${region}`, { headers: { cookie } })).text();
      return String(setokuOf(html).panels.kpi.rows[0].total);
    };
    expect(await total("NA")).toBe("300"); // 100 + 200
    expect(await total("EMEA")).toBe("100"); // 40 + 60
    expect(await total("APAC")).toBe("30"); // 10 + 20
  });
  it("falls back to the default for a value outside the enum (injection-safe)", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const id = idOf((await call(c, "publish_app", { title: "safe", html: "<div id=kpi></div>", panels: [REGION_PANEL], params: [REGION_PARAM] })).text);
    const { cookie } = await login();
    const html = await (await fetch(`${BASE}/admin/frame/${id}?p.region=${encodeURIComponent("NA'; DROP TABLE metrics;--")}`, { headers: { cookie } })).text();
    expect(String(setokuOf(html).panels.kpi.rows[0].total)).toBe("300"); // rejected → default NA, table intact
  });
  it("echoes the RESOLVED value into the frame (rejected input → default, for the control bar)", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const id = idOf((await call(c, "publish_app", { title: "echo", html: "<div id=kpi></div>", panels: [REGION_PANEL], params: [REGION_PARAM] })).text);
    const { cookie } = await login();
    const echo = async (region: string): Promise<string> =>
      setokuOf(await (await fetch(`${BASE}/admin/frame/${id}?p.region=${encodeURIComponent(region)}`, { headers: { cookie } })).text()).params.region;
    expect(await echo("EMEA")).toBe("EMEA"); // valid → as chosen
    expect(await echo("BOGUS")).toBe("NA"); // rejected → echoes the default, so the control snaps back
  });
});

describe("panel-less (state-only) app", () => {
  it("renders via the runtime path — app CSP + state bridge, not the legacy sandbox", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const id = idOf((await call(c, "publish_app", { title: "Todo", html: "<div id=app>todo</div>" })).text); // fragment, no panels
    const { cookie } = await login();
    const res = await fetch(`${BASE}/admin/frame/${id}`, { headers: { cookie } });
    expect(res.headers.get("content-security-policy")).toContain("form-action 'none'"); // FRAME_CSP, not legacy
    expect(res.headers.get("content-security-policy")).toContain("allow-forms");
    expect(await res.text()).toContain("__setoku_state_req"); // Setoku.state bridge injected
  });
});

describe("app_state datastore", () => {
  let appId = "";
  beforeAll(async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    appId = idOf((await call(c, "publish_app", { title: "State app", html: "<div>x</div>" })).text);
  });

  it("set/get/list/delete round-trips, and app vs viewer scopes are separate", async () => {
    const { cookie, csrf } = await login();
    const H = { "content-type": "application/json", "x-csrf-token": csrf, cookie };
    const post = (b: unknown) => fetch(`${BASE}/admin/api/app_state`, { method: "POST", headers: H, body: JSON.stringify(b) });
    const get = (scope: string) => fetch(`${BASE}/admin/api/app_state?id=${appId}&scope=${scope}`, { headers: { cookie } }).then((r) => r.json());

    await post({ id: appId, op: "set", scope: "app", key: "shared", value: { n: 1 } });
    await post({ id: appId, op: "set", scope: "viewer", key: "mine", value: "private" });
    expect((await get("app")).entries).toEqual([{ key: "shared", value: { n: 1 }, updatedAt: expect.any(String) }]);
    // viewer scope is a SEPARATE namespace — it does not see the app-scope key
    expect((await get("viewer")).entries.map((e: { key: string }) => e.key)).toEqual(["mine"]);
    expect((await post({ id: appId, op: "delete", scope: "app", key: "shared" }).then((r) => r.json())).deleted).toBe(true);
    expect((await get("app")).entries).toEqual([]);
  });

  it("rejects an unauthenticated read (401)", async () => {
    const r = await fetch(`${BASE}/admin/api/app_state?id=${appId}&scope=app`);
    expect(r.status).toBe(401);
  });

  it("rejects an over-quota value (413)", async () => {
    const { cookie, csrf } = await login();
    const r = await fetch(`${BASE}/admin/api/app_state`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf, cookie },
      body: JSON.stringify({ id: appId, op: "set", scope: "app", key: "big", value: "x".repeat(200_000) }),
    });
    expect(r.status).toBe(413);
  });
});

describe("panel cache is bounded per app (open-domain param can't grow it forever)", () => {
  it("keeps at most ~256 variant rows, evicting the oldest by last write", () => {
    const store = new KnowledgeStore(":memory:");
    // Simulate 400 distinct param variants for one app (panel_key = key::variant).
    for (let i = 0; i < 400; i++) store.putPanelCache("appX", `kpi::v${i}`, { columns: [], rows: [], rowCount: 0 });
    const n = (store.db.query("SELECT COUNT(*) AS n FROM app_cache WHERE app_id = ?").get("appX") as { n: number }).n;
    expect(n).toBeLessThanOrEqual(256);
    // the newest variant survived; an early one was evicted
    expect(store.getPanelCache("appX", "kpi::v399")).not.toBeNull();
    expect(store.getPanelCache("appX", "kpi::v0")).toBeNull();
    store.db.close();
  });
});
