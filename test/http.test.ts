// SPDX-License-Identifier: Apache-2.0
/**
 * e2e for the deployed (HTTP) profile: spawn the actual http.ts entry, connect
 * with the SDK's Streamable-HTTP client using bearer tokens, verify auth →
 * identity → audit attribution, and that knowledge + data tools work over HTTP.
 * Reuses the Postgres database created by e2e.test.ts's fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pgPkg from "pg";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnGateway, waitHealthy, connect as gwConnect, call, FIXTURES, ROOT } from "./lib/gateway";

const { Client: PgClient } = pgPkg;

const PG_HOST = process.env.SETOKU_E2E_PG_HOST ?? "/tmp";
const DB_NAME = "setoku_e2e_http";
const DB_URL =
  process.env.SETOKU_E2E_HTTP_DB_URL ??
  `postgresql:///${DB_NAME}?host=${encodeURIComponent(PG_HOST)}`;
const PORT = 38719;
const BASE = `http://127.0.0.1:${PORT}`;

let tmpRepo: string;
let proc: Subprocess;

const connect = (token: string | null) => gwConnect(BASE, token, "http-e2e");

beforeAll(async () => {
  // database
  const admin = new PgClient({
    host: PG_HOST,
    database: process.env.SETOKU_E2E_PG_MAINTENANCE_DB ?? "template1",
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const db = new PgClient({ host: PG_HOST, database: DB_NAME });
  await db.connect();
  await db.query(fs.readFileSync(path.join(FIXTURES, "schema.sql"), "utf8"));
  await db.end();

  // project dir with config + seed context
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-http-"));
  fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), {
    recursive: true,
  });

  // a teammate token added the way `admin-cli add-teammate` writes it: a JSON
  // {token: identity} file loaded via SETOKU_TOKENS_FILE (the hot-pluggable path)
  fs.writeFileSync(
    path.join(tmpRepo, "teammates.json"),
    JSON.stringify({ "tok-carol": "carol@co.test" }),
  );

  // bootstrap admin + member accounts the way the CLI does (Phase 5.1)
  {
    const { KnowledgeStore } = await import(
      path.join(ROOT, "plugin", "gateway", "lib", "store.ts")
    );
    const { hashPassword } = await import(
      path.join(ROOT, "plugin", "gateway", "lib", "accounts.ts")
    );
    const s = new KnowledgeStore(path.join(tmpRepo, "knowledge.db"));
    s.createAccount({ username: "boss", pwhash: await hashPassword("s3cret-pass"), role: "admin" });
    s.createAccount({ username: "viewer", pwhash: await hashPassword("viewer-pass"), role: "member" });
    s.db.close();
  }

  // spawn the HTTP gateway exactly as a container would run it
  proc = spawnGateway({
    SETOKU_PROJECT_DIR: tmpRepo,
    SETOKU_DB_PATH: path.join(tmpRepo, "knowledge.db"),
    SETOKU_E2E_DB_URL: DB_URL,
    SETOKU_HTTP_PORT: String(PORT),
    SETOKU_TOKENS: "tok-alice=alice@co.test,tok-bob=bob@co.test",
    SETOKU_TOKENS_FILE: path.join(tmpRepo, "teammates.json"),
    // exercise dependency pings: the gateway pings its own /health
    SETOKU_HEALTHZ_PING: `self=http://127.0.0.1:${PORT}/health,down=http://127.0.0.1:1/nope`,
  });
  await waitHealthy(BASE);
}, 30_000);

afterAll(async () => {
  proc?.kill();
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe("auth", () => {
  it("rejects missing token", async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(401);
  });

  it("rejects a bogus token", async () => {
    expect(connect("tok-evil")).rejects.toThrow();
  });

  it("authenticates via token in the URL path (/mcp/<token>) for the custom-connector dialog", async () => {
    const client = new McpClient({ name: "http-e2e-path", version: "0.0.1" });
    // NO Authorization header — token is in the path, as the Add-custom-connector URL would be
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/tok-alice`));
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("find_context");
    await client.close();
  });

  it("rejects a bogus token in the URL path", async () => {
    const client = new McpClient({ name: "http-e2e-path-bad", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/nope`));
    expect(client.connect(transport)).rejects.toThrow();
  });
});

describe("tools over HTTP", () => {
  it("serves knowledge + data with a valid token", async () => {
    const alice = await connect("tok-alice");
    const { tools } = await alice.listTools();
    expect(tools.map((t) => t.name)).toContain("find_context");
    const fc = await call(alice, "find_context", {
      question: "how much revenue last month?",
    });
    expect(fc.text).toContain("Refunded orders must be excluded");
    const rq = await call(alice, "run_query", {
      sql: "SELECT SUM(total_cents)/100.0 AS rev FROM orders WHERE status='paid'",
      purpose: "http e2e",
    });
    expect(rq.isError).toBe(false);
    expect(rq.text).toContain("225");
    await alice.close();
  });

  it("a teammate token from SETOKU_TOKENS_FILE authenticates as analyst (add-teammate path)", async () => {
    const carol = await connect("tok-carol");
    const names = (await carol.listTools()).tools.map((t) => t.name);
    // read + propose, but no curated-write tools — the safe default for everyone
    expect(names).toContain("find_context");
    expect(names).toContain("report_correction");
    expect(names).not.toContain("upsert_context");
    const fc = await call(carol, "find_context", { question: "revenue?" });
    expect(fc.isError).toBe(false);
    await carol.close();
  });

  it("attributes each token's calls to its own identity in the shared audit log", async () => {
    const bob = await connect("tok-bob");
    await call(bob, "report_correction", {
      kind: "gotcha",
      content:
        "Gift-card orders have total_cents = 0 and are excluded from AOV",
    });
    await bob.close();

    const { Database } = await import("bun:sqlite");
    const db = new Database(path.join(tmpRepo, "knowledge.db"), {
      readonly: true,
    });
    const users = (
      db.query("SELECT DISTINCT user FROM audit ORDER BY user").all() as {
        user: string;
      }[]
    ).map((r) => r.user);
    const bobCorrection = db
      .query("SELECT user FROM corrections WHERE content LIKE '%Gift-card%'")
      .get() as { user: string } | null;
    db.close();
    expect(users).toContain("alice@co.test");
    expect(users).toContain("bob@co.test");
    expect(bobCorrection?.user).toBe("bob@co.test");
  });

  it("bob sees alice-era pending knowledge instantly (one shared store)", async () => {
    const alice = await connect("tok-alice");
    // propose-only over HTTP: report_correction (pending), not upsert_context
    await call(alice, "report_correction", {
      kind: "gotcha",
      content:
        "Wholesale orders are tagged via order_items.sku prefix WS- and excluded from retail metrics",
    });
    await alice.close();
    const bob = await connect("tok-bob");
    const fc = await call(bob, "find_context", {
      question: "do retail metrics include wholesale orders?",
    });
    expect(fc.text).toContain("WS-");
    await bob.close();
  });

  it("the deployed gateway is propose-only: no curated-write tools (I2/I9)", async () => {
    const alice = await connect("tok-alice");
    const names = (await alice.listTools()).tools.map((t) => t.name);
    expect(names).toContain("report_correction"); // propose path stays
    expect(names).not.toContain("upsert_context");
    expect(names).not.toContain("resolve_correction");
    // and a forged call is rejected, not silently executed
    const blocked = await call(alice, "upsert_context", {
      type: "gotcha",
      name: "x",
      body: "y",
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/not found/i);
    await alice.close();
  });
});

describe("approval surface (the human accept path, Phase 5.1/5.5/5.6)", () => {
  /** Log in with a local account; return the session cookie. */
  async function login(username: string, password: string): Promise<Response> {
    return fetch(`${BASE}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
      redirect: "manual",
    });
  }
  async function cookieFor(username: string, password: string): Promise<string> {
    const r = await login(username, password);
    expect(r.status).toBe(303);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    return setCookie.split(";")[0];
  }

  it("the bare /admin link is safe to share — no session shows a login form, no secret in any URL", async () => {
    const r = await fetch(`${BASE}/admin`);
    expect(r.status).toBe(200);
    const page = await r.text();
    expect(page).toContain("sign in");
    expect(page).toContain("password");
    expect(page).not.toContain("Pending (");
  });

  it("an MCP bearer token is NOT an admin credential — an agent cannot log in (I9)", async () => {
    // the exact token an agent holds for MCP, tried as username and password
    for (const creds of [
      { username: "tok-alice", password: "tok-alice" },
      { username: "alice@co.test", password: "tok-alice" },
    ]) {
      const r = await login(creds.username, creds.password);
      expect(r.status).toBe(401);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
  });

  it("rejects a wrong password", async () => {
    const r = await login("boss", "wrong");
    expect(r.status).toBe(401);
  });

  it("an admin approves a pending gotcha → it enters verified context; agents never could", async () => {
    // 1. an agent proposes (propose-only — all the agent can do)
    const alice = await connect("tok-alice");
    await call(alice, "report_correction", {
      kind: "gotcha",
      content:
        "Gift-card top-ups post to ledger_entries with type=GC and are excluded from net revenue",
    });
    await alice.close();

    // 2. a human signs in with their ADMIN ACCOUNT (not the MCP token) and sees it
    const cookie = await cookieFor("boss", "s3cret-pass");
    const page = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text();
    expect(page).toContain("Gift-card top-ups");
    expect(page).toContain("Approve");
    const id = page.match(/name="id" value="(\d+)"/)![1];
    const csrf = page.match(/name="csrf" value="([^"]+)"/)![1];

    // 3. the human POSTs Approve — the commit happens here, outside any agent
    const post = await fetch(`${BASE}/admin/resolve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ id, csrf, action: "accepted", reason: "confirmed with finance" }),
      redirect: "manual",
    });
    expect(post.status).toBe(303);

    // 4. it now surfaces as verified context to a fresh agent session
    const bob = await connect("tok-bob");
    const fc = await call(bob, "find_context", {
      question: "does net revenue include gift card top-ups?",
    });
    expect(fc.text).toContain("Gift-card top-ups");
    await bob.close();

    // 5. attributed to the human in the audit log
    const { Database } = await import("bun:sqlite");
    const db = new Database(path.join(tmpRepo, "knowledge.db"), { readonly: true });
    const row = db
      .query("SELECT user, tool FROM audit WHERE tool = 'approval_accepted' ORDER BY id DESC")
      .get() as { user: string; tool: string } | null;
    db.close();
    expect(row?.user).toBe("boss");
  });

  it("a member can view but NOT approve (role-gated)", async () => {
    const alice = await connect("tok-alice");
    await call(alice, "report_correction", { kind: "gotcha", content: "Members must not be able to approve this" });
    await alice.close();
    const cookie = await cookieFor("viewer", "viewer-pass");
    const page = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text();
    expect(page).toContain("Members must not be able to approve this"); // can see
    expect(page).toContain("viewing only"); // told they can't act
    expect(page).not.toContain("name=\"action\" value=\"accepted\""); // no approve button
    // and a forged resolve POST from a member is refused server-side
    const r = await fetch(`${BASE}/admin/resolve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ id: "999", csrf: "x", action: "accepted" }),
      redirect: "manual",
    });
    expect([403]).toContain(r.status); // bad csrf or role — either way refused
  });

  it("an admin invites a teammate → the minted token authenticates immediately (no restart)", async () => {
    const cookie = await cookieFor("boss", "s3cret-pass");
    // admin sees the invite form; member does not (checked below)
    const teamPage = await (await fetch(`${BASE}/admin/team`, { headers: { cookie } })).text();
    expect(teamPage).toContain("Setoku — team");
    expect(teamPage).toContain('action="/admin/invite"');
    const csrf = teamPage.match(/name="csrf" value="([^"]+)"/)![1];

    // POST the invite
    const r = await fetch(`${BASE}/admin/invite`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ csrf, identity: "newhire@co.test" }),
      redirect: "manual",
    });
    expect(r.status).toBe(303); // PRG: the result shows on the redirected GET
    const page = await (await fetch(`${BASE}/admin/team`, { headers: { cookie } })).text();
    expect(page).toContain("Agent connector for newhire@co.test");
    const token = page.match(/Authorization: Bearer ([0-9a-f]{48})/)![1];

    // the brand-new token works over MCP right away, as an analyst (read + propose)
    const client = await connect(token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("find_context");
    expect(names).toContain("report_correction");
    expect(names).not.toContain("upsert_context");
    await client.close();

    // and it shows up in the team list
    const after = await (await fetch(`${BASE}/admin/team`, { headers: { cookie } })).text();
    expect(after).toContain("newhire@co.test");
  });

  it("a teammate shows 'invited' until they actually use the agent, then 'connected'", async () => {
    const cookie = await cookieFor("boss", "s3cret-pass");
    const csrf = (await (await fetch(`${BASE}/admin/team`, { headers: { cookie } })).text()).match(/name="csrf" value="([^"]+)"/)![1];
    await fetch(`${BASE}/admin/invite`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ csrf, identity: "usage@co.test" }),
      redirect: "manual",
    });
    const before = await (await fetch(`${BASE}/admin/team`, { headers: { cookie } })).text();
    const token = before.match(/Authorization: Bearer ([0-9a-f]{48})/)![1];
    // the person ROW name span (not the one-time invite/login block) → to </li>
    const rowOf = (html: string, id: string) => {
      const anchor = `text-stone-100">${id}</span>`;
      const i = html.indexOf(anchor);
      return i < 0 ? "" : html.slice(i, html.indexOf("</li>", i));
    };
    expect(rowOf(before, "usage@co.test")).toContain("invited"); // minted, not used yet

    // actually use the agent (an MCP tool call), then it reads "connected"
    const client = await connect(token);
    await call(client, "find_context", { question: "anything" });
    await client.close();
    const after = await (await fetch(`${BASE}/admin/team`, { headers: { cookie } })).text();
    expect(rowOf(after, "usage@co.test")).toContain("connected");
    expect(rowOf(after, "usage@co.test")).not.toContain("invited");
  });

  it("rotating a connector revokes the old token and issues a working new one", async () => {
    const cookie = await cookieFor("boss", "s3cret-pass");
    const grab = async () =>
      (await (await fetch(`${BASE}/admin/team`, { headers: { cookie } })).text());
    const csrf1 = (await grab()).match(/name="csrf" value="([^"]+)"/)![1];
    const inv = async (fields: Record<string, string>) => {
      const r = await fetch(`${BASE}/admin/invite`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ csrf: csrf1, ...fields }),
        redirect: "manual",
      });
      expect(r.status).toBe(303);
      return (await grab()).match(/Authorization: Bearer ([0-9a-f]{48})/)![1];
    };
    const t1 = await inv({ identity: "rot@co.test" });
    // old token works
    const c1 = await connect(t1);
    expect((await c1.listTools()).tools.length).toBeGreaterThan(0);
    await c1.close();
    // rotate → new token
    const t2 = await inv({ identity: "rot@co.test", rotate: "1" });
    expect(t2).not.toBe(t1);
    // old token is now rejected; new one works
    expect(connect(t1)).rejects.toThrow();
    const c2 = await connect(t2);
    expect((await c2.listTools()).tools.length).toBeGreaterThan(0);
    await c2.close();
  });

  it("a member cannot invite (role-gated), and a bad CSRF is refused", async () => {
    const memberCookie = await cookieFor("viewer", "viewer-pass");
    // member view: no invite form
    const mp = await (await fetch(`${BASE}/admin/team`, { headers: { cookie: memberCookie } })).text();
    expect(mp).not.toContain('action="/admin/invite"');
    expect(mp).toContain("viewing only");
    // forged invite POST from a member is refused
    const r = await fetch(`${BASE}/admin/invite`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: memberCookie },
      body: new URLSearchParams({ csrf: "x", identity: "evil@co.test" }),
      redirect: "manual",
    });
    expect(r.status).toBe(403); // bad csrf or role — either way refused
    // bad CSRF from an admin is also refused
    const adminCookie = await cookieFor("boss", "s3cret-pass");
    const r2 = await fetch(`${BASE}/admin/invite`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: adminCookie },
      body: new URLSearchParams({ csrf: "wrong", identity: "x@co.test" }),
      redirect: "manual",
    });
    expect(r2.status).toBe(403);
  });

  async function teamCsrf(cookie: string): Promise<string> {
    const page = await (await fetch(`${BASE}/admin/team`, { headers: { cookie } })).text();
    return page.match(/name="csrf" value="([^"]+)"/)![1];
  }
  function usersPost(cookie: string, csrf: string, fields: Record<string, string>) {
    return fetch(`${BASE}/admin/users`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ csrf, ...fields }),
      redirect: "manual",
    });
  }
  // POST then follow the PRG redirect; the one-time result shows on the GET.
  async function usersResult(cookie: string, csrf: string, fields: Record<string, string>): Promise<string> {
    const r = await usersPost(cookie, csrf, fields);
    expect(r.status).toBe(303);
    return (await fetch(`${BASE}/admin/team`, { headers: { cookie } })).text();
  }

  it("the last admin cannot be demoted or removed (no lockout)", async () => {
    // at this point 'boss' is the only admin; 'viewer' is a member
    const cookie = await cookieFor("boss", "s3cret-pass");
    const csrf = await teamCsrf(cookie);
    expect(await usersResult(cookie, csrf, { op: "role", username: "boss", role: "member" })).toContain("demote the last admin");
    expect(await usersResult(cookie, csrf, { op: "delete", username: "boss" })).toContain("remove the last admin");
  });

  let danaPw = "";
  it("an admin creates a web login, it can sign in, and members can't manage accounts", async () => {
    const cookie = await cookieFor("boss", "s3cret-pass");
    const csrf = await teamCsrf(cookie);
    const page = await usersResult(cookie, csrf, { op: "create", username: "dana@co.test", role: "member" });
    expect(page).toContain("login for dana@co.test");
    danaPw = page.match(/Temp password: <span class="select-all">([0-9a-f]+)<\/span>/)![1];

    // the new login works, and dana (a member) cannot manage accounts
    const danaCookie = await cookieFor("dana@co.test", danaPw);
    const denied = await usersPost(danaCookie, await teamCsrf(danaCookie), { op: "create", username: "x@co.test", role: "admin" });
    expect(denied.status).toBe(403);
  });

  it("an admin can promote a member to admin (change privilege level)", async () => {
    const cookie = await cookieFor("boss", "s3cret-pass");
    const page = await usersResult(cookie, await teamCsrf(cookie), { op: "role", username: "dana@co.test", role: "admin" });
    expect(page).toContain("dana@co.test is now admin");
    // dana re-logs-in → her new session is admin → she can now manage the team
    const danaCookie = await cookieFor("dana@co.test", danaPw);
    const okPage = await usersResult(danaCookie, await teamCsrf(danaCookie), { op: "create", username: "newbie@co.test", role: "member" });
    expect(okPage).toContain("login for newbie@co.test");
  });

  it("rejects a resolve POST with a bad CSRF token", async () => {
    const cookie = await cookieFor("boss", "s3cret-pass");
    const r = await fetch(`${BASE}/admin/resolve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ id: "1", csrf: "wrong", action: "accepted" }),
      redirect: "manual",
    });
    expect(r.status).toBe(403);
  });

  it("the knowledge browser lists curated docs and requires a session", async () => {
    // unauthenticated → login form, never the knowledge itself
    const anon = await fetch(`${BASE}/admin/knowledge`, { redirect: "manual" });
    const anonPage = await anon.text();
    expect(anonPage).toContain("sign in");
    expect(anonPage).not.toContain("Setoku — knowledge");

    // signed in → the page renders with the shared tab nav
    const cookie = await cookieFor("boss", "s3cret-pass");
    const r = await fetch(`${BASE}/admin/knowledge`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const page = await r.text();
    expect(page).toContain("Setoku — knowledge");
    expect(page).toContain('href="/admin/sources"'); // nav present
    expect(page).toContain("Curated business context");
  });

  it("the sources page shows what's connected and requires a session", async () => {
    const anon = await fetch(`${BASE}/admin/sources`, { redirect: "manual" });
    expect(await anon.text()).toContain("sign in");

    const cookie = await cookieFor("boss", "s3cret-pass");
    const r = await fetch(`${BASE}/admin/sources`, { headers: { cookie } });
    expect(r.status).toBe(200);
    const page = await r.text();
    expect(page).toContain("Setoku — sources");
    expect(page).toContain("Business database");
    expect(page).toContain("Knowledge store");
    // flat source rows with colored status (lime/amber/red) + legend
    expect(page).toContain("status-");
    expect(page).toContain("flowing");
  });

  it("a resolve POST without a session is refused", async () => {
    const r = await fetch(`${BASE}/admin/resolve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id: "1", csrf: "x", action: "accepted" }),
      redirect: "manual",
    });
    expect(r.status).toBe(401);
  });

  it("the audit log page lists actions for a signed-in admin (5.6)", async () => {
    const cookie = await cookieFor("boss", "s3cret-pass");
    const page = await (await fetch(`${BASE}/admin/audit`, { headers: { cookie } })).text();
    expect(page).toContain("audit log");
    expect(page).toContain("admin_login"); // our own login is recorded
  });

  it("escapes attacker-influenceable correction content (no stored XSS in the gate)", async () => {
    const alice = await connect("tok-alice");
    await call(alice, "report_correction", {
      kind: "other",
      content: "<script>alert('xss')</script> pwn",
    });
    await alice.close();
    const cookie = await cookieFor("boss", "s3cret-pass");
    const page = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text();
    expect(page).not.toContain("<script>alert('xss')</script>");
    expect(page).toContain("&lt;script&gt;");
  });
});

describe("installer", () => {
  it("serves a personalized install script for a valid token, 404 otherwise", async () => {
    const ok = await fetch(`${BASE}/i/tok-alice`);
    expect(ok.status).toBe(200);
    const script = await ok.text();
    expect(script).toContain(
      "claude mcp add --scope user --transport http setoku",
    );
    expect(script).toContain('TOKEN="tok-alice"');
    expect(script).toContain("alice@co.test");
    const bad = await fetch(`${BASE}/i/nope`);
    expect(bad.status).toBe(404);
  });

});

describe("healthz", () => {
  it("aggregates store, disk, and dependency pings (503 when a dep is down)", async () => {
    const r = await fetch(`${BASE}/healthz`);
    expect(r.status).toBe(503); // the planted "down" dep fails
    const body = (await r.json()) as {
      ok: boolean;
      docs: number;
      disk?: { used_pct: number };
      deps: Record<string, { ok: boolean }>;
    };
    expect(body.ok).toBe(false);
    expect(body.deps.self.ok).toBe(true);
    expect(body.deps.down.ok).toBe(false);
    expect(typeof body.docs).toBe("number");
    if (body.disk) {
      expect(body.disk.used_pct).toBeGreaterThanOrEqual(0);
      expect(body.disk.used_pct).toBeLessThanOrEqual(100);
    }
  });
});

describe("tool annotations", () => {
  it("marks read tools readOnly and write tools non-destructive (drives client auto-approve)", async () => {
    const alice = await connect("tok-alice");
    const { tools } = await alice.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    for (const n of ["find_context", "get_schema", "run_query", "list_entities", "get_metric"]) {
      expect(byName[n].readOnlyHint).toBe(true);
    }
    expect(byName["run_query"].openWorldHint).toBe(true);
    // propose path is a non-readonly, non-destructive write; the curated-write
    // tools are absent over HTTP (propose-only), so they're not asserted here
    expect(byName["report_correction"].readOnlyHint).toBe(false);
    expect(byName["report_correction"].destructiveHint).toBe(false);
    await alice.close();
  });
});
