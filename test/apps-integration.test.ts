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
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "../plugin/gateway/lib/store";
import { renderApp, flushBackgroundPanelRefreshes, MAX_RENDER_ROW_BYTES } from "../plugin/gateway/lib/apps";
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
  panels: Record<string, { rows: Record<string, unknown>[]; error: string | null; truncated?: boolean; rowCount?: number }>;
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

describe("get_app — full round-trip (template + params + panels) (#59)", () => {
  it("hands back the exact html template and declared params for edit-in-place", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const html = '<div id=kpi data-tab="pnl"></div><script>/*custom presentation*/renderPnl(window.__SETOKU__.panels.kpi)</script>';
    const id = idOf((await call(c, "publish_app", { title: "Round-trip", html, panels: [REGION_PANEL], params: [REGION_PARAM] })).text);
    const got = await call(c, "get_app", { id });
    expect(got.isError).toBeFalsy();
    // The template comes back verbatim — no rebuild-from-inference needed.
    expect(got.text).toContain("## template");
    expect(got.text).toContain(html);
    // Params round-trip VERBATIM (as the exact update_app arg) — not a lossy summary.
    expect(got.text).toContain("## params");
    const paramsJson = got.text.split("```json")[1]?.split("```")[0] ?? "";
    expect(JSON.parse(paramsJson)).toEqual([REGION_PARAM]);
    // Panels still surfaced as before.
    expect(got.text).toContain("panel kpi");
    expect(got.text).toContain(":region");
  });
});

describe("update_app — params are first-class (validate + I9 re-gate)", () => {
  it("rejects a params-only update whose new default doesn't coerce", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const id = idOf((await call(c, "publish_app", { title: "p1", html: "<div id=kpi></div>", panels: [REGION_PANEL], params: [REGION_PARAM] })).text);
    // No `panels` passed — the old code skipped validation on this path.
    const r = await call(c, "update_app", { id, params: [{ name: "region", type: "enum", default: "ZZZ", options: [{ value: "NA" }] }] });
    expect(r.isError).toBeTruthy();
  });
  it("rejects a params-only update that strands an existing panel's :token", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const id = idOf((await call(c, "publish_app", { title: "p2", html: "<div id=kpi></div>", panels: [REGION_PANEL], params: [REGION_PARAM] })).text);
    // Drop the param the existing panel binds (:region) → must fail, not 500 later.
    const r = await call(c, "update_app", { id, params: [] });
    expect(r.isError).toBeTruthy();
    expect(r.text.toLowerCase()).toContain("undeclared param");
  });
  it("reverts a PUBLIC app to team-only when params change (I9 human re-approval)", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const id = idOf((await call(c, "publish_app", { title: "p3", html: "<div id=kpi></div>", panels: [REGION_PANEL], params: [REGION_PARAM] })).text);
    const { cookie, csrf } = await login();
    const setVis = await fetch(`${BASE}/admin/api/set_visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf, cookie },
      body: JSON.stringify({ id, visibility: "public" }),
    });
    expect((await setVis.json()).ok).toBe(true);
    // A params-only edit widens what the public link exposes → must re-gate.
    const r = await call(c, "update_app", { id, params: [{ ...REGION_PARAM, options: [{ value: "NA" }, { value: "EMEA" }, { value: "APAC" }, { value: "LATAM" }] }] });
    expect(r.isError).toBeFalsy();
    expect(r.text.toLowerCase()).toContain("reverted to team-only");
    expect((await fetch(`${BASE}/p/${id}`)).status).toBe(404); // no longer public
  });
});

describe("update_app — change message lands in version history (issue #63)", () => {
  it("threads `message` into the app_revisions note the header drawer reads", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const id = idOf((await call(c, "publish_app", { title: "Changelog", html: "<div id=kpi></div>", panels: [REGION_PANEL], params: [REGION_PARAM] })).text);
    const r = await call(c, "update_app", { id, html: "<div id=kpi>v2</div>", message: "Reworked the KPI header" });
    expect(r.isError).toBeFalsy();

    const { cookie } = await login();
    const hist = await (await fetch(`${BASE}/admin/api/app_history?id=${id}`, { headers: { cookie } })).json();
    // Newest first: the edit carries the note, the original publish does not.
    expect(hist[0].note).toBe("Reworked the KPI header");
    expect(hist[hist.length - 1].note).toBeNull();
  });

  it("rejects an over-long message and never mutates the app", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const id = idOf((await call(c, "publish_app", { title: "Cap", html: "<div id=kpi></div>", panels: [REGION_PANEL], params: [REGION_PARAM] })).text);
    const r = await call(c, "update_app", { id, title: "Cap2", message: "x".repeat(501) });
    expect(r.isError).toBe(true);
    expect(r.text.toLowerCase()).toContain("under 500");
    const { cookie } = await login();
    const hist = await (await fetch(`${BASE}/admin/api/app_history?id=${id}`, { headers: { cookie } })).json();
    expect(hist.length).toBe(1); // still just the original publish — no phantom edit
  });
});

describe("public /frame — fresh-execution budget bounds prod load", () => {
  it("serves cache-only (soft error) once an app's budget is spent on distinct params", async () => {
    const c = await gwConnect(BASE, "tok_boss", "pub");
    const N_PARAM = { name: "n", type: "int", default: 0, min: 0, max: 1_000_000 };
    const N_PANEL = { key: "kpi", title: "n", sql: "select :n n", dialect: "postgres" };
    const id = idOf((await call(c, "publish_app", { title: "amp", html: "<div id=kpi></div>", panels: [N_PANEL], params: [N_PARAM] })).text);
    const { cookie, csrf } = await login();
    await fetch(`${BASE}/admin/api/set_visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf, cookie },
      body: JSON.stringify({ id, visibility: "public" }),
    });
    const panelOf = async (n: number): Promise<{ rows: Record<string, unknown>[]; error: string | null }> => {
      const html = await (await fetch(`${BASE}/p/${id}/frame?p.n=${n}`)).text();
      return setokuOf(html).panels.kpi;
    };
    // First distinct value runs fresh against the DB (budget intact).
    expect(String((await panelOf(1)).rows[0].n)).toBe("1");
    // Burn the rest of the burst budget on distinct (uncached) variants, then one
    // more must be rate-limited: cache-only, so the panel reports an error instead
    // of a live query. The query (`select :n`) can't itself error, so any error
    // here IS the budget kicking in (scrubbed to a generic message on the public
    // surface — the un-scrubbed cause is the over-budget soft error).
    let rateLimited = false;
    for (let i = 2; i <= 120; i++) {
      const p = await panelOf(i);
      if (p.error) {
        expect(p.error).toBe("data temporarily unavailable"); // scrubbed, not leaked
        rateLimited = true;
        break;
      }
    }
    expect(rateLimited).toBe(true);
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

describe("freshness stamp ignores errored panels", () => {
  it("newestPanelComputedAt counts only SUCCESSFUL panels (an error stamps 'now')", () => {
    const store = new KnowledgeStore(":memory:");
    // An app whose only cached panel ERRORED — the row is stamped at failure time,
    // which must NOT read as "data updated just now".
    store.putPanelCache("appErr", "bad", { columns: [], rows: [], rowCount: 0, error: "boom" });
    expect(store.newestPanelComputedAt("appErr")).toBeNull();
    // With a good panel present, the stamp is that panel's time, not the errored one.
    store.putPanelCache("appMix", "ok", { columns: [], rows: [], rowCount: 1, error: null });
    store.putPanelCache("appMix", "bad", { columns: [], rows: [], rowCount: 0, error: "boom" });
    expect(store.newestPanelComputedAt("appMix")).toBe(store.getPanelCache("appMix", "ok")!.computedAt);
    store.db.close();
  });
});

describe("cache migration — pre-rename dashboard_cache carries forward", () => {
  it("copies dashboard_cache rows into app_cache and drops the orphan", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "setoku-mig-")), "knowledge.db");
    // Stand up a box as it looked BEFORE the rename: a populated dashboard_cache.
    const old = new Database(f);
    old.run(`CREATE TABLE dashboard_cache (
      dashboard_id TEXT NOT NULL, panel_key TEXT NOT NULL,
      columns TEXT NOT NULL DEFAULT '[]', rows TEXT NOT NULL DEFAULT '[]',
      row_count INTEGER NOT NULL DEFAULT 0, computed_at TEXT NOT NULL, error TEXT,
      PRIMARY KEY (dashboard_id, panel_key))`);
    old.run("INSERT INTO dashboard_cache VALUES ('appY','kpi','[]','[]',7,'2026-01-01T00:00:00.000Z',NULL)");
    old.close();
    // Opening the store runs the in-place migration.
    const store = new KnowledgeStore(f);
    const cached = store.getPanelCache("appY", "kpi");
    expect(cached?.rowCount).toBe(7); // carried forward — no cold start
    expect(store.db.query("SELECT 1 FROM sqlite_master WHERE name='dashboard_cache'").get()).toBeNull();
    store.db.close();
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });
});

describe("publish seeds the FULL result set (no silent 200-row prefix)", () => {
  it("serves all rows on the first render after publish, not a 200-row seed", async () => {
    const c = await gwConnect(BASE, "tok_boss", "seed");
    const panel = { key: "kpi", title: "rows", sql: "select g from generate_series(1, 500) g", dialect: "postgres" };
    const id = idOf((await call(c, "publish_app", { title: "Big seed", html: "<div id=kpi></div>", panels: [panel] })).text);
    // The FIRST view (well within the TTL) is served straight from the publish seed —
    // it must already carry all 500 rows, not a 200-row prefix, and not flag truncated.
    const { cookie } = await login();
    const kpi = setokuOf(await (await fetch(`${BASE}/admin/frame/${id}`, { headers: { cookie } })).text()).panels.kpi;
    expect(kpi.rows.length).toBe(500);
    expect(kpi.truncated).toBe(false);
  });
});

describe("stale-while-revalidate + run-duration telemetry (renderApp direct)", () => {
  // renderApp resolves the business DB in-process (same config path the gateway
  // uses) — point it at this suite's throwaway Postgres.
  process.env.SETOKU_DATABASE_URL = DB_URL;

  /** A minimal published app for direct renderApp calls (no HTTP round-trip). */
  const mkDash = (id: string, sql: string) => ({
    id,
    title: "t",
    format: "app" as const,
    body: "<div id=kpi></div>",
    refreshSeconds: 30,
    visibility: "team" as const,
    createdBy: "test",
    createdAt: new Date().toISOString(),
    archivedAt: null,
    panels: [{ key: "kpi", title: "n", sql, dialect: "postgres" as const }],
    params: [],
  });

  it("records durationMs on a fresh run and serves it from cache", async () => {
    const store = new KnowledgeStore(":memory:");
    const dash = mkDash("swr-dur", "select count(*) n from metrics");
    const cold = await renderApp(store, tmp, dash);
    expect(cold[0].error).toBeNull();
    expect(typeof cold[0].durationMs).toBe("number");
    expect(store.getPanelCache("swr-dur", "kpi")?.durationMs).toBe(cold[0].durationMs!);
    // A within-TTL cache hit carries the duration of the run that produced it.
    const warm = await renderApp(store, tmp, dash);
    expect(warm[0].durationMs).toBe(cold[0].durationMs!);
    store.db.close();
  });

  it("serves stale rows immediately past the TTL and refreshes in the background", async () => {
    const store = new KnowledgeStore(":memory:");
    const dash = mkDash("swr-basic", "select count(*) n from metrics");
    const cold = await renderApp(store, tmp, dash);
    expect(cold[0].error).toBeNull();
    const staleAt = cold[0].computedAt;
    await Bun.sleep(5); // ensure the refresh stamp lands in a later millisecond
    // 60s later: past the 30s TTL, well inside the stale ceiling.
    const stale = await renderApp(store, tmp, dash, { now: Date.now() + 60_000 });
    expect(stale[0].refreshing).toBe(true);
    expect(stale[0].computedAt).toBe(staleAt); // honest "updated N ago" — the OLD stamp
    expect(stale[0].rows).toEqual(cold[0].rows);
    await flushBackgroundPanelRefreshes();
    const refreshed = store.getPanelCache("swr-basic", "kpi")!;
    expect(refreshed.error).toBeNull();
    expect(Date.parse(refreshed.computedAt)).toBeGreaterThan(Date.parse(staleAt));
    // The next view is a plain fresh cache hit — no SWR flag.
    const next = await renderApp(store, tmp, dash);
    expect(next[0].refreshing).toBeFalsy();
    expect(next[0].computedAt).toBe(refreshed.computedAt);
    store.db.close();
  });

  it("budget-denied SWR says rate-limited (not refreshing) and runs nothing", async () => {
    const store = new KnowledgeStore(":memory:");
    const dash = mkDash("swr-budget", "select count(*) n from metrics");
    await renderApp(store, tmp, dash, { tryFreshRun: () => true });
    const before = store.getPanelCache("swr-budget", "kpi")!;
    const stale = await renderApp(store, tmp, dash, { now: Date.now() + 60_000, tryFreshRun: () => false });
    expect(stale[0].refreshing).toBeFalsy();
    expect(stale[0].refreshError).toContain("rate-limited");
    expect(stale[0].rows).toEqual([{ n: "6" }]); // last-good rows still served
    await flushBackgroundPanelRefreshes();
    expect(store.getPanelCache("swr-budget", "kpi")!.computedAt).toBe(before.computedAt); // nothing ran
    store.db.close();
  });

  it("a failing background refresh keeps the last-good rows (stale ceiling still governs)", async () => {
    const store = new KnowledgeStore(":memory:");
    await renderApp(store, tmp, mkDash("swr-fail", "select count(*) n from metrics"));
    const before = store.getPanelCache("swr-fail", "kpi")!;
    // The app's query breaks (e.g. a dropped column) — SWR still serves last-good…
    const broken = mkDash("swr-fail", "select nope from missing_table");
    const stale = await renderApp(store, tmp, broken, { now: Date.now() + 60_000 });
    expect(stale[0].refreshing).toBe(true);
    expect(stale[0].rows).toEqual(before.rows);
    await flushBackgroundPanelRefreshes();
    // …and the failed refresh did NOT clobber the good cache row.
    const after = store.getPanelCache("swr-fail", "kpi")!;
    expect(after.error).toBeNull();
    expect(after.computedAt).toBe(before.computedAt);
    store.db.close();
  });

  it("force bypasses SWR and blocks for fresh rows", async () => {
    const store = new KnowledgeStore(":memory:");
    const dash = mkDash("swr-force", "select count(*) n from metrics");
    const cold = await renderApp(store, tmp, dash);
    await Bun.sleep(5); // ensure the forced run's stamp lands in a later millisecond
    const forced = await renderApp(store, tmp, dash, { force: true, now: Date.now() + 60_000 });
    expect(forced[0].refreshing).toBeFalsy();
    expect(Date.parse(forced[0].computedAt)).toBeGreaterThanOrEqual(Date.parse(cold[0].computedAt));
    expect(forced[0].computedAt).not.toBe(cold[0].computedAt);
    store.db.close();
  });
});

describe("panel row cap decoupled from run_query (byte-bounded render)", () => {
  // Panels render to a human in the iframe, not into the model's context, so the
  // render path passes RENDER_FETCH_CEILING to runPanel — NOT config.rowCap (200,
  // which still governs run_query). The only bound on a panel is MAX_RENDER_ROW_BYTES.
  process.env.SETOKU_DATABASE_URL = DB_URL;

  const mkRowsDash = (id: string, sql: string) => ({
    id, title: "t", format: "app" as const, body: "<div id=kpi></div>",
    refreshSeconds: 30, visibility: "team" as const, createdBy: "test",
    createdAt: new Date().toISOString(), archivedAt: null,
    panels: [{ key: "kpi", title: "n", sql, dialect: "postgres" as const }],
    params: [],
  });

  it("renders the full result set — no 200-row model-context cap on panels", async () => {
    const store = new KnowledgeStore(":memory:");
    // 500 rows > the 200 run_query rowCap; a panel must return them ALL.
    const r = await renderApp(store, tmp, mkRowsDash("cap-full", "select g from generate_series(1, 500) g"));
    expect(r[0].error).toBeNull();
    expect(r[0].rows.length).toBe(500);
    expect(r[0].truncated).toBe(false);
    store.db.close();
  });

  it("trims to the byte budget and marks truncated (a partial table, never dropped)", async () => {
    const store = new KnowledgeStore(":memory:");
    // Wide rows whose full set (~12k × ~400B) blows past MAX_RENDER_ROW_BYTES (3.5MB).
    const r = await renderApp(store, tmp, mkRowsDash("cap-bytes", "select g, repeat('x', 400) pad from generate_series(1, 12000) g"));
    expect(r[0].error).toBeNull(); // trimmed to fit — NOT dropped with an error
    expect(r[0].truncated).toBe(true);
    expect(r[0].rows.length).toBeGreaterThan(0); // still a usable prefix
    expect(r[0].rows.length).toBeLessThan(12000);
    expect(JSON.stringify(r[0].rows).length).toBeLessThanOrEqual(MAX_RENDER_ROW_BYTES);
    store.db.close();
  });

  it("splits the byte budget fairly across panels — none is dropped whole", async () => {
    const store = new KnowledgeStore(":memory:");
    // Two panels each ~3.3MB (under the 3.5MB per-panel budget on their own) but
    // ~6.6MB together — capRenderBytes must trim BOTH to a fair share, not vanish one.
    const wide = "select g, repeat('x', 400) pad from generate_series(1, 8000) g";
    const dash = {
      id: "cap-fair", title: "t", format: "app" as const, body: "<div></div>",
      refreshSeconds: 30, visibility: "team" as const, createdBy: "test", createdAt: new Date().toISOString(), archivedAt: null,
      panels: [{ key: "a", title: "a", sql: wide, dialect: "postgres" as const }, { key: "b", title: "b", sql: wide, dialect: "postgres" as const }],
      params: [],
    };
    const r = await renderApp(store, tmp, dash);
    const byKey = Object.fromEntries(r.map((p) => [p.key, p]));
    for (const k of ["a", "b"]) {
      expect(byKey[k].error).toBeNull();       // trimmed, not dropped with an error
      expect(byKey[k].truncated).toBe(true);
      expect(byKey[k].rows.length).toBeGreaterThan(0);
    }
    expect(r.reduce((n, p) => n + JSON.stringify(p.rows).length, 0)).toBeLessThanOrEqual(MAX_RENDER_ROW_BYTES);
    store.db.close();
  });

  it("persists and reads back the truncated flag (rows without it read false)", () => {
    const store = new KnowledgeStore(":memory:");
    store.putPanelCache("t", "cut", { columns: ["g"], rows: [{ g: 1 }], rowCount: 1, truncated: true });
    expect(store.getPanelCache("t", "cut")!.truncated).toBe(true);
    store.putPanelCache("t", "whole", { columns: ["g"], rows: [{ g: 1 }], rowCount: 1 });
    expect(store.getPanelCache("t", "whole")!.truncated).toBe(false);
    store.db.close();
  });
});
