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
    SETOKU_CURATOR_TOKENS: "tok-curator=curator@co.test",
    SETOKU_JANITOR_TOKENS: "tok-janitor=janitor@co.test",
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

  it("list_sources reports the connected data surfaces (capability discovery)", async () => {
    const alice = await connect("tok-alice");
    expect((await alice.listTools()).tools.map((t) => t.name)).toContain("list_sources");
    const r = await call(alice, "list_sources");
    expect(r.isError).toBe(false);
    expect(r.text).toContain("BUSINESS DATABASE");
    expect(r.text).toContain("public.orders"); // a fixture table
    expect(r.text).toMatch(/lake/i); // names the lake even when absent
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

  it("a teammate token written to the DB authenticates immediately, no restart (add-teammate path)", async () => {
    // Mint the way `admin-cli add-teammate` now does — a row in the RUNNING
    // gateway's knowledge.db — and confirm it authenticates on the next request
    // without bouncing the process.
    const { KnowledgeStore } = await import(
      path.join(ROOT, "plugin", "gateway", "lib", "store.ts")
    );
    const s = new KnowledgeStore(path.join(tmpRepo, "knowledge.db"));
    s.addAnalystToken("tok-dave-db", "dave@co.test", "admin-cli");
    s.db.close();

    const dave = await connect("tok-dave-db");
    const names = (await dave.listTools()).tools.map((t) => t.name);
    expect(names).toContain("find_context"); // read + propose…
    expect(names).not.toContain("upsert_context"); // …but analyst only (no write)
    await dave.close();
  });

  it("attributes each token's calls to its own identity in the shared audit log", async () => {
    const bob = await connect("tok-bob");
    await call(bob, "report_correction", {
      kind: "gotcha",
      fact:
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
      fact:
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
  /** Log in with a local account (JSON API). */
  function login(username: string, password: string): Promise<Response> {
    return fetch(`${BASE}/admin/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  }
  /** Sign in and return the session cookie + the CSRF token the SPA echoes. */
  async function session(username: string, password: string): Promise<{ cookie: string; csrf: string }> {
    const r = await login(username, password);
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const body = (await r.json()) as { csrf: string };
    return { cookie: setCookie.split(";")[0], csrf: body.csrf };
  }
  function apiGet(path: string, cookie?: string): Promise<Response> {
    return fetch(`${BASE}/admin/api/${path}`, { headers: cookie ? { cookie } : {} });
  }
  function apiPost(path: string, opts: { cookie?: string; csrf?: string; body?: unknown }): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.csrf !== undefined) headers["x-csrf-token"] = opts.csrf;
    return fetch(`${BASE}/admin/api/${path}`, { method: "POST", headers, body: JSON.stringify(opts.body ?? {}) });
  }

  it("the bare /admin link is safe to share — it serves a data-less SPA shell, and unauthenticated API reads are refused", async () => {
    // GET /admin → the static React shell: no session, no secrets, no data
    const r = await fetch(`${BASE}/admin`);
    expect(r.status).toBe(200);
    const page = await r.text();
    expect(page).toContain('id="root"');
    expect(page).toContain("/admin/app.js");
    // and no API data leaks without a session
    expect((await apiGet("session")).status).toBe(401);
    expect((await apiGet("pending")).status).toBe(401);
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
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("an admin approves a pending gotcha → it enters verified context; agents never could", async () => {
    // 1. an agent proposes (propose-only — all the agent can do)
    const alice = await connect("tok-alice");
    await call(alice, "report_correction", {
      kind: "gotcha",
      fact:
        "Gift-card top-ups post to ledger_entries with type=GC and are excluded from net revenue",
    });
    await alice.close();

    // 2. a human signs in with their ADMIN ACCOUNT (not the MCP token) and sees it
    const { cookie, csrf } = await session("boss", "s3cret-pass");
    const pending = (await (await apiGet("pending", cookie)).json()) as { id: number; content: string }[];
    const corr = pending.find((c) => c.content.includes("Gift-card top-ups"));
    expect(corr).toBeDefined();

    // 3. the human POSTs Approve — the commit happens here, outside any agent
    const post = await apiPost("resolve", {
      cookie,
      csrf,
      body: { id: corr!.id, action: "accepted", reason: "confirmed with finance" },
    });
    expect(post.status).toBe(200);
    expect(((await post.json()) as { ok: boolean }).ok).toBe(true);

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
    await call(alice, "report_correction", { kind: "gotcha", fact: "Members must not be able to approve this" });
    await alice.close();
    const { cookie, csrf } = await session("viewer", "viewer-pass");
    // a member CAN read the pending view ...
    const pending = (await (await apiGet("pending", cookie)).json()) as { content: string }[];
    expect(pending.some((c) => c.content.includes("Members must not be able to approve this"))).toBe(true);
    // ... and the session endpoint that drives the UI reports their role as member ...
    expect(((await (await apiGet("session", cookie)).json()) as { role: string }).role).toBe("member");
    // ... but a resolve POST — even with a VALID csrf — is refused on ROLE (I9)
    const r = await apiPost("resolve", { cookie, csrf, body: { id: 999, action: "accepted" } });
    expect(r.status).toBe(403);
  });

  it("an admin invites a teammate → the minted token authenticates immediately (no restart)", async () => {
    const { cookie, csrf } = await session("boss", "s3cret-pass");
    const r = await apiPost("invite", { cookie, csrf, body: { identity: "newhire@co.test" } });
    expect(r.status).toBe(200);
    const result = (await r.json()) as { ok: boolean; invite: { token: string; mcpUrl: string } };
    expect(result.ok).toBe(true);
    const token = result.invite.token;
    expect(token).toMatch(/^[0-9a-f]{48}$/);

    // the brand-new token works over MCP right away, as an analyst (read + propose)
    const client = await connect(token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("find_context");
    expect(names).toContain("report_correction");
    expect(names).not.toContain("upsert_context");
    await client.close();

    // and it shows up in the team list
    const team = (await (await apiGet("team", cookie)).json()) as { people: { identity: string }[] };
    expect(team.people.some((p) => p.identity === "newhire@co.test")).toBe(true);
  });

  it("a teammate shows 'invited' (not used) until they use the agent, then 'connected' (used)", async () => {
    const { cookie, csrf } = await session("boss", "s3cret-pass");
    const inv = await apiPost("invite", { cookie, csrf, body: { identity: "usage@co.test" } });
    const token = ((await inv.json()) as { invite: { token: string } }).invite.token;
    const rowFor = async (id: string) => {
      const team = (await (await apiGet("team", cookie)).json()) as {
        people: { identity: string; used: boolean; hasToken: boolean }[];
      };
      return team.people.find((p) => p.identity === id)!;
    };
    const before = await rowFor("usage@co.test");
    expect(before.hasToken).toBe(true);
    expect(before.used).toBe(false); // minted, not used yet

    // actually use the agent (an MCP tool call), then it reads "connected"
    const client = await connect(token);
    await call(client, "find_context", { question: "anything" });
    await client.close();
    expect((await rowFor("usage@co.test")).used).toBe(true);
  });

  it("rotating a connector revokes the old token and issues a working new one", async () => {
    const { cookie, csrf } = await session("boss", "s3cret-pass");
    const inv = async (body: Record<string, unknown>): Promise<string> => {
      const r = await apiPost("invite", { cookie, csrf, body });
      expect(r.status).toBe(200);
      return ((await r.json()) as { invite: { token: string } }).invite.token;
    };
    const t1 = await inv({ identity: "rot@co.test" });
    // old token works
    const c1 = await connect(t1);
    expect((await c1.listTools()).tools.length).toBeGreaterThan(0);
    await c1.close();
    // rotate → new token
    const t2 = await inv({ identity: "rot@co.test", rotate: true });
    expect(t2).not.toBe(t1);
    // old token is now rejected; new one works
    expect(connect(t1)).rejects.toThrow();
    const c2 = await connect(t2);
    expect((await c2.listTools()).tools.length).toBeGreaterThan(0);
    await c2.close();
  });

  it("a member cannot invite (role-gated), and a bad CSRF is refused", async () => {
    const member = await session("viewer", "viewer-pass");
    // a member is refused on ROLE even with a valid csrf
    const r = await apiPost("invite", { cookie: member.cookie, csrf: member.csrf, body: { identity: "evil@co.test" } });
    expect(r.status).toBe(403);
    // a bad CSRF from an admin is also refused
    const admin = await session("boss", "s3cret-pass");
    const r2 = await apiPost("invite", { cookie: admin.cookie, csrf: "wrong", body: { identity: "x@co.test" } });
    expect(r2.status).toBe(403);
  });

  it("the last admin cannot be demoted or removed (no lockout)", async () => {
    // at this point 'boss' is the only admin; 'viewer' is a member
    const { cookie, csrf } = await session("boss", "s3cret-pass");
    const demote = await apiPost("users", { cookie, csrf, body: { op: "role", username: "boss", role: "member" } });
    expect(demote.status).toBe(409);
    expect(((await demote.json()) as { error: string }).error).toContain("demote the last admin");
    const del = await apiPost("users", { cookie, csrf, body: { op: "delete", username: "boss" } });
    expect(del.status).toBe(409);
    expect(((await del.json()) as { error: string }).error).toContain("remove the last admin");
  });

  let danaPw = "";
  it("an admin creates a web login, it can sign in, and members can't manage accounts", async () => {
    const { cookie, csrf } = await session("boss", "s3cret-pass");
    const r = await apiPost("users", { cookie, csrf, body: { op: "create", username: "dana@co.test", role: "member" } });
    expect(r.status).toBe(200);
    const result = (await r.json()) as { flash: string; newLogin: { tempPassword: string } };
    expect(result.flash).toContain("login for dana@co.test");
    danaPw = result.newLogin.tempPassword;

    // the new login works, and dana (a member) cannot manage accounts
    const dana = await session("dana@co.test", danaPw);
    const denied = await apiPost("users", {
      cookie: dana.cookie,
      csrf: dana.csrf,
      body: { op: "create", username: "x@co.test", role: "admin" },
    });
    expect(denied.status).toBe(403);
  });

  it("an admin can promote a member to admin (change privilege level)", async () => {
    const { cookie, csrf } = await session("boss", "s3cret-pass");
    const r = await apiPost("users", { cookie, csrf, body: { op: "role", username: "dana@co.test", role: "admin" } });
    expect(((await r.json()) as { flash: string }).flash).toContain("dana@co.test is now admin");
    // dana re-logs-in → her new session is admin → she can now manage the team
    const dana = await session("dana@co.test", danaPw);
    const ok = await apiPost("users", {
      cookie: dana.cookie,
      csrf: dana.csrf,
      body: { op: "create", username: "newbie@co.test", role: "member" },
    });
    expect(((await ok.json()) as { flash: string }).flash).toContain("login for newbie@co.test");
  });

  it("rejects a resolve POST with a bad CSRF token", async () => {
    const { cookie } = await session("boss", "s3cret-pass");
    const r = await apiPost("resolve", { cookie, csrf: "wrong", body: { id: 1, action: "accepted" } });
    expect(r.status).toBe(403);
  });

  it("the knowledge endpoint lists curated docs and requires a session", async () => {
    expect((await apiGet("knowledge")).status).toBe(401); // unauthenticated → refused
    const { cookie } = await session("boss", "s3cret-pass");
    const r = await apiGet("knowledge", cookie);
    expect(r.status).toBe(200);
    const docs = (await r.json()) as { type: string }[];
    expect(Array.isArray(docs)).toBe(true);
  });

  it("the knowledge_view endpoint returns the subject-grouped view with health", async () => {
    expect((await apiGet("knowledge_view")).status).toBe(401); // session required
    const { cookie } = await session("boss", "s3cret-pass");
    const r = await apiGet("knowledge_view", cookie);
    expect(r.status).toBe(200);
    const v = (await r.json()) as {
      docs: number;
      subjects: { key: string; members: unknown[] }[];
      health: { contradictions: number; verbose: number };
    };
    expect(Array.isArray(v.subjects)).toBe(true);
    expect(v.health).toBeDefined();
    expect(typeof v.health.contradictions).toBe("number");
  });

  it("the sources endpoint shows what's connected and requires a session", async () => {
    expect((await apiGet("sources")).status).toBe(401);
    const { cookie } = await session("boss", "s3cret-pass");
    const r = await apiGet("sources", cookie);
    expect(r.status).toBe(200);
    const s = (await r.json()) as { postgres: { configured: boolean }; knowledge: { docs: number } };
    expect(s.postgres).toBeDefined();
    expect(s.knowledge).toBeDefined();
  });

  it("a resolve POST without a session is refused", async () => {
    const r = await apiPost("resolve", { csrf: "x", body: { id: 1, action: "accepted" } });
    expect(r.status).toBe(401);
  });

  it("the audit endpoint lists actions for a signed-in admin (5.6)", async () => {
    const { cookie } = await session("boss", "s3cret-pass");
    const rows = (await (await apiGet("audit", cookie)).json()) as { tool: string }[];
    expect(rows.some((r) => r.tool === "admin_login")).toBe(true); // our own login is recorded
  });

  it("serves correction content as JSON data, not interpolated HTML (no stored XSS in the gate)", async () => {
    const alice = await connect("tok-alice");
    await call(alice, "report_correction", {
      kind: "other",
      fact: "<script>alert('xss')</script> pwn",
    });
    await alice.close();
    const { cookie } = await session("boss", "s3cret-pass");
    // the gate returns content as a JSON string value (data, not markup); React
    // escapes it on render. The static shell never carries it either.
    const pending = (await (await apiGet("pending", cookie)).json()) as { content: string }[];
    expect(pending.some((c) => c.content === "<script>alert('xss')</script> pwn")).toBe(true);
    const shell = await (await fetch(`${BASE}/admin`)).text();
    expect(shell).not.toContain("<script>alert('xss')</script>");
  });

  it("an active session slides forward on use (sliding window) — without re-issuing a cookie on every response", async () => {
    const { Database } = await import("bun:sqlite");
    const { cookie } = await session("boss", "s3cret-pass");
    const sid = decodeURIComponent(cookie.split("=").slice(1).join("="));

    // a just-issued session is inside the renewal throttle → an authed read does
    // NOT re-issue the cookie (we don't Set-Cookie on every response).
    const fresh = await apiGet("session", cookie);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("set-cookie")).toBeNull();

    // age it past the throttle but keep it valid — the way a day of use leaves it.
    {
      const db = new Database(path.join(tmpRepo, "knowledge.db"));
      db.run("UPDATE sessions SET expires = ? WHERE sid = ?", [Date.now() + 60_000, sid]);
      db.close();
    }

    // now the same request slides the window forward and re-issues the cookie.
    const slid = await apiGet("session", cookie);
    expect(slid.status).toBe(200);
    const setCookie = slid.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`setoku_session=${sid}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Max-Age=1209600"); // 14 days, mirrors the server-side TTL

    // and the persisted expiry actually slid ~14 days out (not just the cookie).
    const check = new Database(path.join(tmpRepo, "knowledge.db"), { readonly: true });
    const row = check.query("SELECT expires FROM sessions WHERE sid = ?").get(sid) as { expires: number };
    check.close();
    expect(row.expires).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
  });

  // ---- temp passwords are temporary (#73) ----

  it("an admin-minted login is flagged mustChangePassword until the owner changes it; the temp password then stops working", async () => {
    const admin = await session("boss", "s3cret-pass");
    const created = await apiPost("users", {
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { op: "create", username: "temp@co.test", role: "member" },
    });
    const tempPw = ((await created.json()) as { newLogin: { tempPassword: string } }).newLogin.tempPassword;

    // login succeeds, but the response carries the forced-change flag the SPA
    // gates on — the recipient lands on the change form, not the app.
    const r = await login("temp@co.test", tempPw);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { csrf: string; mustChangePassword: boolean };
    expect(body.mustChangePassword).toBe(true);
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];

    // the session endpoint reports it too (a page reload re-enters the gate)
    const sess = (await (await apiGet("session", cookie)).json()) as { mustChangePassword: boolean };
    expect(sess.mustChangePassword).toBe(true);

    // CSRF is required, the current password is verified, and the new one has a floor
    expect((await apiPost("password", { cookie, csrf: "wrong", body: { current: tempPw, next: "my-own-password" } })).status).toBe(403);
    expect((await apiPost("password", { cookie, csrf: body.csrf, body: { current: "not-it", next: "my-own-password" } })).status).toBe(403);
    expect((await apiPost("password", { cookie, csrf: body.csrf, body: { current: tempPw, next: "short" } })).status).toBe(400);

    // a second session on the shared temp password — the "stray tab"
    const other = await session("temp@co.test", tempPw);

    // happy path: current password in hand → changed
    const ok = await apiPost("password", { cookie, csrf: body.csrf, body: { current: tempPw, next: "my-own-password" } });
    expect(ok.status).toBe(200);

    // the flag clears for the session that changed it ...
    const after = (await (await apiGet("session", cookie)).json()) as { mustChangePassword: boolean };
    expect(after.mustChangePassword).toBe(false);
    // ... the OTHER session is dead ...
    expect((await apiGet("session", other.cookie)).status).toBe(401);
    // ... the temp password stops working, and the chosen one signs in unflagged
    expect((await login("temp@co.test", tempPw)).status).toBe(401);
    const relogin = await login("temp@co.test", "my-own-password");
    expect(relogin.status).toBe(200);
    expect(((await relogin.json()) as { mustChangePassword: boolean }).mustChangePassword).toBe(false);
  });

  it("an admin password reset re-arms the forced-change gate", async () => {
    const admin = await session("boss", "s3cret-pass");
    const reset = await apiPost("users", {
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { op: "reset", username: "temp@co.test" },
    });
    expect(reset.status).toBe(200);
    const pw = ((await reset.json()) as { newLogin: { tempPassword: string } }).newLogin.tempPassword;
    const r = await login("temp@co.test", pw);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
  });

  it("a web invite's minted login is flagged; a self-set password (boss) is not", async () => {
    const admin = await session("boss", "s3cret-pass");
    const inv = await apiPost("invite", {
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { identity: "flagged@co.test" },
    });
    const nl = ((await inv.json()) as { newLogin?: { tempPassword: string } }).newLogin;
    expect(nl).toBeDefined();
    const r = await login("flagged@co.test", nl!.tempPassword);
    expect(((await r.json()) as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
    // boss bootstrapped their own password — no gate
    const boss = await login("boss", "s3cret-pass");
    expect(((await boss.json()) as { mustChangePassword: boolean }).mustChangePassword).toBe(false);
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

  it("names the connector <slug>-setoku from the box name (SETOKU_NAME wins), defaults to setoku", async () => {
    const { connectorName, slugifyName } = await import(
      path.join(ROOT, "plugin", "gateway", "lib", "config.ts")
    );
    expect(slugifyName("Camp SH!")).toBe("camp-sh");
    const prev = process.env.SETOKU_NAME;
    process.env.SETOKU_NAME = "campsh";
    expect(connectorName(tmpRepo)).toBe("campsh-setoku");
    expect(connectorName(tmpRepo, "curator")).toBe("campsh-setoku-curator");
    delete process.env.SETOKU_NAME;
    expect(connectorName(tmpRepo)).toBe("setoku"); // fixture config sets no name
    if (prev !== undefined) process.env.SETOKU_NAME = prev;
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

describe("curation cockpit capabilities (draft-only / reject-only — the membrane)", () => {
  async function toolNames(token: string): Promise<string[]> {
    const c = await connect(token);
    const names = (await c.listTools()).tools.map((t) => t.name);
    await c.close();
    return names;
  }

  it("the janitor token holds draft + reject ONLY — never upsert_context or any accept path", async () => {
    const names = await toolNames("tok-janitor");
    expect(names).toContain("draft_correction");
    expect(names).toContain("reject_correction");
    // the load-bearing absence: no tool that COMMITS curated knowledge
    expect(names).not.toContain("upsert_context");
    expect(names).not.toContain("resolve_correction");
  });

  it("the analyst token has neither draft nor reject (propose-only stays the floor)", async () => {
    const names = await toolNames("tok-alice");
    expect(names).not.toContain("draft_correction");
    expect(names).not.toContain("reject_correction");
    expect(names).not.toContain("upsert_context");
  });

  it("the curator commits directly (upsert + resolve) and does NOT hold the janitor tools", async () => {
    const names = await toolNames("tok-curator");
    expect(names).toContain("upsert_context");
    expect(names).toContain("resolve_correction");
    expect(names).not.toContain("draft_correction");
    expect(names).not.toContain("reject_correction");
  });

  it("draft_correction attaches a draft + flags but commits NO curated doc", async () => {
    const alice = await connect("tok-alice");
    await call(alice, "report_correction", {
      kind: "metric",
      fact: "revenue must net out refunds",
      relates_to: "revenue",
    });
    await alice.close();

    const { Database } = await import("bun:sqlite");
    const db = new Database(path.join(tmpRepo, "knowledge.db"));
    const id = (db.query("SELECT id FROM corrections WHERE fact LIKE 'revenue must net%' ORDER BY id DESC").get() as { id: number }).id;
    const docsBefore = (db.query("SELECT count(*) AS n FROM docs").get() as { n: number }).n;
    db.close();

    const janitor = await connect("tok-janitor");
    const r = await call(janitor, "draft_correction", {
      id,
      type: "metric",
      name: "revenue",
      body: "SELECT sum(total_cents) - sum(refund_cents) FROM orders",
      flags: ["lint"],
    });
    await janitor.close();
    expect(r.isError).toBe(false);

    const db2 = new Database(path.join(tmpRepo, "knowledge.db"), { readonly: true });
    const row = db2.query("SELECT status, draft_body, flags, drafted_by FROM corrections WHERE id = ?").get(id) as {
      status: string;
      draft_body: string;
      flags: string;
      drafted_by: string;
    };
    const docsAfter = (db2.query("SELECT count(*) AS n FROM docs").get() as { n: number }).n;
    db2.close();
    expect(row.status).toBe("pending"); // drafting never resolves
    expect(row.draft_body).toContain("refund_cents");
    expect(JSON.parse(row.flags)).toEqual(["lint"]);
    expect(row.drafted_by).toBe("janitor@co.test");
    expect(docsAfter).toBe(docsBefore); // a draft commits nothing
  });

  it("reject_correction soft-rejects with rejected_by_bot set (reversible, audited)", async () => {
    const alice = await connect("tok-alice");
    await call(alice, "report_correction", { kind: "gotcha", fact: "objectively-broken proposal to auto-reject" });
    await alice.close();

    const { Database } = await import("bun:sqlite");
    const db = new Database(path.join(tmpRepo, "knowledge.db"));
    const id = (db.query("SELECT id FROM corrections WHERE fact LIKE 'objectively-broken%' ORDER BY id DESC").get() as { id: number }).id;
    db.close();

    const janitor = await connect("tok-janitor");
    const r = await call(janitor, "reject_correction", { id, reason: "drafted SQL references a denied table" });
    await janitor.close();
    expect(r.isError).toBe(false);

    const db2 = new Database(path.join(tmpRepo, "knowledge.db"), { readonly: true });
    const row = db2.query("SELECT status, rejected_by_bot, reject_reason FROM corrections WHERE id = ?").get(id) as {
      status: string;
      rejected_by_bot: number;
      reject_reason: string;
    };
    db2.close();
    expect(row.status).toBe("rejected");
    expect(row.rejected_by_bot).toBe(1);
    expect(row.reject_reason).toContain("denied table");
  });

  it("a janitor calling upsert_context fails and commits nothing (it isn't registered — the membrane)", async () => {
    const { Database } = await import("bun:sqlite");
    const before = (() => {
      const db = new Database(path.join(tmpRepo, "knowledge.db"), { readonly: true });
      const n = (db.query("SELECT count(*) AS n FROM docs WHERE name = 'membrane-probe'").get() as { n: number }).n;
      db.close();
      return n;
    })();

    const janitor = await connect("tok-janitor");
    const r = await call(janitor, "upsert_context", { type: "gotcha", name: "membrane-probe", body: "should never commit" });
    await janitor.close();
    expect(r.isError).toBe(true); // unknown tool → error result, not a commit

    const db = new Database(path.join(tmpRepo, "knowledge.db"), { readonly: true });
    const after = (db.query("SELECT count(*) AS n FROM docs WHERE name = 'membrane-probe'").get() as { n: number }).n;
    db.close();
    expect(after).toBe(before); // nothing was written
  });
});

describe("live apps (end-to-end render path)", () => {
  async function session(username: string, password: string): Promise<{ cookie: string; csrf: string }> {
    const r = await fetch(`${BASE}/admin/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const setCookie = r.headers.get("set-cookie") ?? "";
    const body = (await r.json()) as { csrf: string };
    return { cookie: setCookie.split(";")[0], csrf: body.csrf };
  }
  const countIn = (html: string): number | null => {
    // count(*) comes back as a bigint → pg serializes it as a quoted string.
    const m = html.match(/"n":"?(\d+)"?/);
    return m ? Number(m[1]) : null;
  };

  it("publishes (analyst), renders fresh data, reflects DB changes, promotes to public, then archives", async () => {
    // 1. An analyst publishes a live app; the panel is dry-run at publish.
    const alice = await connect("tok-alice");
    const pub = await call(alice, "publish_app", {
      title: "Paid orders",
      html: '<div id="n"></div><script>document.getElementById("n").textContent=window.__SETOKU__.panels.paid.rows[0].n</script>',
      panels: [
        {
          key: "paid",
          title: "Paid order count",
          sql: "SELECT count(*) AS n FROM orders WHERE status = 'paid'",
          dialect: "postgres",
          metricId: "revenue",
        },
      ],
      refreshSeconds: 30,
    });
    expect(pub.isError).toBe(false);
    const id = (pub.text.match(/\/admin\/p\/([0-9a-f]+)/) ?? [])[1];
    expect(id).toBeTruthy();
    await alice.close();

    // 2. An admin reads the provenance metadata: SQL is present on the team surface,
    //    the metric link resolved, the author is named. (app_data is metadata-only
    //    now — the live row counts come from the frame echo, asserted via the frame
    //    render below — so it no longer runs the panels itself.)
    const boss = await session("boss", "s3cret-pass");
    const dd = (await (
      await fetch(`${BASE}/admin/api/app_data?id=${id}`, { headers: { cookie: boss.cookie } })
    ).json()) as { createdBy?: string; updatedAt?: string | null; panels: { sql?: string; metricSummary: string | null }[] };
    expect(dd.panels[0].sql).toContain("count(*)"); // team drawer shows the query it runs
    expect(dd.panels[0].metricSummary).toBeTruthy(); // "revenue" metric summary resolved
    expect(dd.createdBy).toBeTruthy(); // and the author
    expect(dd.updatedAt).toBeTruthy(); // freshness stamp read from the seeded cache

    // 3. The sandboxed frame carries the injected data + the no-network CSP.
    const frameRes = await fetch(`${BASE}/admin/frame/${id}`, { headers: { cookie: boss.cookie } });
    expect(frameRes.headers.get("content-security-policy")).toContain("default-src 'none'");
    const frame = await frameRes.text();
    expect(frame).toContain("window.__SETOKU__");
    const n0 = countIn(frame);
    expect(n0).toBeGreaterThan(0);

    // 4. Mutate the DB, force a refresh → the rendered data reflects the change
    //    (this is the whole point: the data is live, not frozen at publish). The
    //    force lives on the frame now (?force=1), author/admin-gated, so the iframe
    //    itself bypasses the cache and re-runs the query.
    const pg = new PgClient({ host: PG_HOST, database: DB_NAME });
    await pg.connect();
    await pg.query("INSERT INTO orders (customer_id, status, total_cents) VALUES (1, 'paid', 100)");
    await pg.end();
    const frame2 = await (await fetch(`${BASE}/admin/frame/${id}?force=1`, { headers: { cookie: boss.cookie } })).text();
    expect(countIn(frame2)).toBe((n0 ?? 0) + 1);

    // 5. Public surface is blocked until a human promotes it (membrane).
    expect((await fetch(`${BASE}/p/${id}`)).status).toBe(404);
    const promote = await fetch(`${BASE}/admin/api/set_visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: boss.cookie, "x-csrf-token": boss.csrf },
      body: JSON.stringify({ id, visibility: "public" }),
    });
    expect(promote.status).toBe(200);

    // 6. Public /data exposes NO calculations at all — just freshness meta (no
    //    panels, no SQL, no metrics, no author). The public page is the trusted
    //    shell that frames the app; the drawer is team-only.
    const pdata = (await (await fetch(`${BASE}/p/${id}/data`)).json()) as {
      createdBy?: string;
      panels?: unknown;
      updatedAt?: string;
      refreshSeconds?: number;
    };
    expect(pdata.panels).toBeUndefined(); // no per-panel calc info publicly
    expect(pdata.createdBy).toBeUndefined(); // author identity not leaked publicly
    expect(pdata.refreshSeconds).toBeDefined(); // freshness meta is fine
    expect(pdata.updatedAt).toBeDefined();
    const pframe = await (await fetch(`${BASE}/p/${id}/frame`)).text();
    expect(pframe).toContain("window.__SETOKU__");
    const shell = await (await fetch(`${BASE}/p/${id}`)).text();
    expect(shell).toContain("<iframe");
    expect(shell).toContain(`/p/${id}/frame`);

    // 6b. A logged-OUT hit on /admin/p/<id> for a public app bounces to the
    //     public view rather than the login wall.
    const bounce = await fetch(`${BASE}/admin/p/${id}`, { redirect: "manual" });
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toBe(`/p/${id}`);

    // 7. Archiving 404s the link everywhere (and drops cached data).
    const arch = await fetch(`${BASE}/admin/api/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: boss.cookie, "x-csrf-token": boss.csrf },
      body: JSON.stringify({ id }),
    });
    expect(arch.status).toBe(200);
    expect((await fetch(`${BASE}/p/${id}`)).status).toBe(404);
    expect((await fetch(`${BASE}/admin/frame/${id}`, { headers: { cookie: boss.cookie } })).status).toBe(404);

    // 8. Unarchive restores it as TEAM-ONLY — a previously-public link must not
    //    silently come back; re-going-public is a fresh admin action (I9).
    const un = await fetch(`${BASE}/admin/api/unarchive`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: boss.cookie, "x-csrf-token": boss.csrf },
      body: JSON.stringify({ id }),
    });
    expect(un.status).toBe(200);
    expect((await fetch(`${BASE}/p/${id}`)).status).toBe(404); // public link NOT restored
    expect((await fetch(`${BASE}/admin/frame/${id}`, { headers: { cookie: boss.cookie } })).status).toBe(200); // active again (team)
  }, 20_000);

  it("making an app public is admin-only; a member cannot promote", async () => {
    const alice = await connect("tok-alice");
    const pub = await call(alice, "publish_app", {
      title: "Member test",
      html: "<div></div>",
      panels: [{ key: "p", sql: "SELECT count(*) AS n FROM orders", dialect: "postgres" }],
    });
    const id = (pub.text.match(/\/admin\/p\/([0-9a-f]+)/) ?? [])[1];
    await alice.close();
    // a MEMBER session cannot make it public
    const viewer = await session("viewer", "viewer-pass");
    const denied = await fetch(`${BASE}/admin/api/set_visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: viewer.cookie, "x-csrf-token": viewer.csrf },
      body: JSON.stringify({ id, visibility: "public" }),
    });
    expect(denied.status).toBe(403);
    expect((await fetch(`${BASE}/p/${id}`)).status).toBe(404); // still team-only
    // an ADMIN can
    const boss = await session("boss", "s3cret-pass");
    const okp = await fetch(`${BASE}/admin/api/set_visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: boss.cookie, "x-csrf-token": boss.csrf },
      body: JSON.stringify({ id, visibility: "public" }),
    });
    expect(okp.status).toBe(200);
    expect((await fetch(`${BASE}/p/${id}`)).status).toBe(200);
  }, 20_000);

  it("clamps an absurd refresh, strips SQL from the list, and 404s /data for a panel-less app", async () => {
    const alice = await connect("tok-alice");
    // huge refreshSeconds must be clamped (a 'live' link that never refreshes isn't)
    const big = await call(alice, "publish_app", {
      title: "clamp test",
      html: "<div id=x></div>",
      refreshSeconds: 10_000_000,
      panels: [{ key: "p", sql: "SELECT count(*) AS n FROM orders", dialect: "postgres" }],
    });
    const bigId = (big.text.match(/\/admin\/p\/([0-9a-f]+)/) ?? [])[1];
    // a zero-panel fragment app (state-only / presentational — no live data)
    const stateOnly = await call(alice, "publish_app", { title: "state-only", html: "<div id=todo></div>" });
    const soId = (stateOnly.text.match(/\/admin\/p\/([0-9a-f]+)/) ?? [])[1];
    await alice.close();

    const boss = await session("boss", "s3cret-pass");

    // #9 clamp: 10M seconds → MAX_REFRESH_SECONDS (86400)
    const dd = (await (
      await fetch(`${BASE}/admin/api/app_data?id=${bigId}`, { headers: { cookie: boss.cookie } })
    ).json()) as { refreshSeconds: number };
    expect(dd.refreshSeconds).toBe(86400);

    // #11: the list endpoint must NOT broadcast panel SQL to members
    const list = (await (
      await fetch(`${BASE}/admin/api/published`, { headers: { cookie: boss.cookie } })
    ).json()) as { id: string; panels: { sql: string }[] | null }[];
    const row = list.find((r) => r.id === bigId)!;
    expect(row.panels?.length).toBe(1); // count still available for the UI
    expect(row.panels?.[0].sql).toBe(""); // but SQL stripped

    // #7: a panel-less app renders via the runtime shell (/p + /frame both serve);
    // only /data 404s, since the freshness poll is meaningless with no panels.
    await fetch(`${BASE}/admin/api/set_visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: boss.cookie, "x-csrf-token": boss.csrf },
      body: JSON.stringify({ id: soId, visibility: "public" }),
    });
    expect((await fetch(`${BASE}/p/${soId}`)).status).toBe(200);
    expect((await fetch(`${BASE}/p/${soId}/frame`)).status).toBe(200);
    expect((await fetch(`${BASE}/p/${soId}/data`)).status).toBe(404);
  }, 20_000);

  it("update_app is author-gated, edits in place, injects the chart runtime, and reverts public on panel change", async () => {
    const alice = await connect("tok-alice");
    const pub = await call(alice, "publish_app", {
      title: "Alice board",
      html: "<div id=x></div>",
      panels: [{ key: "a", sql: "SELECT count(*) AS n FROM orders", dialect: "postgres" }],
    });
    const id = (pub.text.match(/\/admin\/p\/([0-9a-f]+)/) ?? [])[1];
    await alice.close();

    // a different identity cannot edit it
    const bob = await connect("tok-bob");
    const denied = await call(bob, "update_app", { id, title: "hax" });
    expect(denied.isError).toBe(true);
    expect(denied.text.toLowerCase()).toContain("only the author");
    await bob.close();

    // admin promotes it to public
    const boss = await session("boss", "s3cret-pass");
    await fetch(`${BASE}/admin/api/set_visibility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: boss.cookie, "x-csrf-token": boss.csrf },
      body: JSON.stringify({ id, visibility: "public" }),
    });
    expect((await fetch(`${BASE}/p/${id}`)).status).toBe(200);

    // the author edits PANELS → reverts to team-only (re-approval needed)
    const alice2 = await connect("tok-alice");
    const upd = await call(alice2, "update_app", {
      id,
      panels: [{ key: "a", sql: "SELECT count(*) AS n FROM orders WHERE status='paid'", dialect: "postgres" }],
    });
    expect(upd.isError).toBe(false);
    expect(upd.text.toLowerCase()).toContain("reverted to team");
    await alice2.close();
    expect((await fetch(`${BASE}/p/${id}`)).status).toBe(404); // public link gone

    // the team frame serves the new code, with the chart runtime injected
    const frame = await (await fetch(`${BASE}/admin/frame/${id}`, { headers: { cookie: boss.cookie } })).text();
    expect(frame).toContain("window.__SETOKU__");
    expect(frame).toContain("window.Setoku"); // tested chart helpers present
  }, 20_000);
});
