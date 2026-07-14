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
      if (sql.includes("ingest_heartbeats")) return { columns: ["connector", "beat"], rows: [] };
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
