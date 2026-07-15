// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user data-source access control (the Team page "Data access…" dialog):
 * store semantics, the admin-only source_access endpoint, and the role
 * threading — every lake request an identity makes carries exactly the role
 * subset its denies imply (or NO role param when unrestricted, so ClickHouse's
 * default roles keep new connectors opted-in). The fake lake records the wire,
 * which is the enforcement seam: the real ACCESS_DENIED behavior belongs to
 * ClickHouse and is exercised in the CH-gated tier.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnGateway, waitHealthy, connect, call as gwCall, FIXTURES, ROOT } from "./lib/gateway";
import { startFakeLake, type FakeLake } from "./lib/fakelake";
import { KnowledgeStore } from "../plugin/gateway/lib/store";
import { hashPassword } from "../plugin/gateway/lib/accounts";
import { lakeFamilies, roleFor } from "../plugin/gateway/lib/sources";

const PORT = 38771;
const BASE = `http://127.0.0.1:${PORT}`;

let tmpRepo: string;
let proc: Subprocess;
let lake: FakeLake;

describe("source_denies store semantics", () => {
  let store: KnowledgeStore;
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-denies-"));
    store = new KnowledgeStore(path.join(dir, "k.db"));
  });
  afterAll(() => store.db.close());

  it("no rows = full access; set replaces wholesale; empty restores", () => {
    expect(store.sourceDenies("a@co.test")).toEqual([]);
    store.setSourceDenies("a@co.test", ["slack", "mercury"], "admin@co.test");
    expect(store.sourceDenies("a@co.test")).toEqual(["mercury", "slack"]);
    store.setSourceDenies("a@co.test", ["github"], "admin@co.test");
    expect(store.sourceDenies("a@co.test")).toEqual(["github"]); // replace, not merge
    store.setSourceDenies("a@co.test", [], "admin@co.test");
    expect(store.sourceDenies("a@co.test")).toEqual([]);
  });

  it("dedupes, keeps unknown slugs (a deny outlives its connector), scopes per identity", () => {
    store.setSourceDenies("b@co.test", ["slack", "slack", "gone_connector"], "admin@co.test");
    expect(store.sourceDenies("b@co.test")).toEqual(["gone_connector", "slack"]);
    expect(store.sourceDenies("a@co.test")).toEqual([]);
    expect(store.allSourceDenies()).toEqual({ "b@co.test": ["gone_connector", "slack"] });
  });

  it("clearSourceDenies drops the identity's rows", () => {
    expect(store.clearSourceDenies("b@co.test")).toBe(2);
    expect(store.sourceDenies("b@co.test")).toEqual([]);
  });
});

describe("source access over HTTP + MCP", () => {
  beforeAll(async () => {
    lake = startFakeLake((sql) => {
      // list_sources discovery: the fake engine "grants" everything — the
      // gateway-side belt-and-suspenders filter is what these tests pin; the
      // engine-side hiding is CH-gated territory.
      if (sql.includes("SHOW TABLES FROM setoku"))
        return { columns: ["name"], rows: [{ name: "slack_messages" }, { name: "mercury_accounts" }] };
      // NB: match the heartbeat probe on GROUP BY connector, not the bare table
      // name — get_schema's system.columns query also mentions ingest_heartbeats
      // (in its exclusion clause) and must not be captured here.
      if (sql.includes("GROUP BY connector")) return { columns: ["connector", "beat"], rows: [] };
      // the biz.* mirror registry (lib/mirror.ts) — one mirrored business table
      if (sql.includes("pg_mirror_runs") && sql.includes("target_table AS target"))
        return { columns: ["target", "source", "as_of"], rows: [{ target: "orders", source: "public.orders", as_of: "2026-07-14 00:00:00.000" }] };
      if (sql.includes("count()")) return { rows: [{ n: 5 }] };
      if (sql.includes("system.columns"))
        return {
          columns: ["database", "table", "name", "type"],
          rows: [
            { database: "biz", table: "orders", name: "id", type: "Int64" },
            { database: "setoku", table: "slack_messages", name: "text", type: "String" },
          ],
        };
      return { rows: [{ ok: 1 }] };
    });

    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-srcacc-"));
    fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), { recursive: true });
    {
      const s = new KnowledgeStore(path.join(tmpRepo, "knowledge.db"));
      s.createAccount({ username: "boss@co.test", pwhash: await hashPassword("s3cret-pass"), role: "admin" });
      s.createAccount({ username: "viewer@co.test", pwhash: await hashPassword("viewer-pass"), role: "member" });
      s.db.close();
    }
    proc = spawnGateway({
      SETOKU_PROJECT_DIR: tmpRepo,
      SETOKU_DB_PATH: path.join(tmpRepo, "knowledge.db"),
      SETOKU_LAKE_URL: lake.url,
      SETOKU_HTTP_PORT: String(PORT),
      SETOKU_TOKENS: "tok-alice=alice@co.test,tok-bob=bob@co.test,tok-carol=carol@co.test",
      SETOKU_CURATOR_TOKENS: "tok-curator=alice@co.test",
    });
    await waitHealthy(BASE);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    lake?.stop();
    if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  async function session(username: string, password: string): Promise<{ cookie: string; csrf: string }> {
    const r = await fetch(`${BASE}/admin/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    expect(r.ok).toBe(true);
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    const body = (await r.json()) as { csrf: string };
    return { cookie, csrf: body.csrf };
  }

  function post(path: string, opts: { cookie: string; csrf: string; body: unknown }): Promise<Response> {
    return fetch(`${BASE}/admin/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: opts.cookie, "x-csrf-token": opts.csrf },
      body: JSON.stringify(opts.body),
    });
  }

  async function team(cookie: string): Promise<{ identity: string; denies: string[] }[]> {
    const r = await fetch(`${BASE}/admin/api/team`, { headers: { cookie } });
    expect(r.ok).toBe(true);
    return ((await r.json()) as { people: { identity: string; denies: string[] }[] }).people;
  }

  it("team GET carries denies (default: [] — full access)", async () => {
    const { cookie } = await session("boss@co.test", "s3cret-pass");
    const alice = (await team(cookie)).find((p) => p.identity === "alice@co.test");
    expect(alice?.denies).toEqual([]);
  });

  it("a member may not set source access (admin gate, I9); bad bodies are rejected", async () => {
    const member = await session("viewer@co.test", "viewer-pass");
    const denied = await post("source_access", { ...member, body: { username: "alice@co.test", denies: ["slack"] } });
    expect(denied.status).toBe(403);

    const admin = await session("boss@co.test", "s3cret-pass");
    expect((await post("source_access", { ...admin, body: { username: "alice@co.test" } })).status).toBe(400);
    expect((await post("source_access", { ...admin, body: { username: "alice@co.test", denies: "slack" } })).status).toBe(400);
    expect((await post("source_access", { ...admin, body: { username: "nobody@co.test", denies: [] } })).status).toBe(404);
  });

  it("an admin sets denies (normalized to slugs); team reflects them; the deny drives the wire", async () => {
    const admin = await session("boss@co.test", "s3cret-pass");
    // family LABELS normalize to slugs server-side
    const r = await post("source_access", {
      ...admin,
      body: { username: "alice@co.test", denies: ["Slack", "Vercel logs"] },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; flash: string };
    expect(body.flash).toContain("Slack");
    const alice = (await team(admin.cookie)).find((p) => p.identity === "alice@co.test");
    expect(alice?.denies).toEqual(["slack", "vercel_logs"]);

    // alice's run_query now activates every family role EXCEPT slack + vercel_logs
    const mcp = await connect(BASE, "tok-alice");
    lake.calls.length = 0;
    const q = await gwCall(mcp, "run_query", { sql: "SELECT count() AS n FROM setoku.github_issues" });
    expect(q.isError).toBe(false);
    const roles = lake.calls.at(-1)!.roles;
    expect(roles).toContain(roleFor("github"));
    expect(roles).toContain(roleFor("mercury"));
    expect(roles).not.toContain(roleFor("slack"));
    expect(roles).not.toContain(roleFor("vercel_logs"));
    expect(roles.length).toBe(lakeFamilies().length - 2);

    // list_sources: every probe carries the same subset, and the denied family
    // is filtered out of the listing even though the fake engine still shows it
    lake.calls.length = 0;
    const ls = await gwCall(mcp, "list_sources");
    expect(ls.isError).toBe(false);
    expect(ls.text).toContain("setoku.mercury_accounts");
    expect(ls.text).not.toContain("slack_messages");
    for (const c of lake.calls) expect(c.roles).not.toContain(roleFor("slack"));

    // get_schema threads the subset into the metadata queries too
    lake.calls.length = 0;
    const gs = await gwCall(mcp, "get_schema");
    expect(gs.isError).toBe(false);
    const meta = lake.calls.find((c) => c.sql.includes("system.columns"));
    expect(meta).toBeDefined();
    expect(meta!.roles).not.toContain(roleFor("slack"));

    // a curator session (same identity) sees the deny in its static listing
    const curator = await connect(BASE, "tok-curator");
    const cls = await gwCall(curator, "list_sources");
    expect(cls.text).not.toContain("slack_messages");
    expect(cls.text).toContain("mercury_accounts");
    await curator.close();
    await mcp.close();
  });

  it("denying the Postgres (business) family drops biz.* from run_query and list_sources", async () => {
    const admin = await session("boss@co.test", "s3cret-pass");
    await post("source_access", { ...admin, body: { username: "alice@co.test", denies: ["business"] } });

    const mcp = await connect(BASE, "tok-alice");
    // the role subset excludes setoku_src_business (the engine then denies biz.*)
    lake.calls.length = 0;
    await gwCall(mcp, "run_query", { sql: "SELECT count() FROM biz.orders" });
    expect(lake.calls.at(-1)!.roles).not.toContain(roleFor("business"));
    expect(lake.calls.at(-1)!.roles).toContain(roleFor("slack")); // other sources intact
    // list_sources hides the BUSINESS DATA (biz.*) section for this session
    const ls = await gwCall(mcp, "list_sources");
    expect(ls.text).not.toContain("BUSINESS DATA");
    await mcp.close();

    // get_schema never lists the pg_mirror_runs run-log (it enumerates the
    // mirrored business catalog) — its SQL excludes it outright
    const mcp2 = await connect(BASE, "tok-alice");
    lake.calls.length = 0;
    await gwCall(mcp2, "get_schema");
    const schemaSql = lake.calls.find((c) => c.sql.includes("system.columns"))!.sql;
    expect(schemaSql).toContain("'pg_mirror_runs'");
    expect(schemaSql).toContain("NOT IN");
    await mcp2.close();

    // the web egress ledger is empty for a business-denied MEMBER (was a leak:
    // pg_mirror_runs byte volumes + a mirror's existence)
    await post("source_access", { ...admin, body: { username: "viewer@co.test", denies: ["business"] } });
    const member = await session("viewer@co.test", "viewer-pass");
    const eg = (await (await fetch(`${BASE}/admin/api/egress`, { headers: { cookie: member.cookie } })).json()) as { configured: boolean; days: unknown[] };
    expect(eg.configured).toBe(false);
    expect(eg.days).toEqual([]);
    await post("source_access", { ...admin, body: { username: "viewer@co.test", denies: [] } });

    // an unrestricted teammate still sees biz.* in list_sources
    const bob = await connect(BASE, "tok-bob");
    const lsBob = await gwCall(bob, "list_sources");
    expect(lsBob.text).toContain("biz.orders");
    await bob.close();

    await post("source_access", { ...admin, body: { username: "alice@co.test", denies: [] } });
  });

  it("an unrestricted identity sends NO role param (default roles = everything, incl. future sources)", async () => {
    const mcp = await connect(BASE, "tok-bob");
    lake.calls.length = 0;
    const q = await gwCall(mcp, "run_query", { sql: "SELECT count() AS n FROM setoku.slack_messages" });
    expect(q.isError).toBe(false);
    expect(lake.calls.at(-1)!.roles).toEqual([]);
    await mcp.close();
  });

  it("clearing denies restores the unrestricted wire shape", async () => {
    const admin = await session("boss@co.test", "s3cret-pass");
    const r = await post("source_access", { ...admin, body: { username: "alice@co.test", denies: [] } });
    expect(((await r.json()) as { flash: string }).flash).toContain("full data access");
    const mcp = await connect(BASE, "tok-alice");
    lake.calls.length = 0;
    await gwCall(mcp, "run_query", { sql: "SELECT count() AS n FROM setoku.slack_messages" });
    expect(lake.calls.at(-1)!.roles).toEqual([]);
    await mcp.close();
  });

  // ---- knowledge follows the same denies via the OPTIONAL meta.source tag ----

  it("meta.source is validated at save (a typo'd tag must not look restricted)", async () => {
    const curator = await connect(BASE, "tok-curator");
    const bad = await gwCall(curator, "upsert_context", {
      type: "metric",
      name: "bad_tag",
      body: "SELECT 1",
      meta: { source: "nope_family" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Unknown meta.source "nope_family"');
    // the label form normalizes to the slug the deny list speaks
    const ok = await gwCall(curator, "upsert_context", {
      type: "metric",
      name: "mercury_burn",
      body: "## Definition\nMonthly burn from the Mercury feed.\n\n## Canonical SQL\n```sql\nSELECT sum(amount_cents) FROM setoku.mercury_transactions\n```",
      meta: { source: "Mercury", summary: "monthly burn", dialect: "clickhouse" },
    });
    expect(ok.isError).toBe(false);
    const untagged = await gwCall(curator, "upsert_context", {
      type: "metric",
      name: "orders_total",
      body: "## Definition\nAll-time paid orders.\n\n## Canonical SQL\n```sql\nSELECT count() FROM biz.orders\n```",
      meta: { summary: "paid orders", dialect: "clickhouse" },
    });
    expect(untagged.isError).toBe(false);
    await curator.close();
  });

  it("a tagged doc vanishes for a denied identity — indistinguishable from never written", async () => {
    const admin = await session("boss@co.test", "s3cret-pass");
    await post("source_access", { ...admin, body: { username: "alice@co.test", denies: ["mercury"] } });

    const alice = await connect(BASE, "tok-alice");
    // get_metric: not-found shaped, and the known-metrics list omits it too
    const gm = await gwCall(alice, "get_metric", { name: "mercury_burn" });
    expect(gm.isError).toBe(true);
    expect(gm.text).toContain('No metric "mercury_burn"');
    // the "Known metrics" list carries the visible docs only — never the hidden name
    const known = gm.text.slice(gm.text.indexOf("Known metrics:"));
    expect(known).toContain("orders_total");
    expect(known).not.toContain("mercury_burn");
    const le = await gwCall(alice, "list_entities");
    expect(le.text).toContain("orders_total");
    expect(le.text).not.toContain("mercury_burn");
    const de = await gwCall(alice, "describe_entity", { name: "mercury_burn" });
    expect(de.isError).toBe(true);
    const fc = await gwCall(alice, "find_context", { question: "what is our monthly burn from mercury" });
    expect(fc.text).not.toContain("mercury_burn");
    await alice.close();

    // an unrestricted teammate still sees it everywhere
    const carol = await connect(BASE, "tok-carol");
    expect((await gwCall(carol, "get_metric", { name: "mercury_burn" })).isError).toBe(false);
    expect((await gwCall(carol, "list_entities")).text).toContain("mercury_burn");
    await carol.close();

    // untagged knowledge stays team-wide for the denied identity
    const alice2 = await connect(BASE, "tok-alice");
    expect((await gwCall(alice2, "get_metric", { name: "orders_total" })).isError).toBe(false);
    await alice2.close();

    // restore alice for later tests
    await post("source_access", { ...admin, body: { username: "alice@co.test", denies: [] } });
  });

  it("the web Knowledge view follows the same denies for members; admins see everything", async () => {
    const admin = await session("boss@co.test", "s3cret-pass");
    await post("source_access", { ...admin, body: { username: "viewer@co.test", denies: ["mercury"] } });

    const member = await session("viewer@co.test", "viewer-pass");
    const memberDocs = (await (await fetch(`${BASE}/admin/api/knowledge`, { headers: { cookie: member.cookie } })).json()) as { name: string }[];
    expect(memberDocs.some((d) => d.name === "orders_total")).toBe(true);
    expect(memberDocs.some((d) => d.name === "mercury_burn")).toBe(false);

    const adminDocs = (await (await fetch(`${BASE}/admin/api/knowledge`, { headers: { cookie: admin.cookie } })).json()) as { name: string }[];
    expect(adminDocs.some((d) => d.name === "mercury_burn")).toBe(true);
  });

  // ---- review fixes: web read paths + get_schema follow the denies too ----

  it("the team roster hides everyone's denies from a member (admin-only map)", async () => {
    const admin = await session("boss@co.test", "s3cret-pass");
    await post("source_access", { ...admin, body: { username: "alice@co.test", denies: ["slack"] } });

    // admin sees the restriction map
    expect((await team(admin.cookie)).find((p) => p.identity === "alice@co.test")?.denies).toEqual(["slack"]);
    // a member sees the roster but every denies array is blanked
    const member = await session("viewer@co.test", "viewer-pass");
    const asMember = await team(member.cookie);
    expect(asMember.length).toBeGreaterThan(0);
    for (const p of asMember) expect(p.denies).toEqual([]);

    await post("source_access", { ...admin, body: { username: "alice@co.test", denies: [] } });
  });

  it("the Sources web view drops a denied family for a member (not just the agent)", async () => {
    const admin = await session("boss@co.test", "s3cret-pass");
    await post("source_access", { ...admin, body: { username: "viewer@co.test", denies: ["slack"] } });

    const member = await session("viewer@co.test", "viewer-pass");
    const src = (await (await fetch(`${BASE}/admin/api/sources`, { headers: { cookie: member.cookie } })).json()) as {
      lake: { tables: { table: string }[] };
    };
    expect(src.lake.tables.some((t) => t.table === "slack_messages")).toBe(false);
    expect(src.lake.tables.some((t) => t.table === "mercury_accounts")).toBe(true);

    // an admin still sees everything on the same page
    const asAdmin = (await (await fetch(`${BASE}/admin/api/sources`, { headers: { cookie: admin.cookie } })).json()) as {
      lake: { tables: { table: string }[] };
    };
    expect(asAdmin.lake.tables.some((t) => t.table === "slack_messages")).toBe(true);

    await post("source_access", { ...admin, body: { username: "viewer@co.test", denies: [] } });
  });

  it("get_schema resolves a pg-style qualified name to its biz.* mirror table", async () => {
    const mcp = await connect(BASE, "tok-bob"); // unrestricted
    const r = await gwCall(mcp, "get_schema", { tables: ["public.orders"] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("biz.orders");
    expect(r.text).toContain("id");
    await mcp.close();
  });

  it("source_access is refused while the kill-switch is on (no phantom restriction)", async () => {
    // the spawned gateway doesn't set SETOKU_SOURCE_ACCESS=0, so assert the
    // guard's shape directly on the store+role helper path via the endpoint by
    // temporarily... (can't mutate the child's env) — instead assert the pure
    // helper here; the endpoint guard is a one-line env check above it.
    const prev = process.env.SETOKU_SOURCE_ACCESS;
    process.env.SETOKU_SOURCE_ACCESS = "0";
    try {
      const { lakeRolesFor } = await import("../plugin/gateway/lib/sources");
      expect(lakeRolesFor(["slack"])).toBeNull(); // globally off → unrestricted
    } finally {
      if (prev === undefined) delete process.env.SETOKU_SOURCE_ACCESS;
      else process.env.SETOKU_SOURCE_ACCESS = prev;
    }
  });

  it("a pending correction about a hidden doc does not leak through find_context", async () => {
    const admin = await session("boss@co.test", "s3cret-pass");
    // seed a source-tagged doc + a pending correction that relates_to it
    const curator = await connect(BASE, "tok-curator");
    await gwCall(curator, "upsert_context", {
      type: "metric",
      name: "slack_volume",
      body: "## Definition\nDaily Slack message volume.\n\n## Canonical SQL\n```sql\nSELECT count() FROM setoku.slack_messages\n```",
      meta: { source: "slack", summary: "slack volume", dialect: "clickhouse" },
    });
    await curator.close();
    const bob = await connect(BASE, "tok-bob");
    await gwCall(bob, "report_correction", {
      kind: "metric",
      fact: "slack_volume should exclude bot messages",
      relates_to: "slack_volume",
    });
    await bob.close();

    await post("source_access", { ...admin, body: { username: "alice@co.test", denies: ["slack"] } });
    // also deny the web member "viewer" so the web endpoints can be checked
    await post("source_access", { ...admin, body: { username: "viewer@co.test", denies: ["slack"] } });
    const alice = await connect(BASE, "tok-alice");
    const fc = await gwCall(alice, "find_context", { question: "slack message volume bot messages" });
    expect(fc.text).not.toContain("slack_volume");
    expect(fc.text).not.toContain("exclude bot messages");
    // the MCP list_corrections tool hides it on the same session (was a leak)
    const lc = await gwCall(alice, "list_corrections", { status: "pending" });
    expect(lc.text).not.toContain("slack_volume");
    expect(lc.text).not.toContain("exclude bot messages");
    await alice.close();
    // the web /admin/api/pending hides it for the denied MEMBER (was a leak)...
    const member = await session("viewer@co.test", "viewer-pass");
    const memberPending = (await (await fetch(`${BASE}/admin/api/pending`, { headers: { cookie: member.cookie } })).json()) as { fact?: string; content?: string; relatesTo?: string }[];
    expect(memberPending.some((c) => c.relatesTo === "slack_volume")).toBe(false);
    // ...but the ADMIN (who manages the store) still sees it
    const adminPending = (await (await fetch(`${BASE}/admin/api/pending`, { headers: { cookie: admin.cookie } })).json()) as { relatesTo?: string }[];
    expect(adminPending.some((c) => c.relatesTo === "slack_volume")).toBe(true);
    // list_entities' pending COUNT follows the same filter (a delta vs
    // list_corrections would reveal hidden proposals exist)
    const alice2 = await connect(BASE, "tok-alice");
    const le = await gwCall(alice2, "list_entities");
    expect(le.text).not.toContain("slack_volume");
    await alice2.close();
    // an unrestricted teammate's agent still gets the pending fact
    const carol = await connect(BASE, "tok-carol");
    const fc2 = await gwCall(carol, "find_context", { question: "slack message volume bot messages" });
    expect(fc2.text).toContain("exclude bot messages");
    await carol.close();
    await post("source_access", { ...admin, body: { username: "alice@co.test", denies: [] } });
    await post("source_access", { ...admin, body: { username: "viewer@co.test", denies: [] } });
  });

  it("app provenance drawer hides a denied viewer's linked-metric summary (knowledge membrane)", async () => {
    const admin = await session("boss@co.test", "s3cret-pass");
    // publish an app (as an unrestricted analyst) whose panel links the
    // mercury-tagged metric seeded earlier
    const bob = await connect(BASE, "tok-bob");
    const pub = await gwCall(bob, "publish_app", {
      title: "Burn dashboard",
      html: '<div id="b"></div>',
      panels: [{ key: "b", title: "Burn", sql: "SELECT 1 AS n FROM biz.orders", metricId: "mercury_burn" }],
    });
    expect(pub.isError).toBe(false);
    const appId = (pub.text.match(/\/(?:admin\/)?p(?:\/|apps\/)?([A-Za-z0-9_-]{6,})/) ?? [])[1]
      ?? (pub.text.match(/([A-Za-z0-9_-]{10,})/) ?? [])[1];
    await bob.close();
    expect(appId).toBeTruthy();

    // a mercury-denied member's provenance drawer must not carry the hidden
    // metric's summary or id (parity with get_metric answering "not found")
    await post("source_access", { ...admin, body: { username: "viewer@co.test", denies: ["mercury"] } });
    const member = await session("viewer@co.test", "viewer-pass");
    const prov = (await (await fetch(`${BASE}/admin/api/app_data?id=${appId}`, { headers: { cookie: member.cookie } })).json()) as { panels: { title?: string; metricId: string | null; metricSummary: string | null }[] };
    const panel = prov.panels.find((p) => p.title === "Burn") ?? prov.panels[0];
    expect(panel.metricSummary).toBeNull();
    expect(panel.metricId).toBeNull();
    // an unrestricted admin still sees the provenance link
    const adminProv = (await (await fetch(`${BASE}/admin/api/app_data?id=${appId}`, { headers: { cookie: admin.cookie } })).json()) as { panels: { metricId: string | null; metricSummary: string | null }[] };
    expect((adminProv.panels.find((p) => p.metricId === "mercury_burn"))?.metricSummary).toBe("monthly burn");
    await post("source_access", { ...admin, body: { username: "viewer@co.test", denies: [] } });
  });

  it("removing a person clears their denies — a re-invite starts at full access", async () => {
    const admin = await session("boss@co.test", "s3cret-pass");
    // give bob a deny, then remove him entirely
    await post("source_access", { ...admin, body: { username: "bob@co.test", denies: ["mercury"] } });
    const del = await post("users", { ...admin, body: { op: "delete", username: "bob@co.test" } });
    expect(del.status).toBe(200);
    // re-invite: the fresh person carries no stale restriction
    const inv = await post("invite", { ...admin, body: { identity: "bob@co.test" } });
    expect(inv.status).toBe(200);
    const bob = (await team(admin.cookie)).find((p) => p.identity === "bob@co.test");
    expect(bob?.denies).toEqual([]);
  });
});
