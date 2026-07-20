// SPDX-License-Identifier: Apache-2.0
/**
 * Gmail Connect (OAuth) admin surface: the /admin/api endpoints that mint and
 * manage per-mailbox refresh tokens. Verifies status, the consent-redirect it
 * builds, the admin-only gating (I9 — connecting a source is an authority
 * change), and the disconnect round-trip against the gateway-owned secrets file
 * the gmail-poller reads. The Google token EXCHANGE (the callback) hits Google
 * and isn't driven here; its file-write contract is covered by pre-writing the
 * secrets file the way the callback does and asserting status + disconnect.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnGateway, waitHealthy, FIXTURES } from "./lib/gateway";
import { startFakeLake, type FakeLake } from "./lib/fakelake";
import { KnowledgeStore } from "../plugin/gateway/lib/store";
import { hashPassword } from "../plugin/gateway/lib/accounts";

const PORT = 38773;
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLIC_URL = "https://box.test";

let tmpRepo: string;
let tokensFile: string;
let proc: Subprocess;
let lake: FakeLake;

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

describe("Gmail Connect admin surface", () => {
  beforeAll(async () => {
    lake = startFakeLake(() => ({ rows: [] }));
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-gmail-"));
    tokensFile = path.join(tmpRepo, "gmail-tokens.json");
    fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), { recursive: true });
    {
      const s = new KnowledgeStore(path.join(tmpRepo, "knowledge.db"));
      s.createAccount({ username: "boss@co.test", pwhash: await hashPassword("s3cret-pass"), role: "admin" });
      s.createAccount({ username: "member@co.test", pwhash: await hashPassword("member-pass"), role: "member" });
      s.db.close();
    }
    proc = spawnGateway({
      SETOKU_PROJECT_DIR: tmpRepo,
      SETOKU_DB_PATH: path.join(tmpRepo, "knowledge.db"),
      SETOKU_LAKE_URL: lake.url,
      SETOKU_HTTP_PORT: String(PORT),
      SETOKU_PUBLIC_URL: PUBLIC_URL,
      GMAIL_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GMAIL_CLIENT_SECRET: "test-secret",
      GMAIL_TOKENS_FILE: tokensFile,
    });
    await waitHealthy(BASE);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    lake?.stop();
    if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("status: client configured, correct redirect URI, no mailboxes yet", async () => {
    const { cookie } = await session("boss@co.test", "s3cret-pass");
    const r = await fetch(`${BASE}/admin/api/gmail_status`, { headers: { cookie } });
    expect(r.ok).toBe(true);
    const s = (await r.json()) as { clientConfigured: boolean; redirectUri: string; mailboxes: unknown[] };
    expect(s.clientConfigured).toBe(true);
    expect(s.redirectUri).toBe(`${PUBLIC_URL}/admin/api/gmail/oauth/callback`);
    expect(s.mailboxes).toEqual([]);
  });

  it("start: 302 to Google consent with the right scope, redirect_uri, and a state nonce", async () => {
    const { cookie } = await session("boss@co.test", "s3cret-pass");
    const r = await fetch(`${BASE}/admin/api/gmail/oauth/start`, { headers: { cookie }, redirect: "manual" });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(loc.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/admin/api/gmail/oauth/callback`);
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect((loc.searchParams.get("state") ?? "").length).toBeGreaterThan(16);
  });

  it("status reflects a mailbox the callback would have written, and disconnect removes it", async () => {
    const { cookie, csrf } = await session("boss@co.test", "s3cret-pass");
    // simulate the callback's write — the exact shape the gmail-poller reads
    fs.writeFileSync(
      tokensFile,
      JSON.stringify({
        accounts: [
          { email: "peter@campsh.com", refresh_token: "1//refresh-abc", connected_at: "2026-07-16T00:00:00.000Z", connected_by: "boss@co.test" },
        ],
      }),
    );
    const s1 = (await (await fetch(`${BASE}/admin/api/gmail_status`, { headers: { cookie } })).json()) as {
      mailboxes: { email: string; connectedAt: string; connectedBy: string }[];
    };
    expect(s1.mailboxes).toEqual([{ email: "peter@campsh.com", connectedAt: "2026-07-16T00:00:00.000Z", connectedBy: "boss@co.test" }]);

    const d = await fetch(`${BASE}/admin/api/gmail_disconnect`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ email: "peter@campsh.com" }),
    });
    expect(d.ok).toBe(true);
    // the file (what the poller reads) no longer carries the token
    const onDisk = JSON.parse(fs.readFileSync(tokensFile, "utf8")) as { accounts: unknown[] };
    expect(onDisk.accounts).toEqual([]);
  });

  it("disconnect refuses a bad CSRF token", async () => {
    const { cookie } = await session("boss@co.test", "s3cret-pass");
    const r = await fetch(`${BASE}/admin/api/gmail_disconnect`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": "wrong" },
      body: JSON.stringify({ email: "x@y.z" }),
    });
    expect(r.status).toBe(403);
  });

  it("callback is reachable with NO session cookie (cross-site return), auth by state", async () => {
    // Mirrors Google's cross-site redirect: SameSite=Strict drops the session
    // cookie, so there's no session on this request. A bad/missing state must NOT
    // 401 "not signed in" (the bug) — it must reach the handler and redirect back
    // to /sources with a flash.
    const r = await fetch(`${BASE}/admin/api/gmail/oauth/callback?state=bogus&code=x`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toContain("/sources?flash=");
  });

  it("members can't see or start Gmail connection (admin-only, I9)", async () => {
    const { cookie } = await session("member@co.test", "member-pass");
    expect((await fetch(`${BASE}/admin/api/gmail_status`, { headers: { cookie } })).status).toBe(403);
    const start = await fetch(`${BASE}/admin/api/gmail/oauth/start`, { headers: { cookie }, redirect: "manual" });
    expect(start.status).toBe(403);
  });
});
